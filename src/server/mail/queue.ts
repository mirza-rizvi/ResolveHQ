import { and, eq } from "drizzle-orm";
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
  // Spend the retry budget before anything can fail. A staged payload whose
  // object has gone missing, or whose recipient no longer maps to an inbox,
  // never reaches the parser, so counting the attempt further down would leave
  // the cron re-queueing that same row on every tick forever.
  const attempts = staged
    ? ((
        await env.DB.prepare(
          "UPDATE inbound_mail_events SET attempts = attempts + 1, updated_at = ? WHERE id = ? RETURNING attempts",
        )
          .bind(Date.now(), eventId)
          .first<{ attempts: number }>()
      )?.attempts ?? 1)
    : 1;
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
      raw = await object.arrayBuffer();
    } else {
      if (payload.raw.byteLength > maximumRawMailSize)
        throw new Error("Inbound email exceeds the 25 MB processing limit.");
      raw = payload.raw;
    }

    const mail = await new PostalMimeIncomingProvider().parse(raw);
    const recipient = (mail.to || payload.to || "").toLowerCase();
    const inbox = await resolveInbox(env.DB, recipient);
    if (!inbox) throw new Error(`No ResolveHQ inbox is configured for ${recipient}.`);
    const organizationId = inbox.organizationId;
    const now = new Date();
    const duplicateEvent = await env.DB.prepare(
      "SELECT status FROM inbound_mail_events WHERE inbox_id = ? AND provider_message_id = ? LIMIT 1",
    )
      .bind(inbox.id, mail.providerMessageId)
      .first<{ status: string }>();
    if (duplicateEvent?.status === "completed") {
      if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
      return;
    }

    await db
      .insert(inboundMailEvents)
      .values({
        id: eventId,
        inboxId: inbox.id,
        organizationId,
        stagingObjectKey: staged ? payload.stagingObjectKey : `test://${eventId}`,
        providerMessageId: mail.providerMessageId,
        status: "processing",
        attempts,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: staged ? inboundMailEvents.stagingObjectKey : inboundMailEvents.id,
        set: {
          inboxId: inbox.id,
          organizationId,
          providerMessageId: mail.providerMessageId,
          status: "processing",
          attempts,
          lastError: null,
          updatedAt: now,
        },
      });

    const existing = await env.DB.prepare(
      "SELECT m.id AS messageId, m.ticket_id AS ticketId, t.number, t.subject, t.customer_id AS customerId FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id WHERE m.organization_id = ? AND m.provider_message_id = ? LIMIT 1",
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

    if (!ticket) {
      const numberRow = await env.DB.prepare(
        "UPDATE organizations SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ? RETURNING next_ticket_number - 1 AS number",
      )
        .bind(now.getTime(), organizationId)
        .first<{ number: number }>();
      if (!numberRow) throw new Error("Inbound workspace no longer exists.");
      ticket = { id: newId("tkt"), number: numberRow.number, subject: mail.subject, customerId: customer.id };
      await db.insert(tickets).values({
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
      });
      await logMailActivity(db, organizationId, ticket.id, "ticket.created_from_email", "ticket", ticket.id, {
        inboxId: inbox.id,
      });
    }

    const messageId = existing?.messageId ?? newId("msg");
    if (!existing) {
      await db.insert(messages).values({
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
      });
      await env.DB.prepare(
        "UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL, waiting_since = NULL, updated_at = ?, last_reply_at = ?, last_customer_reply_at = ?, last_message_preview = ?, message_count = message_count + 1, version = version + 1 WHERE organization_id = ? AND id = ?",
      )
        .bind(now.getTime(), now.getTime(), now.getTime(), preview(mail.text), organizationId, ticket.id)
        .run();
      await refreshTicketSearch(env.DB, organizationId, ticket.id);
    } else {
      // Reconcile the denormalized ticket state in case a previous delivery
      // stopped after the unique message insert but before the ticket update.
      await env.DB.prepare(
        "UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL, waiting_since = NULL, last_reply_at = max(coalesce(last_reply_at, 0), ?), last_customer_reply_at = max(coalesce(last_customer_reply_at, 0), ?), last_message_preview = ?, message_count = (SELECT count(*) FROM messages WHERE organization_id = ? AND ticket_id = ?) WHERE organization_id = ? AND id = ?",
      )
        .bind(now.getTime(), now.getTime(), preview(mail.text), organizationId, ticket.id, organizationId, ticket.id)
        .run();
      await refreshTicketSearch(env.DB, organizationId, ticket.id);
    }
    await db
      .update(customers)
      .set({ lastContactedAt: now, updatedAt: now })
      .where(and(eq(customers.organizationId, organizationId), eq(customers.id, customer.id)));

    const cursor = await env.DB.prepare("SELECT attachment_cursor AS cursor FROM inbound_mail_events WHERE id = ?")
      .bind(eventId)
      .first<{ cursor: number }>();
    for (let index = cursor?.cursor ?? 0; index < mail.attachments.length; index += 1) {
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

    await db
      .update(inboundMailEvents)
      .set({ status: "completed", messageId, completedAt: new Date(), updatedAt: new Date(), lastError: null })
      .where(eq(inboundMailEvents.id, eventId));
    if (!existing)
      await logMailActivity(db, organizationId, ticket.id, "ticket.customer_replied", "message", messageId, {
        providerMessageId: mail.providerMessageId,
      });
    if (staged) await env.ATTACHMENTS.delete(payload.stagingObjectKey);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown inbound mail error";
    await env.DB.prepare(
      "UPDATE inbound_mail_events SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(message, Date.now(), eventId)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

export async function processOutboundMail(
  env: AppBindings,
  payload: { jobId?: string; organizationId?: string; messageId?: string },
) {
  const now = new Date();
  let job = payload.jobId
    ? await env.DB.prepare(
        "SELECT id, organization_id AS organizationId, message_id AS messageId, idempotency_key AS idempotencyKey, status, attempts FROM outbound_mail_jobs WHERE id = ?",
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
      "SELECT id, organization_id AS organizationId, message_id AS messageId, idempotency_key AS idempotencyKey, status, attempts FROM outbound_mail_jobs WHERE message_id = ?",
    )
      .bind(payload.messageId)
      .first<JobRow>();
  }
  if (!job || job.status === "sent") return;
  await env.DB.prepare(
    "UPDATE outbound_mail_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status <> 'sent'",
  )
    .bind(now.getTime(), job.id)
    .run();
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
    if (!provider) throw new Error("No outgoing mail provider is configured.");
    if (!row.supportEmail)
      throw new Error("No support inbox is configured. Add one in Settings \u2192 Support inboxes.");
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
    const result = await provider.send(
      {
        from: row.supportEmail,
        to: row.customerEmail,
        subject: `[#${row.number}] ${row.subject}`,
        text: row.body,
        html: row.html,
        messageId: rfcMessageId,
        references: lastCustomer?.ref ? [lastCustomer.ref] : undefined,
      },
      { idempotencyKey: job.idempotencyKey },
    );
    await db.batch([
      db
        .update(messages)
        .set({ deliveryStatus: "sent", providerMessageId: result.providerMessageId })
        .where(and(eq(messages.organizationId, job.organizationId), eq(messages.id, job.messageId))),
      db
        .update(outboundMailJobs)
        .set({
          status: "sent",
          providerMessageId: result.providerMessageId,
          sentAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(outboundMailJobs.id, job.id)),
    ]);
  } catch (error) {
    const attempts = job.attempts + 1;
    const delay = Math.min(3600, 15 * 2 ** Math.min(attempts, 8));
    await db
      .update(outboundMailJobs)
      .set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown mail error",
        nextAttemptAt: new Date(Date.now() + delay * 1000),
        updatedAt: new Date(),
      })
      .where(eq(outboundMailJobs.id, job.id));
    await db
      .update(messages)
      .set({ deliveryStatus: "failed" })
      .where(and(eq(messages.organizationId, job.organizationId), eq(messages.id, job.messageId)));
    throw error;
  }
}

interface ExistingMessage {
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

async function resolveInbox(database: D1Database, recipient: string) {
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
  await db
    .insert(activityLogs)
    .values({
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
