import { MailFailure } from "../mail/reliability";
export interface IncomingMail {
  providerMessageId: string;
  from: { name?: string; email: string };
  /** Reply-To is admitted for header threading only; it is never persisted as an identity. */
  replyTo?: { name?: string; email: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references: string[];
  attachments: Array<{ filename: string; contentType: string; body: ArrayBuffer }>;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  objectKey: string;
  size: number;
  checksum: string;
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  references?: string[];
  /** Tagged address replies should reach; set only when reply tokens are enabled. */
  replyTo?: string;
  /** Frozen manifest of linked attachments; bytes resolve from storage on every attempt. */
  attachmentManifest?: OutgoingAttachment[];
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
}

export interface IncomingMailProvider {
  parse(raw: ArrayBuffer): Promise<IncomingMail>;
}

export interface OutgoingMailProvider {
  readonly providerName: "resend" | "cloudflare" | "capture";
  /**
   * Cheap synchronous validation of a resolved envelope. Callers run it before
   * recording a non-idempotent send attempt so a message that can never be
   * accepted stops without a duplicate-risk marker against it.
   */
  precheck?(message: OutgoingMail): void;
  /**
   * True when the provider de-duplicates repeated sends of the same idempotency
   * key. A false value means every attempt can produce another copy, so the
   * caller must guard the send itself and never retry it automatically.
   */
  readonly idempotent: boolean;
  send(message: OutgoingMail, options?: { idempotencyKey?: string }): Promise<{ providerMessageId: string }>;
}

/** RFC 5322 message ids are stored angle-bracketed so inbound `References` match them verbatim. */
export function normalizeMessageId(id: string) {
  const value = id.trim();
  if (!value) return value;
  return value.startsWith("<") && value.endsWith(">") ? value : `<${value.replace(/^<|>$/g, "")}>`;
}

export class DevelopmentMailProvider implements OutgoingMailProvider {
  readonly providerName = "capture" as const;
  readonly idempotent = true;
  constructor(
    private readonly database: D1Database,
    private readonly organizationId: string | null = null,
  ) {}

  async send(message: OutgoingMail, options?: { idempotencyKey?: string }) {
    const id = options?.idempotencyKey
      ? `dev_${this.organizationId ?? "system"}/${options.idempotencyKey}`
      : `dev_${crypto.randomUUID()}`;
    const headers = {
      ...(message.messageId ? { "Message-ID": message.messageId } : {}),
      ...(message.replyTo ? { "Reply-To": message.replyTo } : {}),
      ...(message.references?.length
        ? { "In-Reply-To": message.references.at(-1)!, References: message.references.join(" ") }
        : {}),
    };
    await this.database
      .prepare(
        "INSERT OR IGNORE INTO mail_captures (id, organization_id, to_address, from_address, subject, text, html, headers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        this.organizationId,
        message.to,
        message.from,
        message.subject,
        message.text,
        message.html ?? null,
        JSON.stringify(headers),
        Date.now(),
      )
      .run();
    return { providerMessageId: id };
  }
}

export class ResendMailProvider implements OutgoingMailProvider {
  readonly providerName = "resend" as const;
  readonly idempotent = true;
  constructor(private readonly apiKey: string) {}

  async send(message: OutgoingMail, options?: { idempotencyKey?: string }) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((file) => ({
                filename: file.filename,
                content_type: file.contentType,
                content: file.content,
              })),
            }
          : {}),
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.messageId || message.references?.length
          ? {
              headers: {
                ...(message.messageId ? { "Message-ID": message.messageId } : {}),
                ...(message.references?.length
                  ? { "In-Reply-To": message.references.at(-1)!, References: message.references.join(" ") }
                  : {}),
              },
            }
          : {}),
      }),
    });
    const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok || !result.id)
      throw new MailFailure(
        "The mail provider rejected this request.",
        response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status),
        `provider_${response.status}`,
      );
    return { providerMessageId: result.id };
  }
}

/**
 * Cloudflare Email Sending (`send_email` binding). The platform assigns the
 * Message-ID and offers no idempotency key, so a repeated send is a repeated
 * email: `idempotent` is false and `processOutboundMail` records an attempt
 * marker before calling `send`.
 */
export class CloudflareEmailProvider implements OutgoingMailProvider {
  readonly providerName = "cloudflare" as const;
  readonly idempotent = false;
  /** Cloudflare caps a message at 5 MiB encoded; raw bytes are held well under it. */
  private static readonly maxRawBytes = 3.5 * 1024 * 1024;
  private static readonly timeoutMs = 15_000;

  constructor(private readonly sender: SendEmail) {}

  /** Size ceiling only; nothing here reaches the network. */
  precheck(message: OutgoingMail) {
    const rawBytes =
      byteLength(message.subject) +
      byteLength(message.text) +
      byteLength(message.html ?? "") +
      (message.attachments?.reduce((total, file) => total + Math.ceil((file.content.length * 3) / 4), 0) ?? 0);
    if (rawBytes > CloudflareEmailProvider.maxRawBytes)
      throw new MailFailure(
        "This message is too large to send. Remove or shrink the attachments and try again.",
        true,
        "attachments_too_large",
      );
  }

  async send(message: OutgoingMail) {
    // Defensive second layer: callers are expected to have run this already.
    this.precheck(message);
    const builder = {
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      // The platform assigns the Message-ID, so none is set here; only the
      // threading references travel as headers.
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.references?.length
        ? {
            headers: {
              "In-Reply-To": message.references.at(-1)!,
              References: message.references.join(" "),
            },
          }
        : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((file) => ({
              filename: file.filename,
              type: file.contentType,
              content: decodeBase64(file.content),
            })),
          }
        : {}),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { messageId?: string };
    // Nothing can abort a send in flight, so the binding promise outlives a
    // timeout. It keeps its own handler or a late rejection would surface as an
    // unhandled rejection in the consumer isolate and fail the whole batch.
    const pending = this.sender.send(builder as Parameters<SendEmail["send"]>[0]);
    pending.catch(() => {});
    try {
      result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MailFailure(
                  "The mail binding did not confirm this send in time.",
                  true,
                  "delivery_uncertain",
                ),
              ),
            CloudflareEmailProvider.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof MailFailure) throw error;
      throw new MailFailure("The mail binding rejected this message.", true, "provider_rejected");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!result?.messageId)
      throw new MailFailure("The mail binding returned no message id.", true, "provider_rejected");
    return { providerMessageId: normalizeMessageId(result.messageId) };
  }
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class PostalMimeIncomingProvider implements IncomingMailProvider {
  async parse(raw: ArrayBuffer): Promise<IncomingMail> {
    const email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxHeadersSize: 256 * 1024,
      maxNestingDepth: 20,
    });
    const from = mailbox(email.from);
    const replyTo = email.replyTo?.map(mailbox).find(Boolean);
    const to = email.to?.map(mailbox).find(Boolean);
    if (!from?.email) throw new Error("Inbound email must include a valid From mailbox.");
    const text = email.text?.trim() || readableText(email.html ?? "");
    if (!text) throw new Error("Inbound email does not contain a readable message.");
    return {
      providerMessageId: email.messageId?.slice(0, 998) || "",
      from,
      replyTo,
      to: to?.email ?? "",
      subject: (email.subject?.trim() || "Support request").slice(0, 240),
      text: text.slice(0, 100_000),
      inReplyTo: email.inReplyTo?.slice(0, 998),
      references: [email.inReplyTo, ...(email.references ?? "").split(/\s+/)]
        .map((value) => value?.trim().slice(0, 998))
        .filter((value): value is string => Boolean(value)),
      attachments: email.attachments.map((attachment, index) => ({
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.mimeType || "application/octet-stream",
        body:
          attachment.content instanceof ArrayBuffer
            ? attachment.content
            : typeof attachment.content === "string"
              ? (new TextEncoder().encode(attachment.content).buffer as ArrayBuffer)
              : (new Uint8Array(attachment.content).slice().buffer as ArrayBuffer),
      })),
    };
  }
}

function mailbox(
  address:
    { name: string; address: string } | { name: string; group: Array<{ name: string; address: string }> } | undefined,
) {
  if (!address) return undefined;
  const value = "address" in address ? address : address.group[0];
  if (!value?.address) return undefined;
  return { name: value.name?.trim() || undefined, email: value.address.trim().toLowerCase() };
}

function readableText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
import PostalMime from "postal-mime";
