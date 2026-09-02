import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { attachments } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { base64Url, constantTimeEqual, fromBase64Url, signValue } from "resolve-server/lib/crypto";
import { newId } from "resolve-server/lib/id";
import { R2StorageProvider } from "resolve-server/providers/storage";
import type { HonoEnv } from "resolve-server/types";

const maxFileSize = 15 * 1024 * 1024;
const allowedTypes = new Set([
  "application/pdf",
  "application/zip",
  "application/json",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const attachmentRoutes = new Hono<HonoEnv>();
attachmentRoutes.use("*", requireAuth);

attachmentRoutes.post("/intents", async (context) => {
  const tenant = context.get("tenant");
  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `upload:${tenant.userId}` })).success)
    throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
  const input = await context.req
    .json<{ ticketId?: string; filename?: string; contentType?: string; size?: number }>()
    .catch(() => null);
  if (!input) throw new HttpError(400, "invalid_upload", "File metadata must be valid JSON.");
  if (!input.ticketId || !input.filename || !input.contentType || !Number.isInteger(input.size))
    throw new HttpError(400, "invalid_upload", "File metadata is incomplete.");
  if ((input.size ?? 0) < 1 || (input.size ?? 0) > maxFileSize)
    throw new HttpError(413, "file_too_large", "Files must be smaller than 15 MB.");
  if (!allowedTypes.has(input.contentType))
    throw new HttpError(415, "unsupported_file", "This file type is not supported.");
  await assertTicket(context.env.DB, tenant.organizationId, input.ticketId);
  const attachmentId = newId("att");
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        attachmentId,
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        ticketId: input.ticketId,
        filename: safeFilename(input.filename),
        contentType: input.contentType,
        size: input.size,
        expiresAt: Date.now() + 10 * 60 * 1000,
      }),
    ),
  );
  const signature = await signValue(payload, context.env.SESSION_PEPPER);
  const token = `${payload}.${signature}`;
  return context.json(
    { upload: { attachmentId, url: `/api/attachments/intents/${token}`, method: "PUT", expiresIn: 600 } },
    201,
  );
});

attachmentRoutes.put("/intents/:token", async (context) => {
  const tenant = context.get("tenant");
  const [payload, signature] = context.req.param("token").split(".");
  if (!payload || !signature || !constantTimeEqual(signature, await signValue(payload, context.env.SESSION_PEPPER)))
    throw new HttpError(401, "invalid_upload_token", "The upload link is invalid.");
  let intent: UploadIntent;
  try {
    intent = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as UploadIntent;
  } catch {
    throw new HttpError(400, "invalid_upload_token", "The upload link is malformed.");
  }
  if (
    intent.expiresAt < Date.now() ||
    intent.organizationId !== tenant.organizationId ||
    intent.userId !== tenant.userId
  )
    throw new HttpError(403, "expired_upload_token", "The upload link has expired.");
  const contentLength = Number(context.req.header("content-length"));
  if (contentLength !== intent.size)
    throw new HttpError(400, "upload_size_mismatch", "The uploaded file size does not match the upload intent.");
  if (context.req.header("content-type") !== intent.contentType || !context.req.raw.body)
    throw new HttpError(415, "mime_mismatch", "The uploaded content type does not match the upload intent.");
  await assertTicket(context.env.DB, tenant.organizationId, intent.ticketId);
  const objectKey = `${tenant.organizationId}/${intent.attachmentId}/${crypto.randomUUID()}`;
  await context.env.ATTACHMENTS.put(objectKey, context.req.raw.body, {
    httpMetadata: { contentType: intent.contentType },
    customMetadata: { attachmentId: intent.attachmentId },
  });
  const object = await context.env.ATTACHMENTS.get(objectKey);
  if (!object) throw new HttpError(500, "upload_failed", "The uploaded object could not be verified.");
  const body = await object.arrayBuffer();
  if (body.byteLength !== intent.size || !matchesSignature(new Uint8Array(body), intent.contentType)) {
    await context.env.ATTACHMENTS.delete(objectKey);
    throw new HttpError(415, "mime_mismatch", "The file contents do not match its declared type.");
  }
  const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  try {
    await createDb(context.env.DB)
      .insert(attachments)
      .values({
        id: intent.attachmentId,
        organizationId: tenant.organizationId,
        ticketId: intent.ticketId,
        messageId: null,
        objectKey,
        filename: intent.filename,
        contentType: intent.contentType,
        size: intent.size,
        checksum,
        uploadedByUserId: tenant.userId,
      });
  } catch (error) {
    await context.env.ATTACHMENTS.delete(objectKey);
    throw error;
  }
  return context.json(
    {
      attachment: {
        id: intent.attachmentId,
        ticketId: intent.ticketId,
        messageId: null,
        filename: intent.filename,
        contentType: intent.contentType,
        size: intent.size,
      },
    },
    201,
  );
});

attachmentRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const [attachment] = await createDb(context.env.DB)
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, context.req.param("id")), eq(attachments.organizationId, tenant.organizationId)))
    .limit(1);
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

interface UploadIntent {
  attachmentId: string;
  organizationId: string;
  userId: string;
  ticketId: string;
  filename: string;
  contentType: string;
  size: number;
  expiresAt: number;
}

async function assertTicket(database: D1Database, organizationId: string, ticketId: string) {
  const ticket = await database
    .prepare("SELECT 1 FROM tickets WHERE organization_id = ? AND id = ?")
    .bind(organizationId, ticketId)
    .first();
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
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

function matchesSignature(bytes: Uint8Array, contentType: string) {
  if (contentType.startsWith("text/") || contentType === "application/json") return !bytes.slice(0, 512).includes(0);
  if (contentType === "image/png")
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/gif")
    return (
      String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a"
    );
  if (contentType === "image/webp")
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  if (contentType === "application/pdf") return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (contentType.includes("zip") || contentType.includes("openxmlformats"))
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  return false;
}
