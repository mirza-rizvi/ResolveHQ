import type { TicketSummary } from "./types";

/**
 * Text, never an icon, and never animated: a pulsing badge across forty rows is exactly
 * the visual fatigue this product is meant to avoid. Colour reinforces the text; it
 * never carries the meaning on its own.
 */
export function SlaBadge({ ticket }: { ticket: TicketSummary }) {
  const full = slaLabel(ticket, false);
  const short = slaLabel(ticket, true);
  if (!full || !short) return null;
  // Both forms are rendered and CSS picks one, so narrow screens shorten without a
  // viewport listener and without the label changing after hydration.
  return (
    <span className={`sla-badge sla-${ticket.slaState}`} title={full}>
      <span className="sla-full">{full}</span>
      <span className="sla-short" aria-hidden="true">
        {short}
      </span>
    </span>
  );
}

/** Returns null when there is nothing honest to say: no policy, already answered, or snoozed. */
export function slaLabel(ticket: TicketSummary, compact: boolean, now = Date.now()): string | null {
  if (!ticket.slaState || ticket.slaState === "none") return null;
  if (ticket.firstResponseAt) return null;
  if (!ticket.firstResponseDueAt) return null;
  if (ticket.snoozedUntil && new Date(ticket.snoozedUntil).getTime() > now) return null;
  const remaining = new Date(ticket.firstResponseDueAt).getTime() - now;
  if (remaining < 0) return compact ? `-${duration(-remaining)}` : `Overdue by ${duration(-remaining)}`;
  return compact ? duration(remaining) : `Due in ${duration(remaining)}`;
}

function duration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
