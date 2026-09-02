import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { queueStatuses } from "@/web/inbox/queues";
import type { QueueCounts, TicketSummary } from "@/web/inbox/types";
import { api } from "@/web/lib/api";

export interface TicketFilters {
  queue: string;
  priority?: string;
  q: string;
}

/** Translates a queue key into the server's ticket filters; "all" filters on nothing. */
export function ticketSearchParams({ queue, priority, q }: TicketFilters) {
  const search = new URLSearchParams();
  if ((queueStatuses as readonly string[]).includes(queue)) search.set("status", queue);
  if (queue === "unassigned") search.set("assignee", "unassigned");
  if (queue === "mine") search.set("assignee", "me");
  if (priority) search.set("priority", priority);
  if (q.trim()) search.set("q", q.trim());
  return search;
}

// A hidden tab still refreshes, just far less often.
export const pollInterval = () => (document.visibilityState === "visible" ? 15_000 : 60_000);

export function useTickets(filters: TicketFilters) {
  // The key carries only the filters, so selecting a ticket neither restarts
  // the poll nor drops the list, and `keepPreviousData` keeps the previous
  // page on screen instead of flashing the skeleton on every filter change.
  const query = useQuery({
    queryKey: ["tickets", filters],
    queryFn: () =>
      api<{ tickets: TicketSummary[] }>(`/tickets?${ticketSearchParams(filters)}`).then((result) => result.tickets),
    placeholderData: keepPreviousData,
    refetchInterval: pollInterval,
  });
  return {
    tickets: query.data ?? [],
    isPending: query.isPending,
    isFetching: query.isFetching,
    // True while the rows on screen are still the previous filters' — callers
    // that act on the list (auto-select) have to wait for the real page.
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useTicketCounts() {
  const query = useQuery({
    queryKey: ["ticket-counts"],
    queryFn: () => api<{ counts: QueueCounts }>("/tickets/counts").then((result) => result.counts),
    refetchInterval: 30_000,
  });
  return { counts: query.data };
}
