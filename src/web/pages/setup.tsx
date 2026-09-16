import { Link } from "react-router-dom";
import { blockingChecks, ReadinessChecklist, useReadiness } from "@/web/components/readiness-checklist";
import { Button } from "@/web/components/ui";

/**
 * First-run page. Its job is to replace silence with a list: all four mail failure
 * modes (no MX, no SPF, no DKIM, no DMARC) otherwise present identically as nothing
 * happening at all.
 */
export function SetupPage() {
  const { report, error, busy, refresh } = useReadiness();
  const blocking = report ? blockingChecks(report.checks) : [];
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Set up ResolveHQ</h1>
          <p>
            Everything this deployment needs before you route real customer mail into it. Nothing here blocks you — you
            can use ResolveHQ while you work through it.
          </p>
        </div>
        <Link to="/inbox">
          <Button variant="secondary">Continue to inbox</Button>
        </Link>
      </header>
      {report && (
        <p className={blocking.length ? "page-banner" : "settings-success"} aria-live="polite">
          {blocking.length
            ? `${blocking.length} ${blocking.length === 1 ? "check needs" : "checks need"} attention before mail works end to end.`
            : "Every required check passed. This deployment can receive and send mail."}
        </p>
      )}
      <section className="settings-section">
        <ReadinessChecklist report={report} error={error} busy={busy} onRefresh={refresh} />
      </section>
    </div>
  );
}
