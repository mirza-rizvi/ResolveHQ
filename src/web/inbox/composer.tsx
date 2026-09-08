import { lazy, Suspense, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Paperclip, Send, Sparkles, StickyNote, X } from "lucide-react";
import { useToast } from "@/web/components/toast";
import type { RichComposerHandle } from "@/web/components/rich-composer";
import { api as apiClient } from "@/web/lib/api";
import { Button } from "@/web/components/ui";
import type { DraftStatus } from "@/web/hooks/use-draft";
import { api, errorMessage } from "@/web/lib/api";
import { attachmentAccept, maxAttachmentSize, resolveContentType } from "./attachments";
import { formatBytes, formatClock } from "./format";
import type { MessageKind, SavedReply } from "./types";

const RichComposer = lazy(() =>
  import("@/web/components/rich-composer").then((module) => ({ default: module.RichComposer })),
);

interface PendingAttachment {
  uid: string;
  id: string | null;
  name: string;
  size: number;
}

interface ComposerProps {
  formRef: React.RefObject<HTMLFormElement | null>;
  ticketId: string;
  kind: MessageKind;
  onKindChange: (kind: MessageKind) => void;
  savedReplies: SavedReply[];
  body: string;
  onBodyChange: (text: string, html: string) => void;
  onSend: (input: { attachmentIds: string[] }) => Promise<void>;
  sending: boolean;
  draftStatus: DraftStatus;
  draftSavedAt: Date | null;
  customerName: string;
}

export function Composer({
  formRef,
  ticketId,
  kind,
  onKindChange,
  savedReplies,
  body,
  onBodyChange,
  onSend,
  sending,
  draftStatus,
  draftSavedAt,
  customerName,
}: ComposerProps) {
  const toast = useToast();
  const editorRef = useRef<RichComposerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const aiQuery = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => apiClient<{ ai: { enabled: boolean } }>("/organization/settings"),
    staleTime: 5 * 60_000,
  });
  const uploading = attachments.some((file) => !file.id);
  const aiEnabled = aiQuery.data?.ai.enabled === true;

  async function upload(file: File) {
    if (file.size > maxAttachmentSize) {
      toast.push("Files must be smaller than 15 MB.", "error");
      return;
    }
    const contentType = resolveContentType(file);
    if (!contentType) {
      toast.push("This file type is not supported.", "error");
      return;
    }
    const uid = crypto.randomUUID();
    setAttachments((current) => [...current, { uid, id: null, name: file.name, size: file.size }]);
    try {
      // The upload happens now, not at send: the row stays unlinked until the
      // message that names it is created, and the sweep collects it otherwise.
      const intent = await api<{ upload: { attachmentId: string; url: string } }>("/attachments/intents", {
        method: "POST",
        body: JSON.stringify({ ticketId, filename: file.name, contentType, size: file.size }),
      });
      await api(intent.upload.url.replace(/^\/api/, ""), {
        method: "PUT",
        headers: { "content-type": contentType },
        body: file,
      });
      setAttachments((current) =>
        current.map((entry) => (entry.uid === uid ? { ...entry, id: intent.upload.attachmentId } : entry)),
      );
    } catch (reason) {
      setAttachments((current) => current.filter((entry) => entry.uid !== uid));
      toast.push(errorMessage(reason, "The file could not be uploaded."), "error");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim() || uploading || sending) return;
    const attachmentIds = attachments.map((file) => file.id).filter((id): id is string => Boolean(id));
    try {
      await onSend({ attachmentIds });
      setAttachments([]);
    } catch {
      /* the mutation reports the failure and the draft is kept */
    }
  }

  function insertSavedReply(id: string) {
    const reply = savedReplies.find((item) => item.id === id);
    if (!reply) return;
    if (editorRef.current) editorRef.current.insertText(reply.content);
    else onBodyChange(body ? `${body}\n\n${reply.content}` : reply.content, "");
  }
  const [aiBusy, setAiBusy] = useState<"draft" | "summarize" | null>(null);
  const [summary, setSummary] = useState("");
  async function requestAssistant(action: "draft" | "summarize") {
    setAiBusy(action);
    try {
      const result = await api<{ draft?: string; summary?: string }>(`/assistant/${action}`, {
        method: "POST",
        body: JSON.stringify({ ticketId }),
      });
      if (action === "draft" && result.draft) {
        if (editorRef.current) editorRef.current.insertText(result.draft);
        else onBodyChange(result.draft, "");
      } else if (result.summary) setSummary(result.summary);
    } catch (reason) {
      toast.push(errorMessage(reason, "AI assistance is unavailable."), "error");
    } finally {
      setAiBusy(null);
    }
  }

  return (
    <form
      ref={formRef}
      className={kind === "internal_note" ? "composer note-mode" : "composer"}
      onSubmit={(event) => void submit(event)}
    >
      <div className="composer-tabs">
        <label>
          <input
            type="radio"
            name="kind"
            value="message"
            checked={kind === "message"}
            onChange={() => onKindChange("message")}
          />
          <Send size={14} />
          Reply <kbd>R</kbd>
        </label>
        <label>
          <input
            type="radio"
            name="kind"
            value="internal_note"
            checked={kind === "internal_note"}
            onChange={() => onKindChange("internal_note")}
          />
          <StickyNote size={14} />
          Internal note <kbd>P</kbd>
        </label>
        <select aria-label="Insert saved reply" value="" onChange={(event) => insertSavedReply(event.target.value)}>
          <option value="">Saved replies</option>
          {savedReplies.map((reply) => (
            <option key={reply.id} value={reply.id}>
              {reply.name}
            </option>
          ))}
        </select>
        <span className="composer-ai">
          {aiEnabled && kind === "message" && (
            <button type="button" disabled={aiBusy !== null} onClick={() => void requestAssistant("draft")}>
              <Sparkles size={13} />
              {aiBusy === "draft" ? "Drafting…" : "AI draft"}
            </button>
          )}
          {aiEnabled && (
            <button type="button" disabled={aiBusy !== null} onClick={() => void requestAssistant("summarize")}>
              {aiBusy === "summarize" ? "Summarizing…" : "Summarize"}
            </button>
          )}
        </span>
      </div>
      {summary && (
        <aside className="ai-summary" aria-label="Conversation summary">
          <header>
            <Sparkles size={13} />
            Summary
            <button type="button" aria-label="Dismiss summary" onClick={() => setSummary("")}>
              <X size={12} />
            </button>
          </header>
          <p>{summary}</p>
        </aside>
      )}
      <Suspense fallback={<div className="rich-composer-loading" aria-label="Loading editor" />}>
        <RichComposer
          ref={editorRef}
          value={body}
          onChange={onBodyChange}
          onSubmit={() => formRef.current?.requestSubmit()}
          placeholder={kind === "internal_note" ? "Add context for your team…" : `Reply to ${customerName}…`}
        />
      </Suspense>
      <p className="draft-status" aria-live="polite">
        {draftLabel(draftStatus, draftSavedAt)}
      </p>
      {attachments.length > 0 && (
        <div className="attachment-chips">
          {attachments.map((file) => (
            <span key={file.uid} className={file.id ? "attachment-chip" : "attachment-chip uploading"}>
              {file.id ? <Paperclip size={12} /> : <Loader2 size={12} className="spin" />}
              <span>{file.name}</span>
              <small>{file.id ? formatBytes(file.size) : "Uploading…"}</small>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setAttachments((current) => current.filter((entry) => entry.uid !== file.uid))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <footer>
        <label className="attach-button">
          <Paperclip size={16} />
          Attach
          <input
            ref={fileInput}
            type="file"
            accept={attachmentAccept}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
        </label>
        <span>⌘ Enter</span>
        <Button type="submit" size="small" disabled={uploading || sending || !body.trim()}>
          {kind === "internal_note" ? "Add note" : "Send reply"}
        </Button>
      </footer>
    </form>
  );
}

function draftLabel(status: DraftStatus, savedAt: Date | null) {
  if (status === "saving") return "Saving…";
  if (status === "error") return "Draft could not be saved";
  if (status === "saved" && savedAt) return `Draft saved · ${formatClock(savedAt)}`;
  return "";
}
