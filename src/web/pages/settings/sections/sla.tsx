import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Timer, Trash2, TriangleAlert } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";

interface BusinessDay {
  day: number;
  start: string;
  end: string;
}

interface SlaPolicy {
  id: string;
  name: string;
  priority: "low" | "normal" | "high" | "urgent" | null;
  firstResponseMinutes: number | null;
  resolutionMinutes: number | null;
  enabled: boolean;
}

interface SlaData {
  businessHours: { timezone: string; days: BusinessDay[]; holidays: string[] } | null;
  misconfiguredDays: number[];
  policies: SlaPolicy[];
}

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function SlaSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<SlaData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<SlaData>("/sla"));
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "SLA settings could not be loaded."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const hours = data?.businessHours;
  const [timezone, setTimezone] = useState("");
  const [days, setDays] = useState<BusinessDay[]>([]);
  const [holidays, setHolidays] = useState("");
  useEffect(() => {
    if (!data) return;
    setTimezone(hours?.timezone ?? localTimezone());
    setDays(hours?.days ?? []);
    setHolidays((hours?.holidays ?? []).join(", "));
  }, [data, hours]);

  async function saveHours(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/sla/business-hours", {
        method: "PUT",
        body: JSON.stringify({
          timezone,
          days,
          holidays: holidays
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        }),
      });
      setMessage("Business hours saved.");
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "Business hours could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function addPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const minutes = (key: string) => {
      const raw = String(values.get(key) ?? "").trim();
      return raw ? Number(raw) : null;
    };
    const priority = String(values.get("priority") ?? "");
    try {
      await api("/sla/policies", {
        method: "POST",
        body: JSON.stringify({
          name: values.get("name"),
          priority: priority || null,
          firstResponseMinutes: minutes("firstResponseMinutes"),
          resolutionMinutes: minutes("resolutionMinutes"),
        }),
      });
      form.reset();
      setMessage("SLA policy added.");
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "SLA policy could not be added."));
    }
  }

  async function removePolicy(id: string) {
    setError("");
    try {
      await api(`/sla/policies/${id}`, { method: "DELETE" });
      setMessage("SLA policy removed. Tickets keep the due dates already calculated for them.");
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "SLA policy could not be removed."));
    }
  }

  function toggleDay(day: number, enabled: boolean) {
    setDays((current) =>
      enabled
        ? [...current.filter((entry) => entry.day !== day), { day, start: "09:00", end: "17:00" }].sort(
            (a, b) => a.day - b.day,
          )
        : current.filter((entry) => entry.day !== day),
    );
  }

  function setDayTime(day: number, field: "start" | "end", value: string) {
    setDays((current) => current.map((entry) => (entry.day === day ? { ...entry, [field]: value } : entry)));
  }

  if (!data) return null;
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Timer size={18} />
          Response targets
        </h2>
        <p>
          Targets are counted in working minutes, so a ticket arriving on Friday evening is not overdue on Saturday
          morning. With no policy configured, ResolveHQ tracks nothing and shows no badges.
        </p>
      </div>
      <div className="settings-inboxes">
        {message && <p className="settings-success">{message}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {data.misconfiguredDays.length > 0 && (
          <p className="page-banner">
            <TriangleAlert size={15} />
            {data.misconfiguredDays.map((day) => dayNames[day]).join(", ")} ends at or before it starts, so it never
            opens and is skipped when a due date is calculated.
          </p>
        )}

        <form onSubmit={saveHours} className="sla-hours">
          <label>
            Timezone
            <Input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="Europe/London"
              disabled={!canManage}
              required
            />
            <small>An IANA timezone name. Leave the schedule empty to treat the workspace as always open.</small>
          </label>
          <div className="sla-days">
            {dayNames.map((name, day) => {
              const entry = days.find((candidate) => candidate.day === day);
              return (
                <div key={day} className="sla-day">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(entry)}
                      disabled={!canManage}
                      onChange={(event) => toggleDay(day, event.target.checked)}
                    />
                    {name}
                  </label>
                  {entry && (
                    <>
                      <Input
                        type="time"
                        aria-label={`${name} opens`}
                        value={entry.start}
                        disabled={!canManage}
                        onChange={(event) => setDayTime(day, "start", event.target.value)}
                      />
                      <Input
                        type="time"
                        aria-label={`${name} closes`}
                        value={entry.end}
                        disabled={!canManage}
                        onChange={(event) => setDayTime(day, "end", event.target.value)}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <label>
            Holidays
            <Input
              value={holidays}
              onChange={(event) => setHolidays(event.target.value)}
              placeholder="2026-12-25, 2026-12-26"
              disabled={!canManage}
            />
            <small>Comma-separated dates in YYYY-MM-DD. The clock does not run on these days.</small>
          </label>
          {canManage && (
            <Button type="submit" disabled={busy}>
              Save business hours
            </Button>
          )}
        </form>

        <div className="sla-policies">
          {data.policies.length ? (
            data.policies.map((policy) => (
              <article key={policy.id}>
                <div>
                  <strong>{policy.name}</strong>
                  <small>
                    {policy.priority ? `${policy.priority} priority` : "Default for every ticket"} ·{" "}
                    {policy.firstResponseMinutes ? `first reply in ${policy.firstResponseMinutes} min` : "no reply target"}
                    {policy.resolutionMinutes ? ` · resolved in ${policy.resolutionMinutes} min` : ""}
                  </small>
                </div>
                {canManage && (
                  <button
                    type="button"
                    aria-label={`Delete ${policy.name}`}
                    onClick={() => void removePolicy(policy.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </article>
            ))
          ) : (
            <p className="settings-empty">
              No policy yet, so nothing is tracked and no ticket is ever marked late. Add one below to start.
            </p>
          )}
          {canManage && (
            <form onSubmit={addPolicy}>
              <Input name="name" placeholder="Standard" aria-label="Policy name" required />
              <select name="priority" aria-label="Applies to">
                <option value="">Every ticket (default)</option>
                <option value="urgent">Urgent only</option>
                <option value="high">High only</option>
                <option value="normal">Normal only</option>
                <option value="low">Low only</option>
              </select>
              <Input
                name="firstResponseMinutes"
                type="number"
                min={1}
                placeholder="First reply (min)"
                aria-label="First response target in working minutes"
              />
              <Input
                name="resolutionMinutes"
                type="number"
                min={1}
                placeholder="Resolved (min)"
                aria-label="Resolution target in working minutes"
              />
              <Button type="submit">Add policy</Button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
