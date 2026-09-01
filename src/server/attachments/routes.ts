import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { attachments, messages, tickets } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { base64Url } from "resolve-server/lib/crypto";
import { newId } from "resolve-server/lib/id";
import { R2StorageProvider } from "resolve-server/providers/storage";
import type { HonoEnv } from "resolve-server/types";

const maxFileSize = 15 * 1024 * 1024;
const allowedTypes = new Set([
  "application/pdf", "application/zip", "application/json", "text/plain", "text/csv",
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const attachmentRoutes = new Hono<HonoEnv>();
attachmentRoutes.use("*", requireAuth);

attachmentRoutes.post("/", async (context) => {
  const tenant = context.get("tenant");
  const form = await context.req.formData();
  const file = form.get("file");
  const ticketId = String(form.get("ticketId") ?? "");
  const messageId = String(form.get("messageId") ?? "");
  if (!(file instanceof File) || !ticketId || !messageId) throw new HttpError(400, "invalid_upload", "Choose a file and conversation message.");
  if (file.size < 1 || file.size > maxFileSize) throw new HttpError(413, "file_too_large", "Files must be smaller than 15 MB.");
  if (!allowedTypes.has(file.type)) throw new HttpError(415, "unsupported_file", "This file type is not supported.");

  const db = createDb(context.env.DB);
  const [message] = await db.select({ id: messages.id }).from(messages)
    .innerJoin(tickets, and(eq(tickets.id, messages.ticketId), eq(tickets.organizationId, tenant.organizationId)))
    .where(and(eq(messages.id, messageId), eq(messages.ticketId, ticketId), eq(messages.organizationId, tenant.organizationId))).limit(1);
  if (!message) throw new HttpError(404, "message_not_found", "Conversation message not found.");

  const body = await file.arrayBuffer();
  if (!matchesSignature(new Uint8Array(body), file.type)) throw new HttpError(415, "mime_mismatch", "The file contents do not match its declared type.");
  const id = newId("att");
  const objectKey = `${tenant.organizationId}/${id}/${crypto.randomUUID()}`;
  const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  await new R2StorageProvider(context.env.ATTACHMENTS).put({ key: objectKey, body, contentType: file.type, metadata: { attachmentId: id } });
  try {
    await db.insert(attachments).values({ id, organizationId: tenant.organizationId, ticketId, messageId, objectKey, filename: safeFilename(file.name), contentType: file.type, size: file.size, checksum, uploadedByUserId: tenant.userId });
  } catch (error) {
    await context.env.ATTACHMENTS.delete(objectKey);
    throw error;
  }
  return context.json({ attachment: { id, filename: safeFilename(file.name), contentType: file.type, size: file.size } }, 201);
});

attachmentRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const [attachment] = await createDb(context.env.DB).select().from(attachments).where(and(
    eq(attachments.id, context.req.param("id")),
    eq(attachments.organizationId, tenant.organizationId),
  )).limit(1);
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  const object = await new R2StorageProvider(context.env.ATTACHMENTS).get(attachment.objectKey);
  if (!object) throw new HttpError(404, "attachment_missing", "The attachment file is unavailable.");
  return new Response(object.body, {
    headers: {
      "content-type": attachment.contentType,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

function safeFilename(name: string) {
  return [...name].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === "/" || character === "\\" ? "_" : character;
  }).join("").slice(0, 180) || "attachment";
}

function matchesSignature(bytes: Uint8Array, contentType: string) {
  if (contentType.startsWith("text/") || contentType === "application/json") return !bytes.slice(0, 512).includes(0);
  if (contentType === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/gif") return String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a";
  if (contentType === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (contentType === "application/pdf") return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (contentType.includes("zip") || contentType.includes("openxmlformats")) return bytes[0] === 0x50 && bytes[1] === 0x4b;
  return false;
}
