import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../db";
import { attachments, customers, messages, tickets } from "../db/schema";

const terminalEraseUpdate = (table: "inbound_mail_events" | "outbound_mail_jobs", where: string) =>
  `UPDATE ${table} SET status = 'failed', terminal_reason = 'customer_erased', lease_until = 0, dispatch_until = 0 WHERE ${where}`;

/**
 * Deletes one ticket and everything that hangs off it. Mail jobs for the
 * ticket's messages are terminalized first so an in-flight reply can neither
 * resend nor resurrect the conversation. Returns the R2 keys that were removed.
 */
export async function eraseTicket(database: D1Database, bucket: R2Bucket, organizationId: string, ticketId: string) {
  const db = createDb(database);
  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)))
    .limit(1);
  if (!ticket) return { deleted: false, objectKeys: [] as string[] };

  const messageIds = (
    await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.ticketId, ticketId), eq(messages.organizationId, organizationId)))
  ).map((row) => row.id);

  if (messageIds.length) {
    // In-flight inbound retries would recreate the messages; in-flight outbound retries would resend them.
    await database
      .prepare(terminalEraseUpdate("inbound_mail_events", `message_id IN (${messageIds.map(() => "?").join(",")})`))
      .bind(...messageIds)
      .run();
    await database
      .prepare(terminalEraseUpdate("outbound_mail_jobs", `message_id IN (${messageIds.map(() => "?").join(",")})`))
      .bind(...messageIds)
      .run();
  }

  const attachmentRows = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(and(eq(attachments.ticketId, ticketId), eq(attachments.organizationId, organizationId)));
  await Promise.all(attachmentRows.map((row) => bucket.delete(row.objectKey)));

  await database.batch([
    database
      .prepare("DELETE FROM ticket_search WHERE organization_id = ? AND ticket_id = ?")
      .bind(organizationId, ticketId),
    database
      .prepare("DELETE FROM ticket_search_rows WHERE organization_id = ? AND ticket_id = ?")
      .bind(organizationId, ticketId),
    database
      .prepare("DELETE FROM ticket_drafts WHERE organization_id = ? AND ticket_id = ?")
      .bind(organizationId, ticketId),
    database.prepare("DELETE FROM tickets WHERE organization_id = ? AND id = ?").bind(organizationId, ticketId),
  ]);
  return { deleted: true, objectKeys: attachmentRows.map((row) => row.objectKey) };
}

/**
 * Enqueues the durable erasure of one customer. The maintenance consumer walks
 * five tickets per invocation, so a large history cannot exceed worker limits,
 * and a lost invocation resumes from the durable task row.
 */
export async function requestCustomerErasure(env: { DB: D1Database }, organizationId: string, customerId: string) {
  await env.DB.prepare(
    `INSERT INTO maintenance_tasks (id, kind, organization_id, customer_id) VALUES (?, 'erasure', ?, ?)
     ON CONFLICT(id) DO UPDATE SET generation = generation + 1, status = 'pending', attempts = 0, cursor = NULL, dispatch_until = 0, next_attempt_at = 0, lease_until = 0`,
  )
    .bind(`erasure/${organizationId}/${customerId}`, organizationId, customerId)
    .run();
}

/**
 * One erasure invocation: delete up to five of the customer's tickets, and when
 * none remain, remove the customer profile and guard in-flight mail.
 */
export async function processCustomerErasure(
  env: { DB: D1Database; ATTACHMENTS: R2Bucket },
  organizationId: string,
  customerId: string,
) {
  const db = createDb(env.DB);
  const [customer] = await db
    .select({ id: customers.id, email: customers.email })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  // The customer vanished mid-erasure; the task is done.
  if (!customer) return 0;
  const ticketIds = (
    await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.organizationId, organizationId), eq(tickets.customerId, customerId)))
      .orderBy(tickets.id)
      .limit(5)
  ).map((row) => row.id);
  for (const ticketId of ticketIds) await eraseTicket(env.DB, env.ATTACHMENTS, organizationId, ticketId);
  if (ticketIds.length === 5) return 5;

  // Remaining guard: a staged inbound email from this customer must not create
  // a fresh conversation from erased content.
  await env.DB.prepare(
    terminalEraseUpdate(
      "inbound_mail_events",
      `organization_id = ? AND status IN ('staged','processing') AND lower(coalesce(envelope_from, '')) = ?`,
    ),
  )
    .bind(organizationId, customer.email.toLowerCase())
    .run();
  await env.DB.prepare(
    "DELETE FROM mail_captures WHERE organization_id = ? AND (lower(to_address) = ? OR lower(from_address) = ?)",
  )
    .bind(organizationId, customer.email.toLowerCase(), customer.email.toLowerCase())
    .run();
  await env.DB.prepare("DELETE FROM customers WHERE organization_id = ? AND id = ?")
    .bind(organizationId, customerId)
    .run();
  return ticketIds.length;
}

/** Complete export of everything ResolveHQ stores about one customer. */
export async function collectCustomerExport(database: D1Database, organizationId: string, customerId: string) {
  const db = createDb(database);
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  if (!customer) return null;
  const ticketRows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      createdAt: tickets.createdAt,
      resolvedAt: tickets.resolvedAt,
      closedAt: tickets.closedAt,
    })
    .from(tickets)
    .where(and(eq(tickets.organizationId, organizationId), eq(tickets.customerId, customerId)))
    .orderBy(tickets.createdAt);
  const ticketIds = ticketRows.map((row) => row.id);
  const messageRows = ticketIds.length
    ? await db
        .select({
          ticketId: messages.ticketId,
          authorType: messages.authorType,
          kind: messages.kind,
          bodyText: messages.bodyText,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(eq(messages.organizationId, organizationId), inArray(messages.ticketId, ticketIds)))
        .orderBy(messages.createdAt)
    : [];
  const attachmentRows = ticketIds.length
    ? await db
        .select({
          ticketId: attachments.ticketId,
          filename: attachments.filename,
          contentType: attachments.contentType,
          size: attachments.size,
          checksum: attachments.checksum,
          objectKey: attachments.objectKey,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .where(and(eq(attachments.organizationId, organizationId), inArray(attachments.ticketId, ticketIds)))
    : [];
  return {
    exportedAt: new Date().toISOString(),
    customer: {
      name: customer.name,
      email: customer.email,
      company: customer.company,
      phone: customer.phone,
      notes: customer.notes,
      createdAt: customer.createdAt,
      lastContactedAt: customer.lastContactedAt,
    },
    tickets: ticketRows.map((ticket) => ({
      ...ticket,
      messages: messageRows
        .filter((message) => message.ticketId === ticket.id)
        .map((message) => ({
          authorType: message.authorType,
          kind: message.kind,
          bodyText: message.bodyText,
          createdAt: message.createdAt,
        })),
      attachments: attachmentRows
        .filter((attachment) => attachment.ticketId === ticket.id)
        .map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          checksum: attachment.checksum,
          objectKey: attachment.objectKey,
          createdAt: attachment.createdAt,
        })),
    })),
  };
}
