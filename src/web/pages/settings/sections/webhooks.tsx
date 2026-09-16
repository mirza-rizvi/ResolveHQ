import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Send, Webhook } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";

const EVENT_LABELS: Record<string, string> = {
  "ticket.created": "A ticket is opened",
  "ticket.assigned": "A ticket is assigned",
  "ticket.status_changed": "A ticket changes status",
  "ticket.sla_breached": "A ticket misses its response target",
  "message.received": "A customer replies",
  "csat.received": "A customer rates their support",
};

interface Endpoint {
  id: string;
  kind: "generic" | "slack" | "telegram";
  url: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
  disabledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function relativeTime(value: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Health is stated per endpoint rather than assumed.
 *
 * An escalation path nobody has verified is worse than none, because it is trusted.
 */
function healthOf(endpoint: Endpoint) {
  if (!endpoint.enabled)
    return { tone: "bad" as const, text: `Turned off after ${endpoint.failureCount} failures in a row.` };
  if (endpoint.failureCount > 0)
    return {
      tone: "warn" as const,
      text: `${endpoint.failureCount} failure${endpoint.failureCount === 1 ? "" : "s"} in a row — last error: ${endpoint.lastError ?? "unknown"}`,
    };
  if (endpoint.lastSuccessAt)
    return { tone: "good" as const, text: `Last delivered ${relativeTime(endpoint.lastSuccessAt)}.` };
  return { tone: "idle" as const, text: "Nothing delivered yet. Send a test to check it." };
}

export function WebhooksSection({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(["ticket.created"]);
  const [kind, setKind] = useState<Endpoint["kind"]>("generic");
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ endpoints: Endpoint[]; events: string[] }>("/organization/webhooks");
      setEndpoints(result.endpoints);
      setEvents(result.events);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Webhooks could not be loaded."));
    }
  }, []);
  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const config: Record<string, string> = {};
    if (kind === "telegram") {
      config.botToken = String(values.get("botToken") ?? "").trim();
      config.chatId = String(values.get("chatId") ?? "").trim();
    }
    try {
      const result = await api<{ secret: string | null }>("/organization/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: String(values.get("url") ?? "").trim(), kind, events: selected, config }),
      });
      form.reset();
      setSelected(["ticket.created"]);
      if (result.secret) setRevealed(result.secret);
      else toast.push("Endpoint added.", "success");
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "The endpoint could not be added."));
    } finally {
      setBusy(false);
    }
  }

  async function act(endpoint: Endpoint, action: "test" | "enable" | "delete") {
    if (action === "delete" && !window.confirm(`Delete this endpoint? Nothing will be sent to it again.`)) return;
    try {
      if (action === "delete") await api(`/organization/webhooks/${endpoint.id}`, { method: "DELETE" });
      else if (action === "enable") await api(`/organization/webhooks/${endpoint.id}/enable`, { method: "POST" });
      else {
        const result = await api<{ delivered: boolean; responseCode: number | null; lastError: string | null }>(
          `/organization/webhooks/${endpoint.id}/test`,
          { method: "POST" },
        );
        toast.push(
          result.delivered
            ? `Test delivered (${result.responseCode ?? 200}).`
            : `Test failed: ${result.lastError ?? "no response"}`,
          result.delivered ? "success" : "error",
        );
      }
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "That could not be done."), "error");
    }
  }

  if (!canManage || !endpoints) return null;
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Webhook size={18} />
          Webhooks
        </h2>
        <p>
          Send an HTTP request somewhere else when something happens here — to your own service, a Slack channel, or a
          Telegram chat. Payloads carry ticket ids, numbers and statuses; they never contain message text or customer
          email addresses.
        </p>
      </div>
      <div className="settings-inboxes">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {revealed && <SecretDialog value={revealed} onDone={() => setRevealed(null)} />}

        <div className="webhook-list">
          {endpoints.length ? (
            endpoints.map((endpoint) => {
              const health = healthOf(endpoint);
              return (
                <article key={endpoint.id} className={endpoint.enabled ? undefined : "webhook-off"}>
                  <div>
                    <strong>
                      {endpoint.kind === "telegram" ? "Telegram" : endpoint.kind === "slack" ? "Slack" : endpoint.url}
                    </strong>
                    <small>{endpoint.events.map((entry) => EVENT_LABELS[entry] ?? entry).join(" · ")}</small>
                    <small className={`webhook-health webhook-${health.tone}`}>{health.text}</small>
                  </div>
                  <div className="webhook-actions">
                    <Button variant="secondary" size="small" onClick={() => void act(endpoint, "test")}>
                      <Send size={13} />
                      Test
                    </Button>
                    {!endpoint.enabled && (
                      <Button variant="secondary" size="small" onClick={() => void act(endpoint, "enable")}>
                        Re-enable
                      </Button>
                    )}
                    <Button variant="secondary" size="small" onClick={() => void act(endpoint, "delete")}>
                      Delete
                    </Button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="settings-empty">No endpoints yet.</p>
          )}
        </div>

        <form onSubmit={create} className="webhook-form">
          <label>
            Send to
            <select value={kind} onChange={(entry) => setKind(entry.target.value as Endpoint["kind"])} aria-label="Endpoint kind">
              <option value="generic">My own service</option>
              <option value="slack">Slack</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>
          {kind === "telegram" ? (
            <>
              <Input name="url" type="hidden" defaultValue="https://api.telegram.org" />
              <label>
                Bot token
                <Input name="botToken" placeholder="123456:ABC-DEF…" required />
              </label>
              <label>
                Chat id
                <Input name="chatId" placeholder="-1001234567890" required />
              </label>
            </>
          ) : (
            <label>
              URL
              <Input
                name="url"
                type="url"
                placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/resolvehq"}
                required
              />
              <small>Must be a public https address. Private and internal addresses are refused.</small>
            </label>
          )}
          <fieldset>
            <legend>Send when</legend>
            {events.map((entry) => (
              <label key={entry}>
                <input
                  type="checkbox"
                  checked={selected.includes(entry)}
                  onChange={(changed) =>
                    setSelected((current) =>
                      changed.target.checked ? [...current, entry] : current.filter((value) => value !== entry),
                    )
                  }
                />
                {EVENT_LABELS[entry] ?? entry}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy || !selected.length}>
            Add endpoint
          </Button>
        </form>
      </div>
    </section>
  );
}

/** Same contract as an API key: shown once, dismissed only by confirming. */
function SecretDialog({ value, onDone }: { value: string; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="api-key-reveal" role="dialog" aria-modal="true" aria-label="Your webhook signing secret">
      <div>
        <h3>Copy your signing secret now</h3>
        <p>
          Use it to verify the <code>X-ResolveHQ-Signature</code> header on every delivery. This is the only time you
          will see it.
        </p>
        <div className="api-key-value">
          <code>{value}</code>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              navigator.clipboard
                ?.writeText(value)
                .then(() => setCopied(true))
                .catch(() => toast.push("Copy it manually — the clipboard was not available.", "error"));
            }}
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <Button type="button" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}
