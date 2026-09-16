import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TriangleAlert, X } from "lucide-react";
import { blockingChecks, useReadiness } from "./readiness-checklist";

const DISMISS_KEY = "resolvehq-setup-banner-dismissed";

/**
 * Shown while a required readiness check is failing. Dismissal is remembered, and the
 * banner stays gone once the checks pass, so it never becomes background noise.
 *
 * Advisory rows — DMARC, AI, Turnstile when off — never raise it.
 */
export function SetupBanner() {
  const { report } = useReadiness();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const blocking = report ? blockingChecks(report.checks) : [];

  // Once the deployment is healthy the dismissal is cleared, so a later regression
  // can raise the banner again instead of being permanently silenced.
  useEffect(() => {
    if (report && !blocking.length && dismissed) {
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch {
        /* Storage is unavailable in private mode; the banner simply reappears. */
      }
      setDismissed(false);
    }
  }, [report, blocking.length, dismissed]);

  if (!report || !blocking.length || dismissed) return null;
  return (
    <div className="setup-banner" role="status">
      <TriangleAlert size={16} />
      <p>
        {blocking.length === 1
          ? `Setup incomplete: ${blocking[0].label} is not working.`
          : `Setup incomplete: ${blocking.length} checks are not working.`}{" "}
        <Link to="/setup">Review setup</Link>
      </p>
      <button
        type="button"
        aria-label="Dismiss setup notice"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* Dismissal is a convenience; losing it is harmless. */
          }
          setDismissed(true);
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
