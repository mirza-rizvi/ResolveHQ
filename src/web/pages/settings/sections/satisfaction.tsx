import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Smile } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";

interface CsatResponse {
  id: string;
  rating: number | null;
  comment: string | null;
  respondedAt: string | null;
  ticketNumber: number;
  ticketId: string;
}

interface CsatData {
  enabled: boolean;
  prompt: string;
  recent: CsatResponse[];
}

const faces: Record<number, string> = { 1: "😞", 3: "😐", 5: "🙂" };

export function SatisfactionSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<CsatData | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<CsatData>("/satisfaction");
      setData(result);
      setPrompt(result.prompt);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Satisfaction settings could not be loaded."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(enabled: boolean, event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/satisfaction", { method: "PUT", body: JSON.stringify({ enabled, prompt }) });
      setMessage(
        enabled
          ? "Satisfaction ratings are on. Resolving replies now carry three rating links."
          : "Satisfaction ratings are off. Nothing is appended to outgoing mail.",
      );
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "Satisfaction settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const answered = data.recent.filter((entry) => entry.rating != null);
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Smile size={18} />
          Satisfaction ratings
        </h2>
        <p>
          When a reply resolves a ticket, three rating links are added to the bottom of the email. One click records
          the answer. Nothing is sent to a third party, and the message carries no tracking pixel.
        </p>
      </div>
      <div className="settings-inboxes">
        {message && <p className="settings-success">{message}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={(event) => void save(data.enabled, event)}>
          <label>
            Question asked in the email
            <Input
              value={prompt}
              maxLength={160}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!canManage}
              required
            />
          </label>
          {canManage && (
            <div className="settings-actions">
              <Button type="submit" variant="secondary" disabled={busy}>
                Save question
              </Button>
              <Button type="button" disabled={busy} onClick={() => void save(!data.enabled)}>
                {data.enabled ? "Turn off ratings" : "Turn on ratings"}
              </Button>
            </div>
          )}
        </form>
        <dl className="readiness-list">
          <div>
            <dt>Status</dt>
            <dd>{data.enabled ? "On" : "Off"}</dd>
          </div>
          <div>
            <dt>Recent answers</dt>
            <dd>{answered.length}</dd>
          </div>
        </dl>
        {answered.length > 0 && (
          <div className="csat-recent">
            {answered.map((entry) => (
              <article key={entry.id}>
                <span aria-label={`Rating ${entry.rating}`}>{faces[entry.rating!] ?? "•"}</span>
                <div>
                  <strong>Ticket #{entry.ticketNumber}</strong>
                  {entry.comment && <small>{entry.comment}</small>}
                </div>
                <time>{entry.respondedAt ? new Date(entry.respondedAt).toLocaleDateString() : ""}</time>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
