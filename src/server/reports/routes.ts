import { Hono } from "hono";
import { requireAuth, requireRole } from "../auth/middleware";
import { HttpError } from "../http/errors";
import type { HonoEnv } from "../types";

const dayMs = 86_400_000;
const maximumWindowDays = 92;
const maximumSamples = 10_000;

interface Window {
  from: number;
  to: number;
}

function parseWindow(context: { req: { query: (name: string) => string | undefined } }): Window {
  const to = context.req.query("to") ? Date.parse(context.req.query("to")!) : Date.now();
  const from = context.req.query("from") ? Date.parse(context.req.query("from")!) : to - 30 * dayMs;
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new HttpError(400, "invalid_window", "Dates must be ISO 8601, for example ?from=2026-08-01&to=2026-08-31.");
  if (from > to) throw new HttpError(400, "invalid_window", "The start date must come before the end date.");
  if (to - from > maximumWindowDays * dayMs)
    throw new HttpError(400, "window_too_large", "Pick a window of 92 days or fewer.");
  return { from, to };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

/** Cohorts: created = ticket created in the window; resolution uses only tickets created in the window. */
export const reportRoutes = new Hono<HonoEnv>();
reportRoutes.use("*", requireAuth);

reportRoutes.get("/summary", async (context) => {
  const tenant = context.get("tenant");
  const { from, to } = parseWindow(context);
  const db = context.env.DB;
  const totals = await db
    .prepare(
      `SELECT count(*) AS created,
              sum(status IN ('resolved','closed')) AS resolvedWithinWindow,
              sum(status NOT IN ('resolved','closed')) AS stillOpen,
              sum(priority = 'urgent') AS urgent
       FROM tickets WHERE organization_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(tenant.organizationId, from, to)
    .first<Record<string, number>>();
  const responseTimes = await db
    .prepare(
      `SELECT (SELECT min(m.created_at) FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id AND m.author_type = 'agent') - t.created_at AS firstResponseMinutes
       FROM tickets t
       WHERE t.organization_id = ? AND t.created_at >= ? AND t.created_at < ?
       ORDER BY t.id LIMIT ${maximumSamples}`,
    )
    .bind(tenant.organizationId, from, to)
    .all<{ firstResponseMinutes: number | null }>();
  const resolutions = await db
    .prepare(
      `SELECT resolved_at - created_at AS resolutionMinutes FROM tickets
       WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND resolved_at IS NOT NULL
       ORDER BY id LIMIT ${maximumSamples}`,
    )
    .bind(tenant.organizationId, from, to)
    .all<{ resolutionMinutes: number | null }>();
  const byStatus = await db
    .prepare(
      `SELECT status, count(*) AS count FROM tickets
       WHERE organization_id = ? AND created_at >= ? AND created_at < ? GROUP BY status`,
    )
    .bind(tenant.organizationId, from, to)
    .all<{ status: string; count: number }>();
  const byPriority = await db
    .prepare(
      `SELECT priority, count(*) AS count FROM tickets
       WHERE organization_id = ? AND created_at >= ? AND created_at < ? GROUP BY priority`,
    )
    .bind(tenant.organizationId, from, to)
    .all<{ priority: string; count: number }>();
  const days = Math.max(1, Math.round((to - from) / dayMs));
  const createdSeries = await db
    .prepare(
      `SELECT (created_at - ?) / ${dayMs} AS offset, count(*) AS count FROM tickets
       WHERE organization_id = ? AND created_at >= ? AND created_at < ? GROUP BY offset`,
    )
    .bind(from, tenant.organizationId, from, to)
    .all<{ offset: number; count: number }>();
  const resolvedSeries = await db
    .prepare(
      `SELECT (resolved_at - ?) / ${dayMs} AS offset, count(*) AS count FROM tickets
       WHERE organization_id = ? AND resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at < ? GROUP BY offset`,
    )
    .bind(from, tenant.organizationId, from, to)
    .all<{ offset: number; count: number }>();
  const createdByDay = new Map(createdSeries.results.map((row) => [row.offset, row.count]));
  const resolvedByDay = new Map(resolvedSeries.results.map((row) => [row.offset, row.count]));
  const series = Array.from({ length: days }, (_, index) => ({
    day: from + index * dayMs,
    created: createdByDay.get(index) ?? 0,
    resolved: resolvedByDay.get(index) ?? 0,
  }));
  const responseSamples = responseTimes.results
    .map((row) => row.firstResponseMinutes)
    .filter((value): value is number => value != null)
    .map((ms) => Math.round(ms / 60_000));
  const resolutionSamples = resolutions.results
    .map((row) => row.resolutionMinutes)
    .filter((value): value is number => value != null)
    .map((ms) => Math.round(ms / 60_000));
  const average = (values: number[]) =>
    values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
  return context.json({
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    totals: {
      created: totals?.created ?? 0,
      resolved: totals?.resolvedWithinWindow ?? 0,
      stillOpen: totals?.stillOpen ?? 0,
      urgent: totals?.urgent ?? 0,
    },
    response: { medianMinutes: median(responseSamples), averageMinutes: average(responseSamples) },
    resolution: { medianMinutes: median(resolutionSamples), averageMinutes: average(resolutionSamples) },
    byStatus: Object.fromEntries(byStatus.results.map((row) => [row.status, row.count])),
    byPriority: Object.fromEntries(byPriority.results.map((row) => [row.priority, row.count])),
    series,
  });
});

reportRoutes.get("/export", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const { from, to } = parseWindow(context);
  const rows = await context.env.DB.prepare(
    `SELECT t.number, t.subject, t.status, t.priority, t.created_at AS createdAt, t.resolved_at AS resolvedAt,
              c.name AS customerName, c.email AS customerEmail, u.name AS assignee,
              (SELECT count(*) FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id AND m.author_type = 'agent') AS agentReplies,
              (SELECT min(m.created_at) FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id AND m.author_type = 'agent') AS firstAgentReplyAt
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id
       LEFT JOIN users u ON u.id = t.assigned_user_id
       WHERE t.organization_id = ? AND t.created_at >= ? AND t.created_at < ?
       ORDER BY t.created_at, t.id LIMIT 20_000`,
  )
    .bind(tenant.organizationId, from, to)
    .all<Record<string, string | number | null>>();
  const header = [
    "number",
    "subject",
    "status",
    "priority",
    "customer",
    "customer email",
    "assignee",
    "created",
    "first response minutes",
    "resolution minutes",
    "agent replies",
  ];
  const cell = (value: string | number | null) => {
    const text = value == null ? "" : String(value);
    // Prefix guard keeps spreadsheet applications from evaluating formulas.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = [header.join(",")];
  for (const row of rows.results) {
    lines.push(
      [
        row.number,
        row.subject,
        row.status,
        row.priority,
        row.customerName,
        row.customerEmail,
        row.assignee,
        row.createdAt != null ? new Date(Number(row.createdAt)).toISOString() : "",
        row.firstAgentReplyAt != null
          ? Math.round((Number(row.firstAgentReplyAt) - Number(row.createdAt)) / 60_000)
          : "",
        row.resolvedAt != null ? Math.round((Number(row.resolvedAt) - Number(row.createdAt)) / 60_000) : "",
        row.agentReplies,
      ]
        .map(cell)
        .join(","),
    );
  }
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="resolvehq-report-${new Date(from).toISOString().slice(0, 10)}.csv"`,
    },
  });
});
