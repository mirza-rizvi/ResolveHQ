import { type FormEvent } from "react";
import { ArrowLeft, Check, MessageSquareText, PanelRightOpen, X } from "lucide-react";
import { Button } from "@/web/components/ui";
import { Composer } from "./composer";
import { ThreadMessage } from "./thread-message";
import type { Conversation as ConversationModel, Member, MessageKind, SavedReply, Tag, Team } from "./types";

interface ConversationPanelProps {
  conversation: ConversationModel | null;
  agentName: string;
  members: Member[];
  teams: Team[];
  availableTags: Tag[];
  savedReplies: SavedReply[];
  onBack: () => void;
  onUpdate: (changes: Record<string, unknown>) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onOpenCustomer: () => void;
  composerFormRef: React.RefObject<HTMLFormElement | null>;
  messageKind: MessageKind;
  onMessageKindChange: (kind: MessageKind) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  onInsertSavedReply: (content: string) => void;
  onSubmitMessage: (event: FormEvent<HTMLFormElement>) => void;
  composerError: string;
  attachment: File | null;
  onAttachmentChange: (file: File | null) => void;
}

export function ConversationPanel({
  conversation, agentName, members, teams, availableTags, savedReplies, onBack, onUpdate, onAddTag, onRemoveTag,
  onOpenCustomer, composerFormRef, messageKind, onMessageKindChange, draft, onDraftChange, onInsertSavedReply,
  onSubmitMessage, composerError, attachment, onAttachmentChange,
}: ConversationPanelProps) {
  return <section className="conversation-panel" aria-label="Selected conversation">
    {!conversation
      ? <div className="conversation-empty">
        <MessageSquareText size={22} />
        <h2>Select a ticket</h2>
        <p>Open a row from the rundown to read and reply.</p>
      </div>
      : <>
        <header className="conversation-header">
          <button className="mobile-back" onClick={onBack} aria-label="Back to ticket list"><ArrowLeft size={18} /></button>
          <div>
            <p className="ticket-reference">#{conversation.ticket.number}</p>
            <h1>{conversation.ticket.subject}</h1>
          </div>
          <div className="conversation-actions">
            <Button variant="secondary" size="small" disabled={conversation.ticket.status === "resolved"} onClick={() => onUpdate({ status: "resolved" })}>
              <Check size={14} />{conversation.ticket.status === "resolved" ? "Resolved" : "Resolve"}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Customer details" title="Customer details" onClick={onOpenCustomer}><PanelRightOpen size={17} /></Button>
          </div>
        </header>
        <div className="conversation-context">
          <label>
            <span>Status</span>
            <select aria-label="Ticket status" value={conversation.ticket.status} onChange={(event) => onUpdate({ status: event.target.value })}>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="waiting_customer">Waiting</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select value={conversation.ticket.priority} onChange={(event) => onUpdate({ priority: event.target.value })}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            <span>Assignee</span>
            <select value={conversation.ticket.assignedUserId ?? ""} onChange={(event) => onUpdate({ assignedUserId: event.target.value || null })}>
              <option value="">Unassigned</option>
              {members.filter((member) => !member.disabledAt).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label className="team-control">
            <span>Team</span>
            <select value={conversation.ticket.assignedTeamId ?? ""} onChange={(event) => onUpdate({ assignedTeamId: event.target.value || null })}>
              <option value="">No team</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          <div className="context-tags">
            <span>Tags</span>
            <div>
              {conversation.tags.map((tag) => <button key={tag.id} type="button" className={`tag-chip tag-${tag.color}`} onClick={() => onRemoveTag(tag.id)} title={`Remove ${tag.name}`}>
                {tag.name}<X size={10} />
              </button>)}
              <select aria-label="Add tag" value="" onChange={(event) => onAddTag(event.target.value)}>
                <option value="">Add tag</option>
                {availableTags.filter((tag) => !conversation.tags.some((current) => current.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="thread">
          {conversation.messages.map((message) => <ThreadMessage
            key={message.id}
            message={message}
            customerName={conversation.ticket.customerName}
            customerEmail={conversation.ticket.customerEmail}
            agentName={agentName}
            attachments={conversation.attachments.filter((file) => file.messageId === message.id)}
          />)}
        </div>
        <Composer
          formRef={composerFormRef}
          kind={messageKind}
          onKindChange={onMessageKindChange}
          savedReplies={savedReplies}
          body={draft}
          onBodyChange={onDraftChange}
          onInsertSavedReply={onInsertSavedReply}
          onSubmit={onSubmitMessage}
          error={composerError}
          attachment={attachment}
          onAttachmentChange={onAttachmentChange}
          customerName={conversation.ticket.customerName}
        />
      </>}
  </section>;
}
