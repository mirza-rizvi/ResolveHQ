import { lazy, Suspense, type FormEvent } from "react";
import { Paperclip, Send, StickyNote } from "lucide-react";
import { Button } from "@/web/components/ui";
import type { MessageKind, SavedReply } from "./types";

const RichComposer = lazy(() => import("@/web/components/rich-composer").then((module) => ({ default: module.RichComposer })));

interface ComposerProps {
  formRef: React.RefObject<HTMLFormElement | null>;
  kind: MessageKind;
  onKindChange: (kind: MessageKind) => void;
  savedReplies: SavedReply[];
  body: string;
  onBodyChange: (text: string) => void;
  onInsertSavedReply: (content: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  error: string;
  attachment: File | null;
  onAttachmentChange: (file: File | null) => void;
  customerName: string;
}

export function Composer({
  formRef, kind, onKindChange, savedReplies, body, onBodyChange, onInsertSavedReply,
  onSubmit, error, attachment, onAttachmentChange, customerName,
}: ComposerProps) {
  return <form ref={formRef} className={kind === "internal_note" ? "composer note-mode" : "composer"} onSubmit={onSubmit}>
    <div className="composer-tabs">
      <label>
        <input type="radio" name="kind" value="message" checked={kind === "message"} onChange={() => onKindChange("message")} />
        <Send size={14} />Reply <kbd>R</kbd>
      </label>
      <label>
        <input type="radio" name="kind" value="internal_note" checked={kind === "internal_note"} onChange={() => onKindChange("internal_note")} />
        <StickyNote size={14} />Internal note <kbd>P</kbd>
      </label>
      <select
        aria-label="Insert saved reply"
        value=""
        onChange={(event) => {
          const reply = savedReplies.find((item) => item.id === event.target.value);
          if (reply) onInsertSavedReply(reply.content);
        }}
      >
        <option value="">Saved replies</option>
        {savedReplies.map((reply) => <option key={reply.id} value={reply.id}>{reply.name}</option>)}
      </select>
    </div>
    <Suspense fallback={<div className="rich-composer-loading" aria-label="Loading editor" />}>
      <RichComposer
        value={body}
        onChange={(text) => onBodyChange(text)}
        onSubmit={() => formRef.current?.requestSubmit()}
        placeholder={kind === "internal_note" ? "Add context for your team…" : `Reply to ${customerName}…`}
      />
    </Suspense>
    {error && <p className="composer-error">{error}</p>}
    <footer>
      <label className="attach-button">
        <Paperclip size={16} />{attachment ? attachment.name : "Attach"}
        <input type="file" onChange={(event) => onAttachmentChange(event.target.files?.[0] ?? null)} />
      </label>
      <span>⌘ Enter</span>
      <Button type="submit" size="small" disabled={!body.trim()}>{kind === "internal_note" ? "Add note" : "Send reply"}</Button>
    </footer>
  </form>;
}
