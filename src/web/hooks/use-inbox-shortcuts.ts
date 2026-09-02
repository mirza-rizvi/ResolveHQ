import { useEffect } from "react";
import type { MessageKind, TicketSummary } from "@/web/inbox/types";
import { chordPending } from "@/web/lib/chord";

interface InboxShortcutOptions {
  tickets: TicketSummary[];
  ticketId?: string;
  canCompose: boolean;
  onEscape: () => void;
  onFocusSearch: () => void;
  onSelectTicket: (ticketId: string) => void;
  onCompose: (kind: MessageKind) => void;
}

export function useInboxShortcuts({
  tickets,
  ticketId,
  canCompose,
  onEscape,
  onFocusSearch,
  onSelectTicket,
  onCompose,
}: InboxShortcutOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "Escape") {
        onEscape();
        return;
      }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      // The shell's `g` chord owns the next keystroke — `g k` goes to Knowledge
      // rather than also walking the queue up one row on the way there.
      if (chordPending()) return;
      if (event.key === "/") {
        event.preventDefault();
        onFocusSearch();
        return;
      }
      if ((event.key === "j" || event.key === "k") && tickets.length) {
        event.preventDefault();
        const current = Math.max(
          0,
          tickets.findIndex((item) => item.id === ticketId),
        );
        const next = event.key === "j" ? Math.min(tickets.length - 1, current + 1) : Math.max(0, current - 1);
        onSelectTicket(tickets[next].id);
        return;
      }
      if ((event.key === "r" || event.key === "p") && canCompose) {
        event.preventDefault();
        onCompose(event.key === "p" ? "internal_note" : "message");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canCompose, onCompose, onEscape, onFocusSearch, onSelectTicket, ticketId, tickets]);
}
