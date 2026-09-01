import { and, eq } from "drizzle-orm";
import { createDb } from "../db";
import { activityLogs, attachments, customers, messages, organizations, tickets } from "../db/schema";
import { base64Url } from "../lib/crypto";
import { newId, normalizeSearch } from "../lib/id";
import { DevelopmentMailProvider, PostalMimeIncomingProvider } from "../providers/mail";
import type { AppBindings } from "../types";

const maximumAttachmentSize = 15 * 1024 * 1024;
const safeMailTypes = new Set(["application/pdf", "application/zip", "application/json", "text/plain", "text/csv", "image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function processInboundMail(env: AppBindings, payload: { raw: ArrayBuffer; from: string; to: string }) {
  const mail = await new PostalMimeIncomingProvider().parse(payload.raw);
  const recipient = (mail.to || payload.to).toLowerCase();
  const workspace = await env.DB.prepare("SELECT id AS organizationId FROM organizations WHERE lower(support_email) = ? LIMIT 1").bind(recipient).first<{ organizationId: string }>();
  if (!workspace) throw new Error(`No ResolveHQ inbox is configured for ${recipient}.`);
  const organizationId = workspace.organizationId;
  const db = createDb(env.DB);
  const [duplicate] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.organizationId, organizationId), eq(messages.providerMessageId, mail.providerMessageId))).limit(1);
  if (duplicate) return;

  let [customer] = await db.select().from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.email, mail.from.email))).limit(1);
  if (!customer) {
    const customerId = newId("cus");
    await db.insert(customers).values({ id: customerId, organizationId, name: mail.from.name || mail.from.email.split("@")[0], email: mail.from.email, normalizedSearch: normalizeSearch(mail.from.name, mail.from.email), lastContactedAt: new Date() });
    [customer] = await db.select().from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.id, customerId))).limit(1);
  }
  if (!customer) throw new Error("Could not resolve inbound customer.");

  let ticket: { id: string; number: number; subject: string } | undefined;
  if (mail.inReplyTo) {
    [ticket] = await db.select({ id: tickets.id, number: tickets.number, subject: tickets.subject }).from(messages).innerJoin(tickets, and(eq(tickets.id, messages.ticketId), eq(tickets.organizationId, organizationId))).where(and(eq(messages.organizationId, organizationId), eq(messages.providerMessageId, mail.inReplyTo))).limit(1);
  }
  const referencedNumber = mail.subject.match(/\[#?(\d+)]|#(\d+)/)?.slice(1).find(Boolean);
  if (!ticket && referencedNumber) [ticket] = await db.select({ id: tickets.id, number: tickets.number, subject: tickets.subject }).from(tickets).where(and(eq(tickets.organizationId, organizationId), eq(tickets.number, Number(referencedNumber)))).limit(1);

  const now = new Date();
  if (!ticket) {
    const numberRow = await env.DB.prepare("UPDATE organizations SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ? RETURNING next_ticket_number - 1 AS number").bind(now.getTime(), organizationId).first<{ number: number }>();
    if (!numberRow) throw new Error("Inbound workspace no longer exists.");
    ticket = { id: newId("tkt"), number: numberRow.number, subject: mail.subject };
    await db.insert(tickets).values({ id: ticket.id, organizationId, number: ticket.number, customerId: customer.id, subject: ticket.subject, status: "open", priority: "normal", normalizedSearch: normalizeSearch(String(ticket.number), ticket.subject, customer.name, customer.email), lastReplyAt: now });
    await logMailActivity(db, organizationId, ticket.id, "ticket.created_from_email", "ticket", ticket.id, { recipient });
  }

  const messageId = newId("msg");
  await db.insert(messages).values({ id: messageId, organizationId, ticketId: ticket.id, authorType: "customer", authorCustomerId: customer.id, kind: "message", bodyText: mail.text, normalizedSearch: normalizeSearch(mail.text), providerMessageId: mail.providerMessageId, deliveryStatus: "received", createdAt: now });
  await db.update(tickets).set({ status: "open", resolvedAt: null, closedAt: null, updatedAt: now, lastReplyAt: now }).where(and(eq(tickets.organizationId, organizationId), eq(tickets.id, ticket.id)));
  await db.update(customers).set({ lastContactedAt: now, updatedAt: now }).where(and(eq(customers.organizationId, organizationId), eq(customers.id, customer.id)));

  for (const file of mail.attachments) {
    if (file.body.byteLength < 1 || file.body.byteLength > maximumAttachmentSize || !safeMailTypes.has(file.contentType) || !matchesSignature(new Uint8Array(file.body), file.contentType)) continue;
    const id = newId("att"); const objectKey = `${organizationId}/${id}/${crypto.randomUUID()}`;
    await env.ATTACHMENTS.put(objectKey, file.body, { httpMetadata: { contentType: file.contentType }, customMetadata: { attachmentId: id } });
    const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", file.body)));
    try { await db.insert(attachments).values({ id, organizationId, ticketId: ticket.id, messageId, objectKey, filename: safeFilename(file.filename), contentType: file.contentType, size: file.body.byteLength, checksum }); }
    catch (error) { await env.ATTACHMENTS.delete(objectKey); throw error; }
  }
  await logMailActivity(db, organizationId, ticket.id, "ticket.customer_replied", "message", messageId, { providerMessageId: mail.providerMessageId });
}

export async function processOutboundMail(env: AppBindings, payload: { organizationId: string; messageId: string }) {
  const db = createDb(env.DB);
  const [row] = await db.select({ body: messages.bodyText, status: messages.deliveryStatus, customerEmail: customers.email, subject: tickets.subject, number: tickets.number, organizationSlug: organizations.slug, supportEmail: organizations.supportEmail })
    .from(messages).innerJoin(tickets, and(eq(tickets.id, messages.ticketId), eq(tickets.organizationId, payload.organizationId))).innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, payload.organizationId))).innerJoin(organizations, eq(organizations.id, payload.organizationId))
    .where(and(eq(messages.organizationId, payload.organizationId), eq(messages.id, payload.messageId))).limit(1);
  if (!row || row.status === "sent") return;
  if (env.DEV_MAIL_MODE !== "capture") throw new Error("No production outgoing mail adapter is configured.");
  const result = await new DevelopmentMailProvider().send({ from: row.supportEmail || `support@${row.organizationSlug}.invalid`, to: row.customerEmail, subject: `[#${row.number}] ${row.subject}`, text: row.body });
  await db.update(messages).set({ deliveryStatus: "sent", providerMessageId: result.providerMessageId }).where(and(eq(messages.organizationId, payload.organizationId), eq(messages.id, payload.messageId)));
  console.info("ResolveHQ captured outbound mail", { to: row.customerEmail, subject: `[#${row.number}] ${row.subject}`, providerMessageId: result.providerMessageId });
}

async function logMailActivity(db: ReturnType<typeof createDb>, organizationId: string, ticketId: string, eventType: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await db.insert(activityLogs).values({ id: newId("act"), organizationId, ticketId, eventType, entityType, entityId, metadata, requestId: "mail-queue" });
}

function safeFilename(name: string) { return [...name].map((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127 || character === "/" || character === "\\" ? "_" : character; }).join("").slice(0, 180) || "attachment"; }
function matchesSignature(bytes: Uint8Array, type: string) {
  if (type.startsWith("text/") || type === "application/json") return !bytes.slice(0, 512).includes(0);
  if (type === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8");
  if (type === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (type === "application/pdf") return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (type === "application/zip") return bytes[0] === 0x50 && bytes[1] === 0x4b;
  return false;
}
