import { MailFailure, leaseMs, maxAttempts, retryDelay, retryWindowMs } from "./reliability";
import type { OutgoingMail } from "../providers/mail";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "../db";
import {
  activityLogs,
  attachments,
  customers,
  inboundMailEvents,
  messages,
  outboundMailJobs,
  tickets,
} from "../db/schema";
import { base64Url } from "../lib/crypto";
import { newId, normalizeSearch } from "../lib/id";
import { PostalMimeIncomingProvider } from "../providers/mail";
import { refreshTicketSearch } from "../search/index";
import { selectOutgoingProvider } from "./system";
import type { AppBindings } from "../types";

const maximumRawMailSize = 25 * 1024 * 1024;
const maximumAttachmentSize = 15 * 1024 * 1024;
const maximumThreadReferences = 20;
const safeMailTypes = new Set([
  "application/pdf",
  "application/zip",
  "application/json",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type InboundPayload =
  | { raw: ArrayBuffer; from?: string; to?: string }
  | { eventId: string; stagingObjectKey: string; from?: string; to?: string };

export async function processInboundMail(env: AppBindings, payload: InboundPayload) {
  const staged = "stagingObjectKey" in payload;
  const eventId = staged ? payload.eventId : newId("ime");
  const db = createDb(env.DB);
  const claimTime = Date.now();
  if (!staged)
    await env.DB.prepare(
      "INSERT INTO inbound_mail_events (id, staging_object_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(eventId, `test://${eventId}`, claimTime, claimTime)
      .run();
  const claim = await env.DB.prepare(
    "UPDATE inbound_mail_events SET attempts = attempts + 1, status = 'processing', lease_until = ?, updated_at = ? WHERE id = ? AND status <> 'completed' AND terminal_reason IS NULL AND attempts < 6 AND lease_until <= ? AND next_attempt_at <= ? RETURNING attempts, envelope_to AS envelopeTo, envelope_from AS envelopeFrom",
  )
    .bind(claimTime + leaseMs, claimTime, eventId, claimTime, claimTime)
    .first<{ attempts: number; envelopeTo: string | null; envelopeFrom: string | null }>();
  if (!claim) return;
  const attempts = claim.attempts;
  let envelopeTo = claim.envelopeTo || payload.to;
  try {
    // Reading the staged object sits inside the try so a missing or oversized
    // payload lands in the catch and marks the event failed with the reason.
    let raw: ArrayBuffer;
    if (staged) {
      const object = await env.ATTACHMENTS.get(payload.stagingObjectKey);
      if (!object) {
        const event = await env.DB.prepare("SELECT status FROM inbound_mail_events WHERE id = ?")
          .bind(eventId)
          .first<{ status: string }>();
        if (event?.status === "completed") return;
        throw new Error("The staged inbound email is missing.");
      }
      if (object.size > maximumRawMailSize) throw new Error("Inbound email exceeds the 25 MB processing limit.");
      envelopeTo ||= object.customMetadata?.to;
      raw = await object.arrayBuffer();
    } else {
      if (payload.raw.byteLength > maximumRawMailSize)
        throw new Error("Inbound email exceeds the 25 MB processing limit.");
      raw = payload.raw;
    }

    const mail = await new PostalMimeIncomingProvider().parse(raw);
    mail.providerMessageId ||= `<${eventId}@resolvehq.invalid>`;
    const recipient = (envelopeTo || mail.to || "").toLowerCase();
    const inbox = await resolveInbox(env.DB, recipient);
    if (!inbox) throw new MailFailure("No ResolveHQ inbox is configured for this delivery.", true, "inbox_missing");
    const organizationId = inbox.organizationId;
    const now = new Date();
    const duplicateEvent = await env.DB.prepare(
      "SELECT id, status, message_id AS messageId FROM inbound_mail_events WHERE inbox_id = ? AND provider_message_id = ? LIMIT 1",
    )
      .bind(inbox.id, mail.providerMessageId)
      .first<{ id: string; status: string; messageId: string }>();
    if (duplicateEvent?.status === "completed") {
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'completed', message_id = ?, lease_until = 0, updated_at = ? WHERE id = ?",
      )
        .bind(duplicateEvent.messageId, Date.now(), eventId)
        .run();
      if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
      return;
    }

    if (duplicateEvent && duplicateEvent.id !== eventId) {
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'completed', terminal_reason = 'duplicate_event', lease_until = 0, updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), eventId)
        .run();
      if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
      return;
    }
    // The unique inbox/provider index arbitrates concurrent canonical deliveries.
    try {
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET inbox_id = ?, organization_id = ?, provider_message_id = ?, envelope_to = ?, last_error = NULL WHERE id = ?",
      )
        .bind(inbox.id, organizationId, mail.providerMessageId, recipient, eventId)
        .run();
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'completed', terminal_reason = 'duplicate_event', lease_until = 0 WHERE id = ?",
      )
        .bind(eventId)
        .run();
      if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
      return;
    }

    const existing = await env.DB.prepare(
      "SELECT m.id AS messageId, m.created_at AS createdAt, m.ticket_id AS ticketId, t.number, t.subject, t.customer_id AS customerId FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id WHERE m.organization_id = ? AND m.provider_message_id = ? LIMIT 1",
    )
      .bind(organizationId, mail.providerMessageId)
      .first<ExistingMessage>();

    let customer = await db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, organizationId), eq(customers.email, mail.from.email)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!customer) {
      const customerId = newId("cus");
      await db.insert(customers).values({
        id: customerId,
        organizationId,
        name: mail.from.name || mail.from.email.split("@")[0],
        email: mail.from.email,
        normalizedSearch: normalizeSearch(mail.from.name, mail.from.email),
        lastContactedAt: now,
      });
      customer = await db
        .select()
        .from(customers)
        .where(and(eq(customers.organizationId, organizationId), eq(customers.id, customerId)))
        .limit(1)
        .then((rows) => rows[0]);
    }
    if (!customer) throw new Error("Could not resolve inbound customer.");

    let ticket: TicketReference | undefined = existing
      ? {
          id: existing.ticketId,
          number: existing.number,
          subject: existing.subject,
          customerId: existing.customerId,
        }
      : undefined;

    // A visible ticket number is not an authentication mechanism. Replies attach
    // through RFC message identifiers first, and the subject number is only a
    // fallback; both paths must match the same inbox and the same customer.
    // Long threads accumulate References oldest-first; cap the identifiers so
    // the statement stays inside D1's bound-parameter limit while keeping the
    // In-Reply-To parent and the most recent ancestors.
    const uniqueReferences = [...new Set(mail.references)];
    const references =
      uniqueReferences.length > maximumThreadReferences
        ? [...new Set([uniqueReferences[0], ...uniqueReferences.slice(-(maximumThreadReferences - 1))])]
        : uniqueReferences;
    if (!ticket && references.length) {
      const placeholders = references.map(() => "?").join(",");
      ticket =
        (await env.DB.prepare(
          `SELECT t.id, t.number, t.subject, t.customer_id AS customerId FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE m.organization_id = ? AND t.inbox_id = ? AND c.email = ? AND (m.rfc_message_id IN (${placeholders}) OR m.provider_message_id IN (${placeholders})) ORDER BY m.created_at DESC LIMIT 1`,
        )
          .bind(organizationId, inbox.id, mail.from.email, ...references, ...references)
          .first<TicketReference>()) ?? undefined;
    }
    if (!ticket) {
      const numberMatch = /\[#(\d{1,12})\]/.exec(mail.subject);
      if (numberMatch) {
        ticket =
          (await env.DB.prepare(
            "SELECT t.id, t.number, t.subject, t.customer_id AS customerId FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? AND t.inbox_id = ? AND t.number = ? AND c.email = ? LIMIT 1",
          )
            .bind(organizationId, inbox.id, Number(numberMatch[1]), mail.from.email)
            .first<TicketReference>()) ?? undefined;
      }
    }

    const newMessageId = existing?.messageId ?? newId("msg");
    const ticketWrites: Parameters<typeof db.batch>[0][number][] = [];
    if (!ticket) {
      const numberRow = await env.DB.prepare(
        "UPDATE organizations SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ? RETURNING next_ticket_number - 1 AS number",
      )
        .bind(now.getTime(), organizationId)
        .first<{ number: number }>();
      if (!numberRow) throw new Error("Inbound workspace no longer exists.");
      ticket = { id: newId("tkt"), number: numberRow.number, subject: mail.subject, customerId: customer.id };
      ticketWrites.push(
        db.insert(tickets).values({
          id: ticket.id,
          organizationId,
          inboxId: inbox.id,
          number: ticket.number,
          customerId: customer.id,
          subject: ticket.subject,
          status: "open",
          priority: "normal",
          normalizedSearch: normalizeSearch(String(ticket.number), ticket.subject, customer.name, customer.email),
          lastReplyAt: now,
          lastCustomerReplyAt: now,
          lastMessagePreview: preview(mail.text),
        }),
      );
    }

    if (ticketWrites.length)
      ticketWrites.push(
        db.insert(activityLogs).values({
          id: newId("act"),
          organizationId,
          ticketId: ticket.id,
          eventType: "ticket.created_from_email",
          entityType: "ticket",
          entityId: ticket.id,
          metadata: {},
        }),
      );

    const messageId = newMessageId;
    if (!existing) {
      await db.batch([
        ...ticketWrites,
        db.insert(messages).values({
          id: messageId,
          organizationId,
          ticketId: ticket.id,
          authorType: "customer",
          authorCustomerId: customer.id,
          kind: "message",
          bodyText: mail.text,
          normalizedSearch: normalizeSearch(mail.text),
          providerMessageId: mail.providerMessageId,
          rfcMessageId: mail.providerMessageId,
          deliveryStatus: "received",
          createdAt: now,
        }),
        db
          .update(tickets)
          .set({
            status: "open",
            resolvedAt: null,
            closedAt: null,
            waitingSince: null,
            updatedAt: now,
            lastReplyAt: now,
            lastCustomerReplyAt: now,
            lastMessagePreview: preview(mail.text),
            messageCount: sql`${tickets.messageCount} + 1`,
            version: sql`${tickets.version} + 1`,
          })
          .where(and(eq(tickets.organizationId, organizationId), eq(tickets.id, ticket.id))),
        db.update(inboundMailEvents).set({ messageId }).where(eq(inboundMailEvents.id, eventId)),
      ] as unknown as Parameters<typeof db.batch>[0]);
      await refreshTicketSearch(env.DB, organizationId, ticket.id);
    } else {
      // Reconcile the denormalized ticket state in case a previous delivery
      // stopped after the unique message insert but before the ticket update.
      await env.DB.prepare(
        "UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL, waiting_since = NULL, last_reply_at = max(coalesce(last_reply_at, 0), ?), last_customer_reply_at = max(coalesce(last_customer_reply_at, 0), ?), last_message_preview = ?, message_count = (SELECT count(*) FROM messages WHERE organization_id = ? AND ticket_id = ?) WHERE organization_id = ? AND id = ? AND coalesce(last_customer_reply_at, 0) < ?",
      )
        .bind(
          existing.createdAt,
          existing.createdAt,
          preview(mail.text),
          organizationId,
          ticket.id,
          organizationId,
          ticket.id,
          existing.createdAt,
        )
        .run();
      await refreshTicketSearch(env.DB, organizationId, ticket.id);
    }
    await db
      .update(customers)
      .set({
        lastContactedAt: sql`max(coalesce(${customers.lastContactedAt}, 0), ${existing?.createdAt ?? now.getTime()})`,
        updatedAt: now,
      })
      .where(and(eq(customers.organizationId, organizationId), eq(customers.id, customer.id)));

    const cursor = await env.DB.prepare("SELECT attachment_cursor AS cursor FROM inbound_mail_events WHERE id = ?")
      .bind(eventId)
      .first<{ cursor: number }>();
    const startCursor = cursor?.cursor ?? 0;
    const endCursor = Math.min(mail.attachments.length, startCursor + 5);
    for (let index = startCursor; index < endCursor; index += 1) {
      const file = mail.attachments[index];
      if (
        file.body.byteLength > 0 &&
        file.body.byteLength <= maximumAttachmentSize &&
        safeMailTypes.has(file.contentType) &&
        matchesSignature(new Uint8Array(file.body), file.contentType)
      ) {
        const id = `att_${eventId}_${index}`;
        const objectKey = `${organizationId}/mail/${eventId}/${index}`;
        const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", file.body)));
        await env.ATTACHMENTS.put(objectKey, file.body, {
          httpMetadata: { contentType: file.contentType },
          customMetadata: { attachmentId: id },
        });
        await db
          .insert(attachments)
          .values({
            id,
            organizationId,
            ticketId: ticket.id,
            messageId,
            objectKey,
            filename: safeFilename(file.filename),
            contentType: file.contentType,
            size: file.body.byteLength,
            checksum,
          })
          .onConflictDoNothing();
      }
      await db
        .update(inboundMailEvents)
        .set({ attachmentCursor: index + 1, updatedAt: new Date() })
        .where(eq(inboundMailEvents.id, eventId));
    }

    if (endCursor < mail.attachments.length) {
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'staged', attempts = attempts - 1, lease_until = 0, dispatch_until = 0, next_attempt_at = 0, updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), eventId)
        .run();
      return;
    }
    await db
      .update(inboundMailEvents)
      .set({
        leaseUntil: 0,
        status: "completed",
        messageId,
        completedAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
      })
      .where(eq(inboundMailEvents.id, eventId));
    if (!existing)
      await logMailActivity(db, organizationId, ticket.id, "ticket.customer_replied", "message", messageId, {
        providerMessageId: mail.providerMessageId,
      });
    if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
  } catch (error) {
    const terminal = (error instanceof MailFailure && error.terminal) || attempts >= maxAttempts;
    const code = error instanceof MailFailure ? error.code : "inbound_processing_failed";
    await env.DB.prepare(
      "UPDATE inbound_mail_events SET status = 'failed', last_error = ?, terminal_reason = ?, lease_until = 0, dispatch_until = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status <> 'completed'",
    )
      .bind(
        code,
        terminal ? code : null,
        Date.now() + leaseMs,
        Date.now() + retryDelay(attempts) * 1000,
        Date.now(),
        eventId,
      )
      .run();
    throw new MailFailure(
      error instanceof MailFailure ? error.message : "Inbound mail processing failed.",
      terminal,
      code,
      retryDelay(attempts),
    );
  }
}

export async function processOutboundMail(
  env: AppBindings,
  payload: { jobId?: string; organizationId?: string; messageId?: string },
) {
  const now = new Date();
  let job = payload.jobId
    ? await env.DB.prepare(
        "SELECT id, organization_id AS organizationId, message_id AS messageId, idempotency_key AS idempotencyKey, status, attempts, lease_until AS leaseUntil, first_attempt_at AS firstAttemptAt, envelope, generation FROM outbound_mail_jobs WHERE id = ?",
      )
        .bind(payload.jobId)
        .first<JobRow>()
    : null;
  if (!job && payload.organizationId && payload.messageId) {
    const id = newId("omj");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO outbound_mail_jobs (id, organization_id, message_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
      .bind(
        id,
        payload.organizationId,
        payload.messageId,
        `message/${payload.messageId}`,
        now.getTime(),
        now.getTime(),
        now.getTime(),
      )
      .run();
    job = await env.DB.prepare(
      "SELECT id, organization_id AS organizationId, message_id AS messageId, idempotency_key AS idempotencyKey, status, attempts, lease_until AS leaseUntil, first_attempt_at AS firstAttemptAt, envelope, generation FROM outbound_mail_jobs WHERE message_id = ?",
    )
      .bind(payload.messageId)
      .first<JobRow>();
  }
  if (!job || job.status === "sent") return;
  const claimed = await env.DB.prepare(
    "UPDATE outbound_mail_jobs SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND status <> 'sent' AND terminal_reason IS NULL AND attempts < 6 AND lease_until <= ? AND next_attempt_at <= ? AND generation = ? RETURNING attempts",
  )
    .bind(now.getTime() + leaseMs, now.getTime(), job.id, now.getTime(), now.getTime(), job.generation)
    .first<{ attempts: number }>();
  if (!claimed) return;
  job.attempts = claimed.attempts;
  const db = createDb(env.DB);
  const row = await env.DB.prepare(
    "SELECT m.body_text AS body, m.body_html AS html, m.delivery_status AS status, m.rfc_message_id AS rfcMessageId, c.email AS customerEmail, t.id AS ticketId, t.subject, t.number, o.slug AS organizationSlug, i.email_address AS inboxAddress, coalesce(i.email_address, o.support_email) AS supportEmail FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id JOIN customers c ON c.id = t.customer_id AND c.organization_id = m.organization_id JOIN organizations o ON o.id = m.organization_id LEFT JOIN inboxes i ON i.id = t.inbox_id AND i.organization_id = t.organization_id AND i.disabled_at IS NULL WHERE m.organization_id = ? AND m.id = ? LIMIT 1",
  )
    .bind(job.organizationId, job.messageId)
    .first<OutboundRow>();
  if (!row || row.status === "sent") {
    await db
      .update(outboundMailJobs)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(eq(outboundMailJobs.id, job.id));
    return;
  }
  try {
    const provider = selectOutgoingProvider(env, job.organizationId);
    if (!provider) throw new MailFailure("No outgoing mail provider is configured.", true, "provider_missing");
    if (!row.supportEmail)
      throw new MailFailure(
        "No support inbox is configured. Add one in Settings → Support inboxes.",
        true,
        "inbox_missing",
      );
    const domain = row.supportEmail.split("@")[1] ?? "resolvehq.local";
    const rfcMessageId = row.rfcMessageId ?? `<${job.messageId}@${domain}>`;
    if (!row.rfcMessageId)
      await env.DB.prepare("UPDATE messages SET rfc_message_id = ? WHERE organization_id = ? AND id = ?")
        .bind(rfcMessageId, job.organizationId, job.messageId)
        .run();
    const lastCustomer = await env.DB.prepare(
      "SELECT coalesce(rfc_message_id, provider_message_id) AS ref FROM messages WHERE organization_id = ? AND ticket_id = ? AND author_type = 'customer' AND coalesce(rfc_message_id, provider_message_id) IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
      .bind(job.organizationId, row.ticketId)
      .first<{ ref: string }>();
    const envelope: OutgoingMail = job.envelope
      ? JSON.parse(job.envelope)
      : {
          from: row.supportEmail,
          to: row.customerEmail,
          subject: `[#${row.number}] ${row.subject}`,
          text: row.body,
          html: row.html,
          messageId: rfcMessageId,
          references: lastCustomer?.ref ? [lastCustomer.ref] : undefined,
        };
    if (job.firstAttemptAt && Date.now() - job.firstAttemptAt >= retryWindowMs)
      throw new MailFailure("Delivery needs review before retrying.", true, "delivery_uncertain");
    if (!job.envelope)
      await env.DB.prepare("UPDATE outbound_mail_jobs SET envelope = ?, first_attempt_at = ? WHERE id = ?")
        .bind(JSON.stringify(envelope), Date.now(), job.id)
        .run();
    const result = await provider.send(envelope, { idempotencyKey: job.idempotencyKey });
    await db.batch([
      db
        .update(messages)
        .set({
          deliveryStatus: sql`CASE WHEN EXISTS (SELECT 1 FROM outbound_mail_jobs WHERE id = ${job.id} AND terminal_reason IS NOT NULL) THEN 'failed' ELSE 'sent' END`,
          providerMessageId: result.providerMessageId,
        })
        .where(and(eq(messages.organizationId, job.organizationId), eq(messages.id, job.messageId))),
      db
        .update(outboundMailJobs)
        .set({
          status: sql`CASE WHEN ${outboundMailJobs.terminalReason} IS NULL THEN 'sent' ELSE 'failed' END`,
          leaseUntil: 0,
          providerMessageId: result.providerMessageId,
          sentAt: now,
          lastError: sql`CASE WHEN ${outboundMailJobs.terminalReason} IS NULL THEN NULL ELSE ${outboundMailJobs.lastError} END`,
          updatedAt: now,
        })
        .where(eq(outboundMailJobs.id, job.id)),
    ]);
  } catch (error) {
    const attempts = job.attempts;
    const delay = retryDelay(attempts);
    const terminal = (error instanceof MailFailure && error.terminal) || attempts >= maxAttempts;
    const code = error instanceof MailFailure ? error.code : "delivery_uncertain";
    await db
      .update(outboundMailJobs)
      .set({
        status: "failed",
        lastError: code,
        terminalReason: terminal ? code : null,
        leaseUntil: 0,
        dispatchUntil: Date.now() + leaseMs,
        nextAttemptAt: new Date(Date.now() + delay * 1000),
        updatedAt: new Date(),
      })
      .where(and(eq(outboundMailJobs.id, job.id), isNull(outboundMailJobs.terminalReason)));
    await db
      .update(messages)
      .set({ deliveryStatus: "failed" })
      .where(and(eq(messages.organizationId, job.organizationId), eq(messages.id, job.messageId)));
    throw new MailFailure(
      error instanceof MailFailure ? error.message : "Outbound delivery failed.",
      terminal,
      code,
      delay,
    );
  }
}

interface ExistingMessage {
  createdAt: number;
  messageId: string;
  ticketId: string;
  number: number;
  subject: string;
  customerId: string;
}
interface TicketReference {
  id: string;
  number: number;
  subject: string;
  customerId: string;
}
interface JobRow {
  leaseUntil: number;
  firstAttemptAt: number | null;
  envelope: string | null;
  generation: number;
  id: string;
  organizationId: string;
  messageId: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
}
interface OutboundRow {
  body: string;
  html?: string;
  status: string;
  rfcMessageId?: string;
  customerEmail: string;
  ticketId: string;
  subject: string;
  number: number;
  organizationSlug: string;
  inboxAddress?: string;
  supportEmail?: string;
}

export async function resolveInbox(database: D1Database, recipient: string) {
  const existing = await database
    .prepare(
      "SELECT id, organization_id AS organizationId FROM inboxes WHERE lower(email_address) = ? AND disabled_at IS NULL LIMIT 1",
    )
    .bind(recipient)
    .first<{ id: string; organizationId: string }>();
  if (existing) return existing;
  const organization = await database
    .prepare("SELECT id AS organizationId FROM organizations WHERE lower(support_email) = ? LIMIT 1")
    .bind(recipient)
    .first<{ organizationId: string }>();
  if (!organization) return null;
  const id = newId("inb");
  const now = Date.now();
  await database
    .prepare(
      "INSERT OR IGNORE INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at) VALUES (?, ?, 'Support', ?, 'cloudflare_email', 1, ?, ?)",
    )
    .bind(id, organization.organizationId, recipient, now, now)
    .run();
  return database
    .prepare("SELECT id, organization_id AS organizationId FROM inboxes WHERE lower(email_address) = ? LIMIT 1")
    .bind(recipient)
    .first<{ id: string; organizationId: string }>();
}

async function logMailActivity(
  db: ReturnType<typeof createDb>,
  organizationId: string,
  ticketId: string,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await db.insert(activityLogs).values({
    id: newId("act"),
    organizationId,
    ticketId,
    eventType,
    entityType,
    entityId,
    metadata,
    requestId: "mail-queue",
  });
}

function preview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}
function safeFilename(name: string) {
  return (
    [...name]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || character === "/" || character === "\\" ? "_" : character;
      })
      .join("")
      .slice(0, 180) || "attachment"
  );
}
function matchesSignature(bytes: Uint8Array, type: string) {
  if (type.startsWith("text/") || type === "application/json") return !bytes.slice(0, 512).includes(0);
  if (type === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8");
  if (type === "image/webp")
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  if (type === "application/pdf") return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (type === "application/zip") return bytes[0] === 0x50 && bytes[1] === 0x4b;
  return false;
}
