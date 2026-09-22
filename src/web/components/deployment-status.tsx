import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

interface Readiness {
  ok: boolean;
  database?: string;
  detail?: string;
}

/**
 * Shown above the sign-in form when the deployment cannot serve requests.
 *
 * `/setup` and the readiness report both require an admin session, so the one person a
 * broken deployment strands — the operator who cannot create the first account — had no
 * way to see what was wrong. `/api/ready` is deliberately unauthenticated and reports a
 * count, never schema details.
 */
export function DeploymentStatus() {
  const [status, setStatus] = useState<Readiness | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/ready")
      .then((response) => response.json() as Promise<Readiness>)
      .then((body) => {
        if (!cancelled) setStatus(body);
      })
      // A network failure is the browser's problem to report, not ours to guess at.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || status.ok) return null;
  return (
    <p className="auth-deployment-status" role="alert">
      <TriangleAlert size={14} />
      <span>
        {status.detail ?? "This deployment is not ready to serve requests yet."}{" "}
        <a href="https://github.com/mirza-rizvi/ResolveHQ/blob/dev/docs/deployment.md" rel="noreferrer">
          Deployment guide
        </a>
      </span>
    </p>
  );
}
