import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui";
import { api, errorMessage } from "../lib/api";
interface Job {
  id: string;
  kind: "inbound-mail" | "outbound-mail";
  reason: string;
  generation: number;
  updatedAt: number;
  firstAttemptAt: number | null;
  requiresDuplicateAck: number;
  ticketId?: string;
  ticketNumber?: number;
  subject?: string;
}
export function MailRecovery() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => {
    try {
      const result = await api<{ jobs: Job[] }>("/mail-recovery");
      setJobs(result.jobs);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Stopped mail could not be loaded. Try refreshing."));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(job: Job) {
    if (busy) return;
    setBusy(job.id);
    setError("");
    try {
      await api(`/mail-recovery/${encodeURIComponent(job.id)}/retry`, {
        method: "POST",
        body: JSON.stringify({
          kind: job.kind,
          generation: job.generation,
          acknowledgeDuplicateRisk: acknowledged[job.id] ?? false,
        }),
      });
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "Mail could not be retried. Refresh and try again."));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="settings-section">
      <div>
        <h2>Stopped mail</h2>
        <p>Fix the delivery problem before retrying. Showing up to 50 recent jobs.</p>
      </div>
      <div className="mail-captures">
        <Button type="button" variant="secondary" onClick={() => void load()} disabled={!!busy}>
          Refresh stopped mail
        </Button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!jobs && !error && <p role="status">Loading stopped mail…</p>}
        {jobs?.length === 0 && <p className="settings-empty">No stopped mail.</p>}
        {jobs?.map((job) => (
          <article key={job.id}>
            <header>
              <strong>{job.kind === "inbound-mail" ? "Incoming email" : "Outgoing email"}</strong>
              <time>{new Date(job.updatedAt).toLocaleString()}</time>
            </header>
            {job.ticketId ? (
              <a href={`/inbox/${encodeURIComponent(job.ticketId)}`}>
                #{job.ticketNumber} {job.subject}
              </a>
            ) : (
              <small>Reference: {job.id}</small>
            )}
            <p>
              {job.reason === "email.complained"
                ? "The recipient reported spam. Resending is blocked."
                : `Delivery stopped: ${job.reason.replaceAll("_", " ")}.`}
            </p>
            {job.requiresDuplicateAck && job.reason !== "email.complained" ? (
              <label>
                <input
                  type="checkbox"
                  checked={!!acknowledged[job.id]}
                  onChange={(event) => setAcknowledged((values) => ({ ...values, [job.id]: event.target.checked }))}
                />{" "}
                The earlier email may have arrived. I understand retrying could send a duplicate.
              </label>
            ) : null}
            <Button
              type="button"
              disabled={
                !!busy || job.reason === "email.complained" || (!!job.requiresDuplicateAck && !acknowledged[job.id])
              }
              onClick={() => void retry(job)}
            >
              {busy === job.id ? "Retrying…" : "Retry email"}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
