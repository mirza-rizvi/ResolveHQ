import { useMemo } from "react";
import { useMutation, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/web/components/toast";
import type { Conversation, MessageKind } from "@/web/inbox/types";
import { ApiError, api } from "@/web/lib/api";
import { pollInterval } from "./use-tickets";

export interface SendMessageInput {
  body: string;
  bodyHtml?: string;
  kind: MessageKind;
  attachmentIds?: string[];
  clientMessageId: string;
}

export function useConversation(ticketId?: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useInfiniteQuery({
    queryKey: ["conversation", ticketId],
    queryFn: ({ pageParam, signal }) =>
      api<Conversation>(
        `/tickets/${ticketId}?messageWindow=latest${pageParam ? `&messageCursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextMessageCursor ?? undefined,
    enabled: Boolean(ticketId),
    refetchInterval: pollInterval,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", ticketId] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["ticket-counts"] });
  };
  // Someone else moved the ticket on: say so once and show them the ticket as
  // it now stands rather than leaving a stale version to fail again.
  const onError = (error: Error) => {
    if (error instanceof ApiError && error.status === 409) {
      toast.push("Ticket changed elsewhere. Reloaded.", "info");
      void query.refetch();
      return;
    }
    toast.push(error.message, "error");
  };

  const update = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({ ...changes, version: query.data?.pages[0].ticket.version }),
      }),
    onError,
    onSuccess: invalidate,
  });

  const addTag = useMutation({
    mutationFn: (tagId: string) =>
      api(`/tickets/${ticketId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }),
    onError,
    onSuccess: invalidate,
  });

  const removeTag = useMutation({
    mutationFn: (tagId: string) => api(`/tickets/${ticketId}/tags/${tagId}`, { method: "DELETE" }),
    onError,
    onSuccess: invalidate,
  });

  const sendMessage = useMutation({
    mutationFn: (input: SendMessageInput) =>
      api<{ message: { id: string } }>(`/tickets/${ticketId}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onError,
    onSuccess: invalidate,
  });

  const pages = query.data?.pages;
  const conversation = useMemo(
    () =>
      pages?.length
        ? {
            ...pages[0],
            messages: [
              ...new Map(
                [...pages]
                  .reverse()
                  .flatMap((page) => page.messages)
                  .map((message) => [message.id, message]),
              ).values(),
            ],
            attachments: [
              ...new Map(
                pages.flatMap((page) => page.attachments).map((attachment) => [attachment.id, attachment]),
              ).values(),
            ],
          }
        : null,
    [pages],
  );
  return {
    conversation,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    canLoadOlder: !query.isFetching,
    loadOlder: () => void query.fetchNextPage({ cancelRefetch: false }),
    olderError: query.isFetchNextPageError ? query.error : null,
    error: query.isFetchNextPageError ? null : query.error,
    isPending: Boolean(ticketId) && query.isPending,
    refetch: query.refetch,
    update: (changes: Record<string, unknown>) => update.mutate(changes),
    addTag: (tagId: string) => {
      if (tagId) addTag.mutate(tagId);
    },
    removeTag: (tagId: string) => removeTag.mutate(tagId),
    sendMessage: (input: SendMessageInput) => sendMessage.mutateAsync(input),
    sending: sendMessage.isPending,
  };
}
