import {
  AlarmClock,
  Archive,
  Check,
  Clock3,
  Inbox as InboxIcon,
  Layers,
  PauseCircle,
  Timer,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { QueueKey, SavedViewFilters } from "./types";

export const queueStatuses = ["open", "pending", "waiting_customer", "resolved", "closed"] as const;

export const queueNavigation: ReadonlyArray<{ key: QueueKey; label: string; icon: LucideIcon }> = [
  { key: "all", label: "All", icon: Layers },
  { key: "open", label: "Open", icon: InboxIcon },
  // Triage order: what is late comes immediately after what is open.
  { key: "overdue", label: "Overdue", icon: AlarmClock },
  { key: "due_soon", label: "Due soon", icon: Timer },
  { key: "pending", label: "Pending", icon: PauseCircle },
  { key: "unassigned", label: "Unassigned", icon: Users },
  { key: "mine", label: "Mine", icon: UserRound },
  { key: "waiting_customer", label: "Waiting", icon: Clock3 },
  { key: "resolved", label: "Resolved", icon: Check },
  { key: "closed", label: "Closed", icon: Archive },
];

const labels = new Map(queueNavigation.map((item) => [item.key, item.label]));

export function isQueueKey(value: string): value is QueueKey {
  return labels.has(value as QueueKey);
}

/** The human name for a queue, used in headings and generated saved-view names. */
export function queueLabel(queue: string) {
  return labels.get(queue as QueueKey) ?? queue.replace("_", " ");
}

/** The saved-view filter shape a queue stands for; "all" filters on nothing. */
export function filtersForQueue(queue: string): SavedViewFilters {
  if (queue === "overdue") return { sla: "breached" };
  if (queue === "due_soon") return { sla: "due_soon" };
  if (queue === "unassigned") return { assignee: "unassigned" };
  if (queue === "mine") return { assignee: "me" };
  if ((queueStatuses as readonly string[]).includes(queue)) return { status: queue };
  return {};
}

/** The queue a saved view resolves to when it is applied. */
export function queueForFilters(filters: SavedViewFilters): QueueKey {
  if (filters.sla === "breached") return "overdue";
  if (filters.sla === "due_soon") return "due_soon";
  if (filters.status && (queueStatuses as readonly string[]).includes(filters.status))
    return filters.status as QueueKey;
  if (filters.assignee === "me") return "mine";
  if (filters.assignee === "unassigned") return "unassigned";
  return "all";
}
