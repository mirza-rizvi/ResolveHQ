import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, ArrowLeft, Check, ChevronDown, CircleDot, Clock3, Inbox as InboxIcon, MessageSquareText, Paperclip, Plus, Search, Send, StickyNote, UserRound, Users, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/web/lib/api";
import { Badge, Button } from "@/web/components/ui";
import { useAuth } from "@/web/auth";

interface TicketSummary { id: string; number: number; subject: string; status: string; priority: string; assignedUserId: string | null; assigneeName: string | null; customerId: string; customerName: string; customerEmail: string; lastReplyAt: string | null; updatedAt: string }
interface Conversation { ticket: TicketSummary & { customerCompany?: string; createdAt: string }; messages: Array<{ id: string; authorType: string; kind: "message" | "internal_note"; bodyText: string; createdAt: string; authorUserId?: string }>; tags: Tag[]; attachments: Array<{ id: string; messageId: string; filename: string; contentType: string; size: number }> }
interface Member { id: string; name: string; email: string; role: string; disabledAt: string | null }
interface CustomerOption { id: string; name: string; email: string }
interface Tag { id: string; name: string; color: string }
interface SavedReply { id: string; name: string; content: string; category: string | null }

const queueNavigation = [
  ["open", "Open", InboxIcon], ["unassigned", "Unassigned", Users], ["mine", "Mine", UserRound],
  ["waiting_customer", "Waiting", Clock3], ["resolved", "Resolved", Check], ["closed", "Closed", Archive],
] as const;

export function InboxPage() {
  const { ticketId } = useParams(); const navigate = useNavigate(); const { session } = useAuth();
  const [params, setParams] = useSearchParams(); const queue = params.get("queue") ?? "open";
  const [tickets, setTickets] = useState<TicketSummary[]>([]); const [conversation, setConversation] = useState<Conversation | null>(null); const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]); const [availableTags, setAvailableTags] = useState<Tag[]>([]); const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [createOpen, setCreateOpen] = useState(false); const [draft, setDraft] = useState(""); const [messageKind, setMessageKind] = useState<"message" | "internal_note">("message"); const [attachment, setAttachment] = useState<File | null>(null); const [composerError, setComposerError] = useState("");
  const loadTickets = useCallback(async () => {
    setLoading(true); setError("");
    const search = new URLSearchParams();
    if (["open", "waiting_customer", "resolved", "closed"].includes(queue)) search.set("status", queue);
    if (queue === "unassigned") search.set("assignee", "unassigned");
    if (queue === "mine") search.set("assignee", "me");
    if (query.trim()) search.set("q", query.trim());
    try { const result = await api<{ tickets: TicketSummary[] }>(`/tickets?${search}`); setTickets(result.tickets); if (!ticketId && result.tickets[0] && !window.matchMedia("(max-width: 900px)").matches) navigate(`/inbox/${result.tickets[0].id}?${params}`, { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the queue."); }
    finally { setLoading(false); }
  }, [queue, query, ticketId, navigate, params]);
  useEffect(() => { const timeout = window.setTimeout(() => void loadTickets(), query ? 250 : 0); return () => window.clearTimeout(timeout); }, [loadTickets, query]);
  useEffect(() => { void Promise.all([
    api<{ members: Member[] }>("/organization/members").then((result) => setMembers(result.members)),
    api<{ customers: CustomerOption[] }>("/customers").then((result) => setCustomers(result.customers)),
    api<{ tags: Tag[] }>("/tags").then((result) => setAvailableTags(result.tags)),
    api<{ savedReplies: SavedReply[] }>("/saved-replies").then((result) => setSavedReplies(result.savedReplies)),
  ]).catch(() => setError("Some workspace controls could not be loaded.")); }, []);
  useEffect(() => { if (!ticketId) { setConversation(null); return; } void api<Conversation>(`/tickets/${ticketId}`).then(setConversation).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open the conversation.")); }, [ticketId]);
  async function updateTicket(values: Record<string, unknown>) {
    if (!ticketId) return;
    await api(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify(values) }); await Promise.all([loadTickets(), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]);
  }
  async function addMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ticketId || !draft.trim()) return; setComposerError("");
    try {
      const result = await api<{ message: { id: string } }>(`/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ body: draft.trim(), kind: messageKind }) });
      if (attachment) { const form = new FormData(); form.set("file", attachment); form.set("ticketId", ticketId); form.set("messageId", result.message.id); await api("/attachments", { method: "POST", body: form }); }
      setDraft(""); setAttachment(null); await Promise.all([loadTickets(), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]);
    } catch (reason) { setComposerError(reason instanceof Error ? reason.message : "The message could not be sent."); }
  }
  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setError("");
    try { const result = await api<{ ticket: { id: string } }>("/tickets", { method: "POST", body: JSON.stringify({ customerId: data.get("customerId"), subject: data.get("subject"), message: data.get("message"), priority: data.get("priority") }) }); setCreateOpen(false); await loadTickets(); navigate(`/inbox/${result.ticket.id}?queue=open`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The ticket could not be created."); }
  }
  async function addTag(tagId: string) {
    if (!ticketId || !tagId) return; await api(`/tickets/${ticketId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }); setConversation(await api<Conversation>(`/tickets/${ticketId}`));
  }
  async function removeTag(tagId: string) {
    if (!ticketId) return; await api(`/tickets/${ticketId}/tags/${tagId}`, { method: "DELETE" }); setConversation(await api<Conversation>(`/tickets/${ticketId}`));
  }

  return <div className="inbox-layout">
    <aside className="queue-panel">
      <header><h1>Inbox</h1><Button size="small" onClick={() => setCreateOpen(true)}><Plus size={14} />New ticket</Button></header>
      <nav aria-label="Inbox queues">{queueNavigation.map(([key, label, Icon]) => <button key={key} className={queue === key ? "queue-link active" : "queue-link"} onClick={() => { setParams({ queue: key }); navigate(`/inbox?queue=${key}`); }}><Icon size={16} /><span>{label}</span>{key === "open" && <b>{tickets.length}</b>}</button>)}</nav>
      <div className="queue-rule" />
      <button className="queue-link"><CircleDot size={16} /><span>All tickets</span></button>
      <footer><span className="presence-dot" />{session?.user.name} is online</footer>
    </aside>

    <section className="ticket-ledger" aria-label="Ticket list">
      <header className="ledger-toolbar"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this queue" aria-label="Search tickets" /></label><button className="filter-button">Newest <ChevronDown size={14} /></button></header>
      <div className="ledger-heading"><span>{queue.replace("_", " ")}</span><span>{tickets.length} conversations</span></div>
      <div className="ticket-rows">{loading ? <LedgerSkeleton /> : error ? <EmptyLedger title="Queue unavailable" detail={error} /> : tickets.length === 0 ? <EmptyLedger title="Nothing waiting here" detail="This queue is clear. New conversations will appear automatically." /> : tickets.map((ticket) => <Link key={ticket.id} to={`/inbox/${ticket.id}?${params}`} className={ticket.id === ticketId ? "ticket-row selected" : "ticket-row"}>
        <div className="ticket-row-top"><strong>{ticket.customerName}</strong><time>{relativeTime(ticket.updatedAt)}</time></div>
        <h2>{ticket.subject}</h2><p>#{ticket.number} · {ticket.customerEmail}</p>
        <div className="ticket-row-meta"><Priority value={ticket.priority} /><span>{ticket.assigneeName ?? "Unassigned"}</span></div>
      </Link>)}</div>
    </section>

    <section className="conversation-panel" aria-label="Selected conversation">
      {!conversation ? <div className="conversation-empty"><MessageSquareText size={24} /><h2>Select a conversation</h2><p>Choose a ticket to read its history and respond.</p></div> : <>
        <header className="conversation-header"><button className="mobile-back" onClick={() => navigate(`/inbox?${params}`)} aria-label="Back to ticket list"><ArrowLeft size={18} /></button><div><h1>{conversation.ticket.subject}</h1><p><span className="ticket-reference">Ticket #{conversation.ticket.number}</span> · {conversation.ticket.customerName} · {conversation.ticket.customerEmail}</p></div><div className="conversation-actions"><select aria-label="Ticket status" value={conversation.ticket.status} onChange={(event) => void updateTicket({ status: event.target.value })}><option value="open">Open</option><option value="pending">Pending</option><option value="waiting_customer">Waiting for customer</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><Button size="small" onClick={() => void updateTicket({ status: "resolved" })}><Check size={15} />Resolve</Button></div></header>
        <div className="conversation-context"><label>Assigned<select value={conversation.ticket.assignedUserId ?? ""} onChange={(event) => void updateTicket({ assignedUserId: event.target.value || null })}><option value="">Unassigned</option>{members.filter((member) => !member.disabledAt).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Priority<select value={conversation.ticket.priority} onChange={(event) => void updateTicket({ priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><div className="context-tags"><span>Tags</span>{conversation.tags.map((tag) => <button key={tag.id} type="button" className={`tag-chip tag-${tag.color}`} onClick={() => void removeTag(tag.id)} title={`Remove ${tag.name}`}><span>{tag.name}</span><X size={10} /></button>)}<select aria-label="Add tag" value="" onChange={(event) => void addTag(event.target.value)}><option value="">+ Add</option>{availableTags.filter((tag) => !conversation.tags.some((current) => current.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div></div>
        <div className="thread">{conversation.messages.map((message) => <article key={message.id} className={`thread-entry ${message.kind === "internal_note" ? "note" : message.authorType}`}><header><div className="message-avatar">{message.authorType === "customer" ? conversation.ticket.customerName.slice(0, 1) : session?.user.name.slice(0, 1)}</div><div><strong>{message.authorType === "customer" ? conversation.ticket.customerName : message.kind === "internal_note" ? `${session?.user.name} · private note` : session?.user.name}</strong><time>{formatDate(message.createdAt)}</time></div>{message.kind === "internal_note" && <Badge tone="amber">Internal</Badge>}</header><p>{message.bodyText}</p>{conversation.attachments.filter((file) => file.messageId === message.id).map((file) => <a className="message-attachment" key={file.id} href={`/api/attachments/${file.id}`}><Paperclip size={13} />{file.filename}<small>{formatBytes(file.size)}</small></a>)}</article>)}</div>
        <form className="composer" onSubmit={addMessage}><div className="composer-tabs"><label><input type="radio" name="kind" value="message" checked={messageKind === "message"} onChange={() => setMessageKind("message")} /><Send size={14} />Reply</label><label><input type="radio" name="kind" value="internal_note" checked={messageKind === "internal_note"} onChange={() => setMessageKind("internal_note")} /><StickyNote size={14} />Internal note</label><select aria-label="Insert saved reply" value="" onChange={(event) => { const reply = savedReplies.find((item) => item.id === event.target.value); if (reply) setDraft((current) => current ? `${current}\n\n${reply.content}` : reply.content); }}><option value="">Saved replies</option>{savedReplies.map((reply) => <option key={reply.id} value={reply.id}>{reply.name}</option>)}</select></div><textarea name="body" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); }} placeholder={`Reply to ${conversation.ticket.customerName}…`} aria-label="Reply message" required />{composerError && <p className="composer-error">{composerError}</p>}<footer><label className="attach-button"><Paperclip size={16} />{attachment ? attachment.name : "Attach"}<input type="file" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} /></label><span>⌘ Enter to send</span><Button type="submit" size="small">{messageKind === "internal_note" ? "Add note" : "Send reply"}</Button></footer></form>
      </>}
    </section>
    {createOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}><form className="dialog-card" onSubmit={createTicket}><header><div><h2>Start a conversation</h2><p>Create a customer request directly in the support ledger.</p></div><button type="button" onClick={() => setCreateOpen(false)} aria-label="Close"><X size={18} /></button></header><label>Customer<select name="customerId" required defaultValue=""><option value="" disabled>Select a customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.email}</option>)}</select></label><label>Subject<input name="subject" maxLength={240} required /></label><label>Initial message<textarea name="message" rows={5} required /></label><label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><footer><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit">Create ticket</Button></footer></form></div>}
  </div>;
}

function Priority({ value }: { value: string }) { return <span className={`priority priority-${value}`}><i />{value}</span>; }
function relativeTime(value: string) { const diff = Date.now() - new Date(value).getTime(); const hours = Math.floor(diff / 3_600_000); if (hours < 1) return `${Math.max(1, Math.floor(diff / 60_000))}m`; if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1_048_576 ? `${Math.round(value / 1024)} KB` : `${(value / 1_048_576).toFixed(1)} MB`; }
function LedgerSkeleton() { return <div className="ledger-skeleton" aria-label="Loading tickets"><span /><span /><span /><span /></div>; }
function EmptyLedger({ title, detail }: { title: string; detail: string }) { return <div className="empty-ledger"><h2>{title}</h2><p>{detail}</p></div>; }
