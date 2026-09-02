import { Paperclip } from "lucide-react";
import { formatBytes, formatDate } from "./format";
import type { AttachmentSummary, ThreadMessage as ThreadMessageModel } from "./types";

interface ThreadMessageProps {
  message: ThreadMessageModel;
  customerName: string;
  customerEmail: string;
  agentName: string;
  attachments: AttachmentSummary[];
}

export function ThreadMessage({ message, customerName, customerEmail, agentName, attachments }: ThreadMessageProps) {
  const fromCustomer = message.authorType === "customer";
  const author = fromCustomer ? customerName : agentName;
  return <article className={`thread-entry ${message.kind === "internal_note" ? "note" : message.authorType}`}>
    <header>
      <div className="message-avatar">{author.slice(0, 1)}</div>
      <div>
        <strong>{author}</strong>
        <span>{message.kind === "internal_note" ? "Internal note" : fromCustomer ? customerEmail : "Agent reply"}</span>
      </div>
      <time>{formatDate(message.createdAt)}</time>
    </header>
    <p>{message.bodyText}</p>
    {attachments.map((file) => <a className="message-attachment" key={file.id} href={`/api/attachments/${file.id}`}>
      <Paperclip size={13} />{file.filename}<small>{formatBytes(file.size)}</small>
    </a>)}
  </article>;
}
