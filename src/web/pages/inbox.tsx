import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useToast } from "@/web/components/toast";
import { useConversation } from "@/web/hooks/use-conversation";
import { useDraft } from "@/web/hooks/use-draft";
import { useInboxShortcuts } from "@/web/hooks/use-inbox-shortcuts";
import { useTicketCounts, useTickets } from "@/web/hooks/use-tickets";
import { useWorkspaceData } from "@/web/hooks/use-workspace-data";
import { ConversationPanel } from "@/web/inbox/conversation";
import { CreateTicketDialog } from "@/web/inbox/create-ticket-dialog";
import { CustomerSheet } from "@/web/inbox/customer-sheet";
import { QueueSidebar } from "@/web/inbox/queue-sidebar";
import { filtersForQueue, queueForFilters, queueLabel } from "@/web/inbox/queues";
import { TicketLedger } from "@/web/inbox/ticket-ledger";
import type { CustomerDetail, MessageKind, SavedView } from "@/web/inbox/types";
import { api, errorMessage } from "@/web/lib/api";

export function InboxPage() {
  const { ticketId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const queue = params.get("queue") ?? "open";
  const priority = params.get("priority") ?? "";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [selectedTickets, setSelectedTickets] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [customerId, setCustomerId] = useState("");
  const composerForm = useRef<HTMLFormElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(query), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const workspace = useWorkspaceData();
  const { tickets, isPending: ticketsPending, error: ticketsError } = useTickets({ queue, priority, q: search });
  const { counts } = useTicketCounts();
  const conversation = useConversation(ticketId);
  const draft = useDraft(ticketId);
  const customerDetail = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => api<CustomerDetail>(`/customers/${customerId}`),
    enabled: Boolean(customerId),
  });

  // On a wide screen the rundown always has something open; on mobile the list
  // is the page, so it stays the list until a row is tapped.
  useEffect(() => {
    if (ticketId || !tickets.length || window.matchMedia("(max-width: 900px)").matches) return;
    navigate(`/inbox/${tickets[0].id}?${params}`, { replace: true });
  }, [navigate, params, ticketId, tickets]);

  const selectQueue = useCallback(
    (next: string) => {
      const target = new URLSearchParams();
      target.set("queue", next);
      if (priority) target.set("priority", priority);
      navigate(`/inbox?${target}`);
    },
    [navigate, priority],
  );

  const closeCreateDialog = useCallback(() => {
    setCreateOpen(false);
    setCreateError("");
  }, []);
  const closeCustomerDetail = useCallback(() => setCustomerId(""), []);

  useInboxShortcuts({
    tickets,
    ticketId,
    canCompose: Boolean(conversation.conversation),
    onEscape: useCallback(() => {
      if (customerId) {
        setCustomerId("");
        return;
      }
      if (createOpen) {
        closeCreateDialog();
        return;
      }
      if (ticketId && window.matchMedia("(max-width: 900px)").matches) navigate(`/inbox?${params}`);
    }, [closeCreateDialog, createOpen, customerId, navigate, params, ticketId]),
    onFocusSearch: useCallback(() => searchInput.current?.focus(), []),
    onSelectTicket: useCallback((id: string) => navigate(`/inbox/${id}?${params}`), [navigate, params]),
    onCompose: useCallback(
      (kind: MessageKind) => {
        draft.setKind(kind);
        window.requestAnimationFrame(() =>
          composerForm.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus(),
        );
      },
      [draft],
    ),
  });

  const createTicket = useMutation({
    mutationFn: (input: Record<string, FormDataEntryValue | null>) =>
      api<{ ticket: { id: string } }>("/tickets", { method: "POST", body: JSON.stringify(input) }),
    onError: (error) => setCreateError(error.message),
    onSuccess: (result) => {
      closeCreateDialog();
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket-counts"] });
      navigate(`/inbox/${result.ticket.id}?queue=open`);
    },
  });

  const bulkUpdate = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api<{ updated: number; skipped: Array<{ ticketId: string; reason: string }> }>("/operations/tickets/bulk", {
        method: "POST",
        body: JSON.stringify({ ticketIds: selectedTickets, ...changes }),
      }),
    onError: (error) => toast.push(error.message, "error"),
    onSuccess: (result) => {
      setSelectedTickets([]);
      toast.push(
        result.skipped.length
          ? `${result.updated} updated · ${result.skipped.length} skipped`
          : `${result.updated} updated`,
        result.skipped.length ? "info" : "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket-counts"] });
      if (ticketId) void queryClient.invalidateQueries({ queryKey: ["conversation", ticketId] });
    },
  });

  async function sendMessage({ attachmentIds }: { attachmentIds: string[] }) {
    await conversation.sendMessage({
      body: draft.body.trim(),
      bodyHtml: draft.kind === "message" && draft.html ? draft.html : undefined,
      kind: draft.kind,
      attachmentIds,
      clientMessageId: crypto.randomUUID(),
    });
    await draft.clear();
  }

  function saveCurrentView() {
    workspace.createView({
      name: `${queueLabel(queue)} tickets`,
      filters: { ...filtersForQueue(queue), ...(priority ? { priority } : {}) },
    });
  }

  function applyView(view: SavedView) {
    const target = new URLSearchParams();
    target.set("queue", queueForFilters(view.filters));
    if (view.filters.priority) target.set("priority", view.filters.priority);
    navigate(`/inbox?${target}`);
  }

  function submitCreateTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setCreateError("");
    createTicket.mutate({
      customerId: data.get("customerId"),
      subject: data.get("subject"),
      message: data.get("message"),
      priority: data.get("priority"),
    });
  }

  return (
    <div className="inbox-layout">
      <QueueSidebar
        queue={queue}
        counts={counts}
        savedViews={workspace.savedViews}
        onSelectQueue={selectQueue}
        onSaveView={saveCurrentView}
        onApplyView={applyView}
        onDeleteView={workspace.deleteView}
      />
      <TicketLedger
        tickets={tickets}
        ticketId={ticketId}
        queue={queue}
        params={params}
        loading={ticketsPending}
        error={ticketsError ? errorMessage(ticketsError, "Could not load the queue.") : ""}
        query={query}
        onQueryChange={setQuery}
        searchInputRef={searchInput}
        priority={priority}
        onPriorityChange={(value) => {
          const next = new URLSearchParams(params);
          if (value) next.set("priority", value);
          else next.delete("priority");
          setParams(next);
        }}
        selectedTickets={selectedTickets}
        onToggleSelected={(id, selected) =>
          setSelectedTickets((current) =>
            selected ? [...current, id].slice(0, 20) : current.filter((entry) => entry !== id),
          )
        }
        onClearSelection={() => setSelectedTickets([])}
        onBulkStatus={(status) => bulkUpdate.mutate({ status })}
        onSelectQueue={selectQueue}
        onCreateTicket={() => setCreateOpen(true)}
      />
      <ConversationPanel
        ticketId={ticketId}
        conversation={conversation.conversation}
        loading={conversation.isPending}
        error={conversation.error ? errorMessage(conversation.error, "The conversation could not be loaded.") : ""}
        onRetry={() => void conversation.refetch()}
        members={workspace.members}
        teams={workspace.teams}
        availableTags={workspace.tags}
        savedReplies={workspace.savedReplies}
        onBack={() => navigate(`/inbox?${params}`)}
        onUpdate={conversation.update}
        onAddTag={conversation.addTag}
        onRemoveTag={conversation.removeTag}
        onOpenCustomer={() => setCustomerId(conversation.conversation?.ticket.customerId ?? "")}
        composerFormRef={composerForm}
        messageKind={draft.kind}
        onMessageKindChange={draft.setKind}
        draft={draft.body}
        onDraftChange={draft.setBody}
        onSend={sendMessage}
        sending={conversation.sending}
        draftStatus={draft.status}
        draftSavedAt={draft.savedAt}
      />
      {customerDetail.data && <CustomerSheet detail={customerDetail.data} onClose={closeCustomerDetail} />}
      {createOpen && (
        <CreateTicketDialog
          customers={workspace.customers}
          error={createError}
          submitting={createTicket.isPending}
          onClose={closeCreateDialog}
          onSubmit={submitCreateTicket}
        />
      )}
    </div>
  );
}
