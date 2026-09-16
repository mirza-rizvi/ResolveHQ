import { and, eq, isNull, or } from "drizzle-orm";
import { createDb } from "../db";
import { settings, slaPolicies, tickets } from "../db/schema";
import type { AppBindings } from "../types";
import type { TicketPriority } from "../../shared/domain";
import { addBusinessMinutes, type BusinessHours } from "./policy";

export const BUSINESS_HOURS_KEY = "business_hours";

export type SlaPolicy = typeof slaPolicies.$inferSelect;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a stored business-hours value. Settings rows are free-form JSON, so a value
 * written by an older version — or by hand — must not be able to break due-date maths.
 * Anything unrecognisable is treated as "not configured", which means 24/7.
 */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<BusinessHours>;
  if (typeof raw.timezone !== "string" || !raw.timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone });
  } catch {
    return null;
  }
  const days = Array.isArray(raw.days)
    ? raw.days.filter(
        (day) =>
          day &&
          Number.isInteger(day.day) &&
          day.day >= 0 &&
          day.day <= 6 &&
          typeof day.start === "string" &&
          typeof day.end === "string" &&
          TIME_PATTERN.test(day.start) &&
          TIME_PATTERN.test(day.end),
      )
    : [];
  if (!days.length) return null;
  const holidays = Array.isArray(raw.holidays)
    ? raw.holidays.filter((entry): entry is string => typeof entry === "string" && DATE_PATTERN.test(entry))
    : [];
  return { timezone: raw.timezone, days, holidays };
}

/** Days configured with an end at or before their start never open. The UI warns about these. */
export function misconfiguredDays(hours: BusinessHours | null): number[] {
  if (!hours) return [];
  return hours.days.filter((day) => day.end <= day.start).map((day) => day.day);
}

export async function readBusinessHours(env: AppBindings, organizationId: string): Promise<BusinessHours | null> {
  const [row] = await createDb(env.DB)
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, BUSINESS_HOURS_KEY)))
    .limit(1);
  return parseBusinessHours(row?.value);
}

/**
 * Picks the policy for a priority: an exact priority match wins, otherwise the
 * workspace default (the row with a null priority). Disabled policies never apply.
 */
export async function resolvePolicy(
  env: AppBindings,
  organizationId: string,
  priority: TicketPriority,
): Promise<SlaPolicy | null> {
  const rows = await createDb(env.DB)
    .select()
    .from(slaPolicies)
    .where(
      and(
        eq(slaPolicies.organizationId, organizationId),
        eq(slaPolicies.enabled, true),
        or(eq(slaPolicies.priority, priority), isNull(slaPolicies.priority)),
      ),
    );
  return rows.find((row) => row.priority === priority) ?? rows.find((row) => row.priority === null) ?? null;
}

export interface SlaTargets {
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  slaState: "none" | "ok";
}

/** No policy means `none`: a helpdesk that starts reporting breaches on day one is worse than a quiet one. */
export const NO_SLA: SlaTargets = {
  slaPolicyId: null,
  firstResponseDueAt: null,
  resolutionDueAt: null,
  slaState: "none",
};

/**
 * Computes both due dates from `createdAt` — never from now. Recomputing from the
 * present would let an agent clear a breach by toggling priority back and forth.
 *
 * `pausedMs` is time the ticket spent snoozed, which shifts the targets forward so the
 * SLA clock genuinely pauses rather than merely being ignored.
 */
export function computeTargets(
  policy: SlaPolicy | null,
  createdAt: number,
  hours: BusinessHours | null,
  pausedMs = 0,
): SlaTargets {
  if (!policy || (policy.firstResponseMinutes === null && policy.resolutionMinutes === null)) return NO_SLA;
  const due = (minutes: number | null) =>
    minutes === null ? null : new Date(addBusinessMinutes(createdAt, minutes, hours) + pausedMs);
  return {
    slaPolicyId: policy.id,
    firstResponseDueAt: due(policy.firstResponseMinutes),
    resolutionDueAt: due(policy.resolutionMinutes),
    slaState: "ok",
  };
}

/** Resolves the policy and computes targets in one step, for the ticket write paths. */
export async function targetsFor(
  env: AppBindings,
  organizationId: string,
  priority: TicketPriority,
  createdAt: number,
  pausedMs = 0,
): Promise<SlaTargets> {
  const policy = await resolvePolicy(env, organizationId, priority);
  if (!policy) return NO_SLA;
  return computeTargets(policy, createdAt, await readBusinessHours(env, organizationId), pausedMs);
}

/**
 * Applies recomputed targets to a ticket after a priority change.
 *
 * A ticket that has already had its first response keeps `sla_state` as it stands for
 * that half of the policy; the state itself is re-derived by the cron, which is the
 * single writer of `due_soon` and `breached`.
 */
export async function refreshTicketTargets(
  env: AppBindings,
  organizationId: string,
  ticket: { id: string; priority: TicketPriority; createdAt: Date; snoozedTotalMs: number; firstResponseAt: Date | null },
) {
  const targets = await targetsFor(
    env,
    organizationId,
    ticket.priority,
    ticket.createdAt.getTime(),
    ticket.snoozedTotalMs,
  );
  await createDb(env.DB)
    .update(tickets)
    .set({
      slaPolicyId: targets.slaPolicyId,
      firstResponseDueAt: targets.firstResponseDueAt,
      resolutionDueAt: targets.resolutionDueAt,
      slaState: targets.slaState,
    })
    .where(and(eq(tickets.id, ticket.id), eq(tickets.organizationId, organizationId)));
  return targets;
}
