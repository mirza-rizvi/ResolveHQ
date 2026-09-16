import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, CircleHelp, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "./ui";
import { ApiError, api, errorMessage } from "@/web/lib/api";

export type ReadinessStatus = "ready" | "degraded" | "failed" | "unknown";

export interface ReadinessCheck {
  id: string;
  group: "configuration" | "inbound" | "outbound";
  label: string;
  status: ReadinessStatus;
  detail: string;
  advisory: boolean;
  fixHref?: string;
  observed?: string;
}

export interface ReadinessReport {
  checkedAt: number;
  cached: boolean;
  checks: ReadinessCheck[];
}

const groupLabels: Record<ReadinessCheck["group"], string> = {
  configuration: "Deployment",
  inbound: "Receiving mail",
  outbound: "Sending mail",
};

const statusLabels: Record<ReadinessStatus, string> = {
  ready: "Ready",
  degraded: "Needs attention",
  failed: "Not working",
  unknown: "Unknown",
};

const statusIcons: Record<ReadinessStatus, typeof Check> = {
  ready: Check,
  degraded: TriangleAlert,
  failed: CircleAlert,
  unknown: CircleHelp,
};

/** A workspace is set up when no required check has failed. Advisory rows never block. */
export function blockingChecks(checks: ReadinessCheck[]) {
  return checks.filter((check) => !check.advisory && check.status === "failed");
}

export function useReadiness() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const result = await api<ReadinessReport>(`/operations/readiness${refresh ? "?refresh=1" : ""}`);
      setReport(result);
      setError("");
    } catch (reason) {
      // An agent simply has no readiness view; that is not an error worth showing.
      if (reason instanceof ApiError && reason.status === 403) setError("");
      else setError(errorMessage(reason, "Readiness checks could not be loaded."));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { report, error, busy, refresh: () => load(true) };
}

/**
 * The shared checklist, mounted by both the first-run /setup page and the settings card.
 *
 * Rows describe what is being checked even before answers arrive, because inventorying
 * the checks is half the value — a blank spinner would defeat the page.
 */
export function ReadinessChecklist({
  report,
  error,
  busy,
  onRefresh,
}: {
  report: ReadinessReport | null;
  error: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const groups: Array<ReadinessCheck["group"]> = ["configuration", "inbound", "outbound"];
  return (
    <div className="readiness">
      <div className="readiness-toolbar">
        <p aria-live="polite">
          {busy
            ? "Checking your deployment…"
            : report
              ? `Checked ${new Date(report.checkedAt).toLocaleString()}${report.cached ? " (cached)" : ""}`
              : "Not checked yet."}
        </p>
        <Button type="button" variant="secondary" size="small" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={14} />
          Re-check
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {groups.map((group) => {
        const rows = report?.checks.filter((check) => check.group === group) ?? [];
        if (report && !rows.length) return null;
        return (
          <section key={group} className="readiness-group">
            <h3>{groupLabels[group]}</h3>
            {rows.length ? (
              rows.map((check) => <ReadinessRow key={check.id} check={check} />)
            ) : (
              <p className="settings-empty">Checking…</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ReadinessRow({ check }: { check: ReadinessCheck }) {
  const Icon = statusIcons[check.status];
  return (
    <article className={`readiness-row status-${check.status}`}>
      <span className="readiness-dot" aria-hidden="true">
        <Icon size={13} />
      </span>
      <div>
        <strong>
          {check.label}
          {check.advisory && <span className="readiness-advisory">Optional</span>}
        </strong>
        <p>{check.detail}</p>
        {check.observed && <code>{check.observed}</code>}
      </div>
      <span className="readiness-status">
        {statusLabels[check.status]}
        {check.fixHref && (
          <a href={check.fixHref} target="_blank" rel="noreferrer">
            How to fix
          </a>
        )}
      </span>
    </article>
  );
}
