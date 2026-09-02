import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/web/lib/api";
import { useAuth } from "@/web/auth";
import { ConversationPanel } from "@/web/inbox/conversation";
import { CreateTicketDialog } from "@/web/inbox/create-ticket-dialog";
import { CustomerSheet } from "@/web/inbox/customer-sheet";
import { QueueSidebar } from "@/web/inbox/queue-sidebar";
import { filtersForQueue, queueForFilters, queueLabel, queueStatuses } from "@/web/inbox/queues";
import { TicketLedger } from "@/web/inbox/ticket-ledger";
import type {
  Conversation, CustomerDetail, CustomerOption, Member, MessageKind, SavedReply, SavedView, Tag, Team, TicketSummary,
} from "@/web/inbox/types";

export function InboxPage() {
  const { ticketId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [params, setParams] = useSearchParams();
  const queue = params.get("queue") ?? "open";
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [selectedTickets, setSelectedTickets] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [messageKind, setMessageKind] = useState<MessageKind>("message");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [composerError, setComposerError] = useState("");
  const draftRevision = useRef(0);
  const hydratedDraftTicket = useRef("");
  const draftWrites = useRef(Promise.resolve());
  const composerForm = useRef<HTMLFormElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const closeCustomerDetail = useCallback(() => setCustomerDetail(null), []);
  const closeCreateDialog = useCallback(() => { setCreateOpen(false); setCreateError(""); }, []);

  const loadTickets = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    const search = new URLSearchParams();
    if ((queueStatuses as readonly string[]).includes(queue)) search.set("status", queue);
    if (queue === "unassigned") search.set("assignee", "unassigned");
    if (queue === "mine") search.set("assignee", "me");
    if (params.get("priority")) search.set("priority", params.get("priority")!);
    if (query.trim()) search.set("q", query.trim());
    try {
      const result = await api<{ tickets: TicketSummary[] }>(`/tickets?${search}`);
      setTickets(result.tickets);
      if (!ticketId && result.tickets[0] && !window.matchMedia("(max-width: 900px)").matches) {
        navigate(`/inbox/${result.tickets[0].id}?${params}`, { replace: true });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the queue.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [queue, query, ticketId, navigate, params]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadTickets(), query ? 250 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadTickets, query]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadTickets(true);
    }, document.visibilityState === "visible" ? 15_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [loadTickets]);

  useEffect(() => {
    void Promise.all([
      api<{ members: Member[] }>("/organization/members").then((result) => setMembers(result.members)),
      api<{ customers: CustomerOption[] }>("/customers").then((result) => setCustomers(result.customers)),
      api<{ tags: Tag[] }>("/tags").then((result) => setAvailableTags(result.tags)),
      api<{ savedReplies: SavedReply[] }>("/saved-replies").then((result) => setSavedReplies(result.savedReplies)),
      api<{ teams: Team[] }>("/operations/teams").then((result) => setTeams(result.teams)),
      api<{ views: SavedView[] }>("/operations/views").then((result) => setSavedViews(result.views)),
    ]).catch(() => setError("Some workspace controls could not be loaded."));
  }, []);

  useEffect(() => {
    if (!ticketId) { setConversation(null); return; }
    void api<Conversation>(`/tickets/${ticketId}`)
      .then(setConversation)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open the conversation."));
  }, [ticketId]);

  useEffect(() => {
    hydratedDraftTicket.current = "";
    draftRevision.current = 0;
    if (!ticketId) { setDraft(""); return; }
    void api<{ draft: { body: string; kind: MessageKind; revision: number } | null }>(`/operations/tickets/${ticketId}/draft`).then(({ draft: saved }) => {
      if (saved) { setDraft(saved.body); setMessageKind(saved.kind); draftRevision.current = saved.revision; }
      else { setDraft(""); setMessageKind("message"); }
      hydratedDraftTicket.current = ticketId;
    }).catch(() => { hydratedDraftTicket.current = ticketId; });
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId || hydratedDraftTicket.current !== ticketId) return;
    const timeout = window.setTimeout(() => {
      draftWrites.current = draftWrites.current.then(async () => {
        const result = await api<{ draft: { revision: number } }>(`/operations/tickets/${ticketId}/draft`, {
          method: "PUT",
          body: JSON.stringify({ body: draft, kind: messageKind, revision: draftRevision.current }),
        });
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
        event.preventDefault();
        setMessageKind(event.key === "p" ? "internal_note" : "message");
        window.requestAnimationFrame(() => composerForm.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversation, createOpen, customerDetail, navigate, params, ticketId, tickets]);

  async function updateTicket(values: Record<string, unknown>) {
    if (!ticketId) return;
    await api(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ ...values, version: conversation?.ticket.version }) });
    await Promise.all([loadTickets(true), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]);
  }

  async function addMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ticketId || !draft.trim()) return;
    setComposerError("");
    try {
      const result = await api<{ message: { id: string } }>(`/tickets/${ticketId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: draft.trim(), kind: messageKind, clientMessageId: crypto.randomUUID() }),
      });
      if (attachment) {
        const intent = await api<{ upload: { url: string } }>("/attachments/intents", {
          method: "POST",
          body: JSON.stringify({ ticketId, messageId: result.message.id, filename: attachment.name, contentType: attachment.type, size: attachment.size }),
        });
        await api(intent.upload.url.replace(/^\/api/, ""), { method: "PUT", headers: { "content-type": attachment.type }, body: attachment });
      }
      hydratedDraftTicket.current = "";
      setDraft("");
      setAttachment(null);
      await api(`/operations/tickets/${ticketId}/draft`, { method: "DELETE" });
      await Promise.all([loadTickets(true), api<Conversation>(`/tickets/${ticketId}`).then(setConversation)]);
      hydratedDraftTicket.current = ticketId;
    } catch (reason) {
      setComposerError(reason instanceof Error ? reason.message : "The message could not be sent.");
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setCreateError("");
    try {
      const result = await api<{ ticket: { id: string } }>("/tickets", {
        method: "POST",
        body: JSON.stringify({ customerId: data.get("customerId"), subject: data.get("subject"), message: data.get("message"), priority: data.get("priority") }),
      });
      setCreateOpen(false);
      await loadTickets();
      navigate(`/inbox/${result.ticket.id}?queue=open`);
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "The ticket could not be created.");
    }
  }

  async function addTag(tagId: string) {
    if (!ticketId || !tagId) return;
    await api(`/tickets/${ticketId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) });
    setConversation(await api<Conversation>(`/tickets/${ticketId}`));
  }

  async function removeTag(tagId: string) {
    if (!ticketId) return;
    await api(`/tickets/${ticketId}/tags/${tagId}`, { method: "DELETE" });
    setConversation(await api<Conversation>(`/tickets/${ticketId}`));
  }

  async function saveCurrentView() {
    const filters = filtersForQueue(queue);
    const name = `${queueLabel(queue)} tickets`;
    const result = await api<{ view: SavedView }>("/operations/views", { method: "POST", body: JSON.stringify({ name, visibility: "personal", filters }) });
    setSavedViews((current) => [...current, result.view]);
  }

  function applyView(view: SavedView) {
    const next = new URLSearchParams();
    next.set("queue", queueForFilters(view.filters));
    if (view.filters.priority) next.set("priority", view.filters.priority);
    navigate(`/inbox?${next}`);
  }

  async function bulkUpdate(values: Record<string, unknown>) {
    if (!selectedTickets.length) return;
    await api("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: selectedTickets, ...values }) });
    setSelectedTickets([]);
    await loadTickets(true);
  }

  async function openCustomerDetail() {
    if (!conversation) return;
    setCustomerDetail(await api<CustomerDetail>(`/customers/${conversation.ticket.customerId}`));
  }

  return <div className="inbox-layout">
    <QueueSidebar
      queue={queue}
      ticketCount={tickets.length}
      savedViews={savedViews}
      onSelectQueue={(next) => { setParams({ queue: next }); navigate(`/inbox?queue=${next}`); }}
      onSaveView={() => void saveCurrentView()}
      onApplyView={applyView}
    />
    <TicketLedger
      tickets={tickets}
      ticketId={ticketId}
      queue={queue}
      params={params}
      loading={loading}
      error={error}
      query={query}
      onQueryChange={setQuery}
      searchInputRef={searchInput}
      priority={params.get("priority") ?? ""}
      onPriorityChange={(value) => {
        const next = new URLSearchParams(params);
        if (value) next.set("priority", value); else next.delete("priority");
        setParams(next);
      }}
      selectedTickets={selectedTickets}
      onToggleSelected={(id, selected) => setSelectedTickets((current) => selected ? [...current, id].slice(0, 20) : current.filter((entry) => entry !== id))}
      onClearSelection={() => setSelectedTickets([])}
      onBulkStatus={(status) => void bulkUpdate({ status })}
      onSelectQueue={(next) => navigate(`/inbox?queue=${next}`)}
      onCreateTicket={() => setCreateOpen(true)}
    />
    <ConversationPanel
      conversation={conversation}
      agentName={session?.user.name ?? ""}
      members={members}
      teams={teams}
      availableTags={availableTags}
      savedReplies={savedReplies}
      onBack={() => navigate(`/inbox?${params}`)}
      onUpdate={(changes) => void updateTicket(changes)}
      onAddTag={(tagId) => void addTag(tagId)}
      onRemoveTag={(tagId) => void removeTag(tagId)}
      onOpenCustomer={() => void openCustomerDetail()}
      composerFormRef={composerForm}
      messageKind={messageKind}
      onMessageKindChange={setMessageKind}
      draft={draft}
      onDraftChange={setDraft}
      onInsertSavedReply={(content) => setDraft((current) => current ? `${current}\n\n${content}` : content)}
      onSubmitMessage={(event) => void addMessage(event)}
      composerError={composerError}
      attachment={attachment}
      onAttachmentChange={setAttachment}
    />
    {customerDetail && <CustomerSheet detail={customerDetail} onClose={closeCustomerDetail} />}
    {createOpen && <CreateTicketDialog customers={customers} error={createError} onClose={closeCreateDialog} onSubmit={(event) => void createTicket(event)} />}
  </div>;
}
