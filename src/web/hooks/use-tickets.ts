import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
  const query = useInfiniteQuery({
    queryKey: ["tickets", filters],
    queryFn: ({ pageParam, signal }) => {
      const search = ticketSearchParams(filters);
      if (pageParam) search.set("cursor", pageParam);
      return api<{ tickets: TicketSummary[]; nextCursor: string | null }>(`/tickets?${search}`, { signal });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: pollInterval,
  });
  const tickets = useMemo(() => {
    const seen = new Set<string>();
    return (
      query.data?.pages
        .flatMap((page) => page.tickets)
        .filter((ticket) => {
          if (seen.has(ticket.id)) return false;
          seen.add(ticket.id);
          return true;
        }) ?? []
    );
  }, [query.data]);
  return {
    tickets,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    canLoadMore: !query.isFetching && !query.isPlaceholderData,
    loadMore: () => void query.fetchNextPage({ cancelRefetch: false }),
    loadMoreError: query.isFetchNextPageError ? query.error : null,
    isPending: query.isPending,
    isFetching: query.isFetching,
    // Auto-selection must wait until these filters have their own results.
    isPlaceholderData: query.isPlaceholderData,
    error: query.isFetchNextPageError ? null : query.error,
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
