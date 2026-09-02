import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/web/components/toast";
import type { CustomerOption, Member, SavedReply, SavedView, SavedViewFilters, Tag, Team } from "@/web/inbox/types";
import { api } from "@/web/lib/api";

// Workspace lists change far less often than the queue does.
const staleTime = 5 * 60_000;

export function useWorkspaceData() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [members, customers, tags, savedReplies, teams, savedViews] = useQueries({
    queries: [
      {
        queryKey: ["members"],
        staleTime,
        queryFn: () => api<{ members: Member[] }>("/organization/members").then((result) => result.members),
      },
      {
        queryKey: ["customers"],
        staleTime,
        queryFn: () => api<{ customers: CustomerOption[] }>("/customers").then((result) => result.customers),
      },
      { queryKey: ["tags"], staleTime, queryFn: () => api<{ tags: Tag[] }>("/tags").then((result) => result.tags) },
      {
        queryKey: ["saved-replies"],
        staleTime,
        queryFn: () => api<{ savedReplies: SavedReply[] }>("/saved-replies").then((result) => result.savedReplies),
      },
      {
        queryKey: ["teams"],
        staleTime,
        queryFn: () => api<{ teams: Team[] }>("/operations/teams").then((result) => result.teams),
      },
      {
        queryKey: ["saved-views"],
        staleTime,
        queryFn: () => api<{ views: SavedView[] }>("/operations/views").then((result) => result.views),
      },
    ],
  });

  const refreshViews = () => queryClient.invalidateQueries({ queryKey: ["saved-views"] });
  const onError = (error: Error) => toast.push(error.message, "error");

  const createView = useMutation({
    mutationFn: (input: { name: string; filters: SavedViewFilters }) =>
      api<{ view: SavedView }>("/operations/views", {
        method: "POST",
        body: JSON.stringify({ ...input, visibility: "personal" }),
      }),
    onError,
    onSuccess: () => {
      toast.push("View saved.", "success");
      void refreshViews();
    },
  });

  const deleteView = useMutation({
    mutationFn: (viewId: string) => api(`/operations/views/${viewId}`, { method: "DELETE" }),
    onError,
    onSuccess: () => {
      void refreshViews();
    },
  });

  return {
    members: members.data ?? [],
    customers: customers.data ?? [],
    tags: tags.data ?? [],
    savedReplies: savedReplies.data ?? [],
    teams: teams.data ?? [],
    savedViews: savedViews.data ?? [],
    createView: (input: { name: string; filters: SavedViewFilters }) => createView.mutate(input),
    deleteView: (viewId: string) => deleteView.mutate(viewId),
  };
}
