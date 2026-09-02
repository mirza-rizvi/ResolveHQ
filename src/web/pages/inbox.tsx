import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, ArrowLeft, Check, CircleDot, Clock3, Inbox as InboxIcon, MessageSquareText, PanelRightOpen, Paperclip, Plus, Search, Send, SlidersHorizontal, StickyNote, UserRound, Users, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/web/lib/api";
import { Button } from "@/web/components/ui";
import { useAuth } from "@/web/auth";
import { useDialogFocus } from "@/web/hooks/use-dialog-focus";

interface TicketSummary { id: string; number: number; subject: string; status: string; priority: string; assignedUserId: string | null; assignedTeamId: string | null; assigneeName: string | null; customerId: string; customerName: string; customerEmail: string; lastReplyAt: string | null; updatedAt: string; version: number; preview?: string; unread?: boolean; tags?: Tag[] }
interface Conversation { ticket: TicketSummary & { customerCompany?: string; createdAt: string }; messages: Array<{ id: string; authorType: string; kind: "message" | "internal_note"; bodyText: string; createdAt: string; authorUserId?: string }>; tags: Tag[]; attachments: Array<{ id: string; messageId: string; filename: string; contentType: string; size: number }> }
interface Member { id: string; name: string; email: string; role: string; disabledAt: string | null }
interface CustomerOption { id: string; name: string; email: string }
interface CustomerDetail { customer: { id: string; name: string; email: string; company: string | null; phone: string | null; notes: string | null; createdAt: string }; tickets: Array<{ id: string; number: number; subject: string; status: string; updatedAt: string }> }
interface Tag { id: string; name: string; color: string }
interface SavedReply { id: string; name: string; content: string; category: string | null }
interface Team { id: string; name: string; memberCount: number }
interface SavedView { id: string; name: string; filters: { status?: string; priority?: string; assignee?: string }; visibility: "personal" | "shared" }

const queueNavigation = [
  ["open", "Open", InboxIcon], ["unassigned", "Unassigned", Users], ["mine", "Mine", UserRound],
  ["waiting_customer", "Waiting", Clock3], ["resolved", "Resolved", Check], ["closed", "Closed", Archive],
] as const;
const RichComposer = lazy(() => import("@/web/components/rich-composer").then((module) => ({ default: module.RichComposer })));

export function InboxPage() {
  const { ticketId } = useParams(); const navigate = useNavigate(); const { session } = useAuth();
  const [params, setParams] = useSearchParams(); const queue = params.get("queue") ?? "open";
  const [tickets, setTickets] = useState<TicketSummary[]>([]); const [conversation, setConversation] = useState<Conversation | null>(null); const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]); const [availableTags, setAvailableTags] = useState<Tag[]>([]); const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]); const [teams, setTeams] = useState<Team[]>([]); const [savedViews, setSavedViews] = useState<SavedView[]>([]); const [selectedTickets, setSelectedTickets] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false); const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null); const [draft, setDraft] = useState(""); const [messageKind, setMessageKind] = useState<"message" | "internal_note">("message"); const [attachment, setAttachment] = useState<File | null>(null); const [composerError, setComposerError] = useState("");
  const draftRevision = useRef(0); const hydratedDraftTicket = useRef(""); const draftWrites = useRef(Promise.resolve()); const composerForm = useRef<HTMLFormElement>(null); const searchInput = useRef<HTMLInputElement>(null);
  const closeCustomerDetail = useCallback(() => setCustomerDetail(null), []); const closeCreateDialog = useCallback(() => setCreateOpen(false), []);
  const customerDialogRef = useDialogFocus<HTMLElement>(Boolean(customerDetail), closeCustomerDetail); const createDialogRef = useDialogFocus<HTMLFormElement>(createOpen, closeCreateDialog);
  const loadTickets = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError("");
    const search = new URLSearchParams();
    if (["open", "waiting_customer", "resolved", "closed"].includes(queue)) search.set("status", queue);
    if (queue === "unassigned") search.set("assignee", "unassigned");
    if (queue === "mine") search.set("assignee", "me");
    if (params.get("priority")) search.set("priority", params.get("priority")!);
    if (query.trim()) search.set("q", query.trim());
    try { const result = await api<{ tickets: TicketSummary[] }>(`/tickets?${search}`); setTickets(result.tickets); if (!ticketId && result.tickets[0] && !window.matchMedia("(max-width: 900px)").matches) navigate(`/inbox/${result.tickets[0].id}?${params}`, { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the queue."); }
    finally { if (!silent) setLoading(false); }
  }, [queue, query, ticketId, navigate, params]);
  useEffect(() => { const timeout = window.setTimeout(() => void loadTickets(), query ? 250 : 0); return () => window.clearTimeout(timeout); }, [loadTickets, query]);
  useEffect(() => {
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void loadTickets(true); }, document.visibilityState === "visible" ? 15_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [loadTickets]);
  useEffect(() => { void Promise.all([
    api<{ members: Member[] }>("/organization/members").then((result) => setMembers(result.members)),
    api<{ customers: CustomerOption[] }>("/customers").then((result) => setCustomers(result.customers)),
    api<{ tags: Tag[] }>("/tags").then((result) => setAvailableTags(result.tags)),
    api<{ savedReplies: SavedReply[] }>("/saved-replies").then((result) => setSavedReplies(result.savedReplies)),
    api<{ teams: Team[] }>("/operations/teams").then((result) => setTeams(result.teams)),
    api<{ views: SavedView[] }>("/operations/views").then((result) => setSavedViews(result.views)),
  ]).catch(() => setError("Some workspace controls could not be loaded.")); }, []);
  useEffect(() => { if (!ticketId) { setConversation(null); return; } void api<Conversation>(`/tickets/${ticketId}`).then(setConversation).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open the conversation.")); }, [ticketId]);
  useEffect(() => {
    hydratedDraftTicket.current = ""; draftRevision.current = 0;
    if (!ticketId) { setDraft(""); return; }
    void api<{ draft: { body: string; kind: "message" | "internal_note"; revision: number } | null }>(`/operations/tickets/${ticketId}/draft`).then(({ draft: saved }) => {
      if (saved) { setDraft(saved.body); setMessageKind(saved.kind); draftRevision.current = saved.revision; }
      else { setDraft(""); setMessageKind("message"); }
      hydratedDraftTicket.current = ticketId;
    }).catch(() => { hydratedDraftTicket.current = ticketId; });
  }, [ticketId]);
  useEffect(() => {
    if (!ticketId || hydratedDraftTicket.current !== ticketId) return;
    const timeout = window.setTimeout(() => {
      draftWrites.current = draftWrites.current.then(async () => {
        const result = await api<{ draft: { revision: number } }>(`/operations/tickets/${ticketId}/draft`, { method: "PUT", body: JSON.stringify({ body: draft, kind: messageKind, revision: draftRevision.current }) });
        draftRevision.current = result.draft.revision;
      }).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [draft, messageKind, ticketId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "Escape") {
        if (customerDetail) { setCustomerDetail(null); return; }
        if (createOpen) { setCreateOpen(false); return; }
        if (ticketId && window.matchMedia("(max-width: 900px)").matches) navigate(`/inbox?${params}`);
        return;
      }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") { event.preventDefault(); searchInput.current?.focus(); return; }
      if ((event.key === "j" || event.key === "k") && tickets.length) {
        event.preventDefault();
        const current = Math.max(0, tickets.findIndex((item) => item.id === ticketId));
        const next = event.key === "j" ? Math.min(tickets.length - 1, current + 1) : Math.max(0, current - 1);
        navigate(`/inbox/${tickets[next].id}?${params}`);
        return;
      }
      if ((event.key === "r" || event.key === "p") && conversation) {
        event.preventDefault(); setMessageKind(event.key === "p" ? "internal_note" : "message");
        window.requestAnimationFrame(() => composerForm.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversation, createOpen, customerDetail, navigate, params, ticketId, tickets]);
  async function updateTicket(values: Record<string, unknown>) {
    if (!ticketId) return;
    await api(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ ...values, version: conversation?.ticket.version }) }); await Promise.all([loadTickets(true), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]);
  }
  async function addMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ticketId || !draft.trim()) return; setComposerError("");
    try {
      const result = await api<{ message: { id: string } }>(`/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ body: draft.trim(), kind: messageKind, clientMessageId: crypto.randomUUID() }) });
      if (attachment) {
        const intent = await api<{ upload: { url: string } }>("/attachments/intents", { method: "POST", body: JSON.stringify({ ticketId, messageId: result.message.id, filename: attachment.name, contentType: attachment.type, size: attachment.size }) });
        await api(intent.upload.url.replace(/^\/api/, ""), { method: "PUT", headers: { "content-type": attachment.type }, body: attachment });
      }
      hydratedDraftTicket.current = ""; setDraft(""); setAttachment(null); await api(`/operations/tickets/${ticketId}/draft`, { method: "DELETE" }); await Promise.all([loadTickets(true), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]); hydratedDraftTicket.current = ticketId;
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
  async function saveCurrentView() {
    const filters = queue === "unassigned" ? { assignee: "unassigned" } : queue === "mine" ? { assignee: "me" } : ["open", "waiting_customer", "resolved", "closed"].includes(queue) ? { status: queue } : {};
    const name = `${queue.replace("_", " ").replace(/^./, (value) => value.toUpperCase())} tickets`;
    const result = await api<{ view: SavedView }>("/operations/views", { method: "POST", body: JSON.stringify({ name, visibility: "personal", filters }) });
    setSavedViews((current) => [...current, result.view]);
  }
  function applyView(view: SavedView) {
    const next = new URLSearchParams();
    if (view.filters.status) next.set("queue", view.filters.status);
    else if (view.filters.assignee === "me") next.set("queue", "mine");
    else if (view.filters.assignee === "unassigned") next.set("queue", "unassigned");
    if (view.filters.priority) next.set("priority", view.filters.priority);
    navigate(`/inbox?${next}`);
  }
  async function bulkUpdate(values: Record<string, unknown>) {
    if (!selectedTickets.length) return;
    await api("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: selectedTickets, ...values }) });
    setSelectedTickets([]); await loadTickets(true);
  }
  async function openCustomerDetail() {
    if (!conversation) return;
    setCustomerDetail(await api<CustomerDetail>(`/customers/${conversation.ticket.customerId}`));
  }

  return <div className="inbox-layout">
    <aside className="queue-panel">
      <div className="queue-section-label">Queues</div>
      <nav aria-label="Inbox queues">{queueNavigation.map(([key, label, Icon]) => <button key={key} className={queue === key ? "queue-link active" : "queue-link"} onClick={() => { setParams({ queue: key }); navigate(`/inbox?queue=${key}`); }}><Icon size={16} /><span>{label}</span>{queue === key && <b>{tickets.length}</b>}</button>)}</nav>
      <div className="queue-section-label saved-heading"><span>Saved views</span><button type="button" onClick={() => void saveCurrentView()} aria-label="Save current view"><Plus size={14} /></button></div>
      <div className="saved-view-list">{savedViews.length ? savedViews.map((view) => <button key={view.id} onClick={() => applyView(view)}><CircleDot size={12} />{view.name}</button>) : <p>No saved views</p>}</div>
      <button className="manage-views" type="button" onClick={() => void saveCurrentView()}><SlidersHorizontal size={15} />Save this view</button>
    </aside>

    <section className="ticket-ledger" aria-label="Ticket rundown">
      <header className="rundown-header"><div className="queue-mobile-title"><strong>{queue.replace("_", " ")}</strong><select aria-label="Select queue" value={queue} onChange={(event) => navigate(`/inbox?queue=${event.target.value}`)}>{queueNavigation.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="rundown-title"><h1>Inbox</h1><span>{tickets.length} in {queue.replace("_", " ")}</span></div><Button size="small" onClick={() => setCreateOpen(true)}><Plus size={14} />New ticket</Button></header>
      <div className="rundown-toolbar">{selectedTickets.length ? <div className="bulk-toolbar"><strong>{selectedTickets.length} selected</strong><select aria-label="Bulk status" defaultValue="" onChange={(event) => { if (event.target.value) void bulkUpdate({ status: event.target.value }); }}><option value="">Set status…</option><option value="open">Open</option><option value="pending">Pending</option><option value="waiting_customer">Waiting</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><button onClick={() => setSelectedTickets([])}>Clear</button></div> : <label className="search-field"><Search size={16} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tickets" aria-label="Search tickets" /><kbd>/</kbd></label>}<label className="filter-control"><SlidersHorizontal size={15} /><span className="sr-only">Filter by priority</span><select aria-label="Filter by priority" value={params.get("priority") ?? ""} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set("priority", event.target.value); else next.delete("priority"); setParams(next); }}><option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label></div>
      <div className="ticket-table-wrap">{loading ? <LedgerSkeleton /> : error ? <EmptyLedger title="Queue unavailable" detail={error} /> : tickets.length === 0 ? <EmptyLedger title="Queue clear" detail="New conversations will appear here automatically." /> : <table className="ticket-table"><thead><tr><th><span className="sr-only">Select</span></th><th>ID</th><th>Priority</th><th>Subject</th><th>Customer</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>{tickets.map((ticket) => <tr key={ticket.id} className={ticket.id === ticketId ? "selected" : ""}><td><input type="checkbox" aria-label={`Select ticket ${ticket.number}`} checked={selectedTickets.includes(ticket.id)} onChange={(event) => setSelectedTickets((current) => event.target.checked ? [...current, ticket.id].slice(0, 20) : current.filter((id) => id !== ticket.id))} /></td><td><span className="ticket-id">#{ticket.number}</span>{ticket.unread && <i className="unread-dot" aria-label="Unread" />}</td><td><Priority value={ticket.priority} /></td><td><Link className="ticket-subject-link" to={`/inbox/${ticket.id}?${params}`}>{ticket.subject}</Link></td><td>{ticket.customerName}</td><td><span className={ticket.assigneeName ? "assignee-label" : "assignee-label unassigned"}>{ticket.assigneeName ?? "Unassigned"}</span></td><td><time>{relativeTime(ticket.updatedAt)}</time></td></tr>)}</tbody></table>}</div>
    </section>

    <section className="conversation-panel" aria-label="Selected conversation">
      {!conversation ? <div className="conversation-empty"><MessageSquareText size={22} /><h2>Select a ticket</h2><p>Open a row from the rundown to read and reply.</p></div> : <>
        <header className="conversation-header"><button className="mobile-back" onClick={() => navigate(`/inbox?${params}`)} aria-label="Back to ticket list"><ArrowLeft size={18} /></button><div><p className="ticket-reference">#{conversation.ticket.number}</p><h1>{conversation.ticket.subject}</h1></div><div className="conversation-actions"><Button variant="secondary" size="small" disabled={conversation.ticket.status === "resolved"} onClick={() => void updateTicket({ status: "resolved" })}><Check size={14} />{conversation.ticket.status === "resolved" ? "Resolved" : "Resolve"}</Button><Button variant="ghost" size="icon" aria-label="Customer details" title="Customer details" onClick={() => void openCustomerDetail()}><PanelRightOpen size={17} /></Button></div></header>
        <div className="conversation-context"><label><span>Status</span><select aria-label="Ticket status" value={conversation.ticket.status} onChange={(event) => void updateTicket({ status: event.target.value })}><option value="open">Open</option><option value="pending">Pending</option><option value="waiting_customer">Waiting</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label><label><span>Priority</span><select value={conversation.ticket.priority} onChange={(event) => void updateTicket({ priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label><span>Assignee</span><select value={conversation.ticket.assignedUserId ?? ""} onChange={(event) => void updateTicket({ assignedUserId: event.target.value || null })}><option value="">Unassigned</option>{members.filter((member) => !member.disabledAt).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label className="team-control"><span>Team</span><select value={conversation.ticket.assignedTeamId ?? ""} onChange={(event) => void updateTicket({ assignedTeamId: event.target.value || null })}><option value="">No team</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><div className="context-tags"><span>Tags</span><div>{conversation.tags.map((tag) => <button key={tag.id} type="button" className={`tag-chip tag-${tag.color}`} onClick={() => void removeTag(tag.id)} title={`Remove ${tag.name}`}>{tag.name}<X size={10} /></button>)}<select aria-label="Add tag" value="" onChange={(event) => void addTag(event.target.value)}><option value="">Add tag</option>{availableTags.filter((tag) => !conversation.tags.some((current) => current.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div></div></div>
        <div className="thread">{conversation.messages.map((message) => <article key={message.id} className={`thread-entry ${message.kind === "internal_note" ? "note" : message.authorType}`}><header><div className="message-avatar">{message.authorType === "customer" ? conversation.ticket.customerName.slice(0, 1) : session?.user.name.slice(0, 1)}</div><div><strong>{message.authorType === "customer" ? conversation.ticket.customerName : session?.user.name}</strong><span>{message.kind === "internal_note" ? "Internal note" : message.authorType === "customer" ? conversation.ticket.customerEmail : "Agent reply"}</span></div><time>{formatDate(message.createdAt)}</time></header><p>{message.bodyText}</p>{conversation.attachments.filter((file) => file.messageId === message.id).map((file) => <a className="message-attachment" key={file.id} href={`/api/attachments/${file.id}`}><Paperclip size={13} />{file.filename}<small>{formatBytes(file.size)}</small></a>)}</article>)}</div>
        <form ref={composerForm} className={messageKind === "internal_note" ? "composer note-mode" : "composer"} onSubmit={addMessage}><div className="composer-tabs"><label><input type="radio" name="kind" value="message" checked={messageKind === "message"} onChange={() => setMessageKind("message")} /><Send size={14} />Reply <kbd>R</kbd></label><label><input type="radio" name="kind" value="internal_note" checked={messageKind === "internal_note"} onChange={() => setMessageKind("internal_note")} /><StickyNote size={14} />Internal note <kbd>P</kbd></label><select aria-label="Insert saved reply" value="" onChange={(event) => { const reply = savedReplies.find((item) => item.id === event.target.value); if (reply) setDraft((current) => current ? `${current}\n\n${reply.content}` : reply.content); }}><option value="">Saved replies</option>{savedReplies.map((reply) => <option key={reply.id} value={reply.id}>{reply.name}</option>)}</select></div><Suspense fallback={<div className="rich-composer-loading" aria-label="Loading editor" />}><RichComposer value={draft} onChange={(text) => setDraft(text)} onSubmit={() => composerForm.current?.requestSubmit()} placeholder={messageKind === "internal_note" ? "Add context for your team…" : `Reply to ${conversation.ticket.customerName}…`} /></Suspense>{composerError && <p className="composer-error">{composerError}</p>}<footer><label className="attach-button"><Paperclip size={16} />{attachment ? attachment.name : "Attach"}<input type="file" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} /></label><span>⌘ Enter</span><Button type="submit" size="small" disabled={!draft.trim()}>{messageKind === "internal_note" ? "Add note" : "Send reply"}</Button></footer></form>
      </>}
    </section>
    {customerDetail && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCustomerDetail(); }}><aside ref={customerDialogRef} className="customer-sheet" role="dialog" aria-modal="true" aria-label="Customer details"><header><div><span>Customer</span><h2>{customerDetail.customer.name}</h2></div><button type="button" onClick={closeCustomerDetail} aria-label="Close customer details"><X size={18} /></button></header><dl><div><dt>Email</dt><dd>{customerDetail.customer.email}</dd></div><div><dt>Company</dt><dd>{customerDetail.customer.company ?? "—"}</dd></div><div><dt>Phone</dt><dd>{customerDetail.customer.phone ?? "—"}</dd></div><div><dt>Customer since</dt><dd>{new Date(customerDetail.customer.createdAt).toLocaleDateString()}</dd></div></dl>{customerDetail.customer.notes && <section><h3>Team notes</h3><p>{customerDetail.customer.notes}</p></section>}<section><h3>Ticket history</h3>{customerDetail.tickets.map((item) => <Link key={item.id} to={`/inbox/${item.id}`} onClick={closeCustomerDetail}><span>#{item.number}</span><strong>{item.subject}</strong><time>{new Date(item.updatedAt).toLocaleDateString()}</time></Link>)}</section></aside></div>}
    {createOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateDialog(); }}><form ref={createDialogRef} className="dialog-card" role="dialog" aria-modal="true" aria-label="Create ticket" onSubmit={createTicket}><header><div><h2>Create ticket</h2><p>Start a customer conversation.</p></div><button type="button" onClick={closeCreateDialog} aria-label="Close"><X size={18} /></button></header><label>Customer<select name="customerId" required defaultValue=""><option value="" disabled>Select a customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.email}</option>)}</select></label><label>Subject<input name="subject" maxLength={240} required /></label><label>Initial message<textarea name="message" rows={5} required /></label><label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><footer><Button type="button" variant="secondary" onClick={closeCreateDialog}>Cancel</Button><Button type="submit">Create ticket</Button></footer></form></div>}
  </div>;
}

function Priority({ value }: { value: string }) { return <span className={`priority priority-${value}`}><i />{value}</span>; }
function relativeTime(value: string) { const diff = Date.now() - new Date(value).getTime(); const hours = Math.floor(diff / 3_600_000); if (hours < 1) return `${Math.max(1, Math.floor(diff / 60_000))}m`; if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1_048_576 ? `${Math.round(value / 1024)} KB` : `${(value / 1_048_576).toFixed(1)} MB`; }
function LedgerSkeleton() { return <div className="ledger-skeleton" aria-label="Loading tickets"><span /><span /><span /><span /></div>; }
function EmptyLedger({ title, detail }: { title: string; detail: string }) { return <div className="empty-ledger"><h2>{title}</h2><p>{detail}</p></div>; }
