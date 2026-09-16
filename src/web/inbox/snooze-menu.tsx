import { useEffect, useRef, useState } from "react";
import { AlarmClockOff, Clock } from "lucide-react";
import { Button } from "@/web/components/ui";

export interface SnoozePreset {
  label: string;
  at: Date;
}

/**
 * Presets first, custom last. A bare datetime picker for something agents do twenty
 * times a day is hostile, so the common answers are one click.
 *
 * `openAt` is the workspace's next working-day opening time where business hours are
 * configured, so "Tomorrow" never means 09:00 on a Sunday.
 */
export function snoozePresets(now = new Date(), openingHour = 9, closingHour = 17): SnoozePreset[] {
  const presets: SnoozePreset[] = [];
  const laterToday = new Date(now);
  laterToday.setHours(closingHour, 0, 0, 0);
  if (laterToday.getTime() > now.getTime() + 30 * 60_000)
    presets.push({ label: `Later today (${pad(closingHour)}:00)`, at: laterToday });

  presets.push({ label: `Tomorrow (${pad(openingHour)}:00)`, at: nextWorkingDay(now, 1, openingHour) });
  presets.push({ label: `Monday (${pad(openingHour)}:00)`, at: nextWeekday(now, 1, openingHour) });
  presets.push({ label: `In a week (${pad(openingHour)}:00)`, at: nextWorkingDay(now, 7, openingHour) });
  return presets;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Skips Saturday and Sunday, so a deferral never lands on a day nobody is working. */
function nextWorkingDay(from: Date, days: number, hour: number) {
  const at = new Date(from);
  at.setDate(at.getDate() + days);
  at.setHours(hour, 0, 0, 0);
  while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() + 1);
  return at;
}

function nextWeekday(from: Date, weekday: number, hour: number) {
  const at = new Date(from);
  at.setHours(hour, 0, 0, 0);
  do {
    at.setDate(at.getDate() + 1);
  } while (at.getDay() !== weekday);
  return at;
}

export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
  openingHour,
  closingHour,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (at: Date, reason: string) => void;
  openingHour: number;
  closingHour: number;
  busy: boolean;
}) {
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div className="snooze-menu" ref={containerRef} role="dialog" aria-label="Snooze ticket">
      <div className="snooze-presets" role="group" aria-label="Snooze presets">
        {snoozePresets(new Date(), openingHour, closingHour).map((preset) => (
          <button key={preset.label} type="button" disabled={busy} onClick={() => onSnooze(preset.at, reason)}>
            <Clock size={14} />
            {preset.label}
          </button>
        ))}
      </div>
      <label>
        Pick a date and time
        <input
          type="datetime-local"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          aria-label="Snooze until"
        />
      </label>
      <label>
        Reason (optional)
        <input
          value={reason}
          maxLength={240}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Waiting on the carrier"
          aria-label="Snooze reason"
        />
      </label>
      <Button
        type="button"
        size="small"
        disabled={!custom || busy}
        onClick={() => custom && onSnooze(new Date(custom), reason)}
      >
        Snooze
      </Button>
    </div>
  );
}

export function SnoozeBanner({
  until,
  reason,
  onUnsnooze,
  busy,
}: {
  until: string;
  reason: string | null;
  onUnsnooze: () => void;
  busy: boolean;
}) {
  return (
    <div className="snooze-banner" role="status">
      <AlarmClockOff size={15} />
      <p>
        Snoozed until {new Date(until).toLocaleString()}
        {reason ? ` — ${reason}` : ""} — wakes early if the customer replies.
      </p>
      <Button type="button" variant="secondary" size="small" disabled={busy} onClick={onUnsnooze}>
        Unsnooze
      </Button>
    </div>
  );
}
