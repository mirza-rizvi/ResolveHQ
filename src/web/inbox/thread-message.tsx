import { useState } from "react";
import { Languages, Paperclip } from "lucide-react";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";
import { formatBytes, formatDate } from "./format";
import { translationLanguages } from "./languages";
import type { AttachmentSummary, ThreadMessage as ThreadMessageModel } from "./types";

interface ThreadMessageProps {
  message: ThreadMessageModel;
  customerName: string;
  customerEmail: string;
  attachments: AttachmentSummary[];
  /** Translation is offered only where the workspace has opted into AI. */
  aiEnabled?: boolean;
}

const deliveryLabels: Record<string, string> = { queued: "Queued", sent: "Sent", failed: "Failed" };

export function ThreadMessage({
  message,
  customerName,
  customerEmail,
  attachments,
  aiEnabled = false,
}: ThreadMessageProps) {
  const toast = useToast();
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [translation, setTranslation] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);

  async function translate() {
    setTranslating(true);
    try {
      const result = await api<{ translation: string }>("/assistant/translate", {
        method: "POST",
        // Always sent by id, so re-translating works from the stored original, never from a translation.
        body: JSON.stringify({
          ticketId: message.ticketId,
          messageId: message.id,
          targetLanguage,
          ...(sourceLanguage ? { sourceLanguage } : {}),
        }),
      });
      setTranslation(result.translation);
      setShowOriginal(false);
    } catch (reason) {
      toast.push(errorMessage(reason, "The message could not be translated."), "error");
    } finally {
      setTranslating(false);
    }
  }

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
      {(translation === null || showOriginal) &&
        (message.authorType === "agent" && message.bodyHtml ? (
          <div className="thread-body" dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
        ) : (
          <p>{message.bodyText}</p>
        ))}
      {translation !== null && (
        <div className="thread-translation">
          <p>{translation}</p>
          <button type="button" onClick={() => setShowOriginal((current) => !current)}>
            {showOriginal ? "Hide original" : "Show original"}
          </button>
        </div>
      )}
      {aiEnabled && message.bodyText.trim() && (
        <div className="thread-translate">
          <Languages size={13} />
          <select
            aria-label="Translate message from"
            value={sourceLanguage}
            onChange={(event) => setSourceLanguage(event.target.value)}
          >
            <option value="">From: auto</option>
            {translationLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                From: {language.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Translate message into"
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
          >
            {translationLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
          <button type="button" disabled={translating} onClick={() => void translate()}>
            {translating ? "Translating…" : translation === null ? "Translate" : "Translate again"}
          </button>
        </div>
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
