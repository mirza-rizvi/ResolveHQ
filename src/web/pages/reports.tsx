import { useEffect, useState } from "react";
import { ChartNoAxesColumn, Download } from "lucide-react";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui";

interface Summary {
  window: { from: string; to: string };
  totals: { created: number; resolved: number; stillOpen: number; urgent: number };
  response: { medianMinutes: number | null; averageMinutes: number | null };
  resolution: { medianMinutes: number | null; averageMinutes: number | null };
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  series: Array<{ day: number; created: number; resolved: number }>;
}

const windows = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const minutes = (value: number | null) => {
  if (value == null) return "—";
  if (value < 60) return `${Math.round(value)} min`;
  const hours = value / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`;
};

export function ReportsPage() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    const to = new Date().toISOString();
    setSummary(null);
    setError("");
    api<Summary>(`/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason, "Reports could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const peak = Math.max(1, ...(summary?.series.map((point) => Math.max(point.created, point.resolved)) ?? [1]));
  const exportHref = `/api/reports/export?from=${encodeURIComponent(new Date(Date.now() - days * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Reports</h1>
          <p>
            Ticket volume and speed for conversations created in the window. Resolution times only count tickets created
            in the same window.
          </p>
        </div>
        <div className="report-window">
          <select aria-label="Report window" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {windows.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
          <a className="button button-secondary button-small" href={exportHref} download>
            <Download size={13} />
            CSV
          </a>
        </div>
      </header>
      {error && (
        <p className="page-error">
          {error}{" "}
          <Button variant="secondary" size="small" onClick={() => setDays((current) => current)}>
            Retry
          </Button>
        </p>
      )}
      {!summary && !error && <div className="route-loading" aria-label="Loading reports" />}
      {summary && (
        <>
          <section className="measure-strip" aria-label="Window totals">
            {(
              [
                ["Created", summary.totals.created],
                ["Resolved", summary.totals.resolved],
                ["Still open", summary.totals.stillOpen],
                ["Urgent", summary.totals.urgent],
                ["First response", minutes(summary.response.medianMinutes)],
                ["Resolution", minutes(summary.resolution.medianMinutes)],
              ] as Array<[string, number | string]>
            ).map(([label, value]) => (
              <span key={label}>
                <strong>{value}</strong>
                {label}
              </span>
            ))}
          </section>
          <section className="report-series" aria-label="Tickets per day">
            <div className="section-heading">
              <h2>
                <ChartNoAxesColumn size={16} />
                Volume per day
              </h2>
              <span>
                created {summary.totals.created} · resolved {summary.totals.resolved}
              </span>
            </div>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Created</th>
                  <th>Resolved</th>
                  <th className="report-bars" aria-label="Relative volume" />
                </tr>
              </thead>
              <tbody>
                {summary.series.map((point) => (
                  <tr key={point.day}>
                    <td>{new Date(point.day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                    <td>{point.created}</td>
                    <td>{point.resolved}</td>
                    <td className="report-bars">
                      <div className="report-bar-track">
                        <i className="created" style={{ width: `${(point.created / peak) * 100}%` }} />
                        <i className="resolved" style={{ width: `${(point.resolved / peak) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="report-breakdown">
            <div>
              <div className="section-heading">
                <h2>By status</h2>
              </div>
              <table className="report-table">
                <tbody>
                  {Object.entries(summary.byStatus).map(([status, count]) => (
                    <tr key={status}>
                      <td>{status}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                  {!Object.keys(summary.byStatus).length && (
                    <tr>
                      <td>No tickets in this window.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div>
              <div className="section-heading">
                <h2>By priority</h2>
              </div>
              <table className="report-table">
                <tbody>
                  {Object.entries(summary.byPriority).map(([priority, count]) => (
                    <tr key={priority}>
                      <td>{priority}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                  {!Object.keys(summary.byPriority).length && (
                    <tr>
                      <td>No tickets in this window.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
