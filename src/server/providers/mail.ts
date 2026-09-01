export interface IncomingMail {
  providerMessageId: string;
  from: { name?: string; email: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  attachments: Array<{ filename: string; contentType: string; body: ArrayBuffer }>;
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyToMessageId?: string;
}

export interface IncomingMailProvider {
  parse(raw: ArrayBuffer): Promise<IncomingMail>;
}

export interface OutgoingMailProvider {
  send(message: OutgoingMail): Promise<{ providerMessageId: string }>;
}

export class DevelopmentMailProvider implements OutgoingMailProvider {
  readonly messages: OutgoingMail[] = [];

  async send(message: OutgoingMail) {
    this.messages.push(structuredClone(message));
    return { providerMessageId: `dev_${crypto.randomUUID()}` };
  }
}

export class PostalMimeIncomingProvider implements IncomingMailProvider {
  async parse(raw: ArrayBuffer): Promise<IncomingMail> {
    const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxHeadersSize: 256 * 1024, maxNestingDepth: 20 });
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
      attachments: email.attachments.map((attachment, index) => ({
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.mimeType || "application/octet-stream",
        body: attachment.content instanceof ArrayBuffer ? attachment.content : typeof attachment.content === "string" ? new TextEncoder().encode(attachment.content).buffer as ArrayBuffer : new Uint8Array(attachment.content).slice().buffer as ArrayBuffer,
      })),
    };
  }
}

function mailbox(address: { name: string; address: string } | { name: string; group: Array<{ name: string; address: string }> } | undefined) {
  if (!address) return undefined;
  const value = "address" in address ? address : address.group[0];
  if (!value?.address) return undefined;
  return { name: value.name?.trim() || undefined, email: value.address.trim().toLowerCase() };
}

function readableText(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}
import PostalMime from "postal-mime";
