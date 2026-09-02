export interface IncomingMail {
  providerMessageId: string;
  from: { name?: string; email: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references: string[];
  attachments: Array<{ filename: string; contentType: string; body: ArrayBuffer }>;
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  references?: string[];
}

export interface IncomingMailProvider {
  parse(raw: ArrayBuffer): Promise<IncomingMail>;
}

export interface OutgoingMailProvider {
  send(message: OutgoingMail, options?: { idempotencyKey?: string }): Promise<{ providerMessageId: string }>;
}

export class DevelopmentMailProvider implements OutgoingMailProvider {
  constructor(
    private readonly database: D1Database,
    private readonly organizationId: string | null = null,
  ) {}

  async send(message: OutgoingMail) {
    const id = `dev_${crypto.randomUUID()}`;
    const headers = {
      ...(message.messageId ? { "Message-ID": message.messageId } : {}),
      ...(message.references?.length
        ? { "In-Reply-To": message.references.at(-1)!, References: message.references.join(" ") }
        : {}),
    };
    await this.database
      .prepare(
        "INSERT INTO mail_captures (id, organization_id, to_address, from_address, subject, text, html, headers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
  constructor(private readonly apiKey: string) {}

  async send(message: OutgoingMail, options?: { idempotencyKey?: string }) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
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
        ...(message.html ? { html: message.html } : {}),
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
    if (!response.ok || !result.id) throw new Error(`Resend rejected the email: ${result.message ?? response.status}.`);
    return { providerMessageId: result.id };
  }
}

export class PostalMimeIncomingProvider implements IncomingMailProvider {
  async parse(raw: ArrayBuffer): Promise<IncomingMail> {
    const email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxHeadersSize: 256 * 1024,
      maxNestingDepth: 20,
    });
    const from = mailbox(email.from);
    const to = email.to?.map(mailbox).find(Boolean);
    if (!from?.email || !to?.email) throw new Error("Inbound email must include valid From and To mailboxes.");
    const text = email.text?.trim() || readableText(email.html ?? "");
    if (!text) throw new Error("Inbound email does not contain a readable message.");
    return {
      providerMessageId: email.messageId?.slice(0, 998) || `mail_${crypto.randomUUID()}`,
      from,
      to: to.email,
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
