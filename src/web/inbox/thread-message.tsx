import { Paperclip } from "lucide-react";
import { formatBytes, formatDate } from "./format";
import type { AttachmentSummary, ThreadMessage as ThreadMessageModel } from "./types";

interface ThreadMessageProps {
  message: ThreadMessageModel;
  customerName: string;
  customerEmail: string;
  attachments: AttachmentSummary[];
}

const deliveryLabels: Record<string, string> = { queued: "Queued", sent: "Sent", failed: "Failed" };

export function ThreadMessage({ message, customerName, customerEmail, attachments }: ThreadMessageProps) {
  if (message.authorType === "system") {
    return (
      <article className="thread-entry system">
        <span>{message.bodyText}</span>
        <time>{formatDate(message.createdAt)}</time>
      </article>
    );
  }
  const fromCustomer = message.authorType === "customer";
  // Only agent messages carry a user to name; anything else the server left
  // unattributed reads as the system acting on the workspace's behalf.
  const author = fromCustomer ? customerName : (message.authorName ?? "System");
  const delivery =
    message.authorType === "agent" && message.kind === "message" ? deliveryLabels[message.deliveryStatus] : undefined;
  return (
    <article className={`thread-entry ${message.kind === "internal_note" ? "note" : message.authorType}`}>
      <header>
        <div className="message-avatar">{author.slice(0, 1)}</div>
        <div>
          <strong>{author}</strong>
          <span>
            {message.kind === "internal_note" ? "Internal note" : fromCustomer ? customerEmail : "Agent reply"}
          </span>
        </div>
        <time>{formatDate(message.createdAt)}</time>
      </header>
      {/* The server sanitises agent HTML on the way in; customer mail stays text. */}
      {message.authorType === "agent" && message.bodyHtml ? (
        <div className="thread-body" dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
      ) : (
        <p>{message.bodyText}</p>
      )}
      {delivery && (
        <span className={`delivery-badge ${message.deliveryStatus}`} title={message.deliveryError ?? undefined}>
          {delivery}
        </span>
      )}
      {attachments.map((file) => (
        <a className="message-attachment" key={file.id} href={`/api/attachments/${file.id}`}>
          <Paperclip size={13} />
          {file.filename}
          <small>{formatBytes(file.size)}</small>
        </a>
      ))}
    </article>
  );
}
