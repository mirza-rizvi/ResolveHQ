import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLogs } from "../db/schema";
import { createDb } from "../db";
import { automationRules, automationRuns, customers, notifications, tags, ticketTags, tickets } from "../db/schema";
import { newId } from "../lib/id";
import { assertActiveMember } from "../tickets/service";
import type { AppBindings } from "../types";
import { ticketPriorities, ticketStatuses } from "../../shared/domain";

export const conditionSchema = z.object({
  field: z.enum(["subject", "priority", "status", "customerEmail", "inboxId"]),
  op: z.enum(["is", "contains"]),
  value: z.string().trim().min(1).max(240),
});

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_priority"), priority: z.enum(ticketPriorities) }),
  z.object({ type: z.literal("set_status"), status: z.enum(ticketStatuses) }),
  z.object({ type: z.literal("assign_user"), userId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("add_tag"), name: z.string().trim().min(1).max(40) }),
]);

export const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  conditions: z.array(conditionSchema).min(1).max(5),
  actions: z.array(actionSchema).min(1).max(5),
});
type Condition = z.infer<typeof conditionSchema>;

interface AutomationTicket {
  ticket: typeof tickets.$inferSelect;
  customerEmail: string;
}

function matches(condition: Condition, state: AutomationTicket): boolean {
  const haystack =
    condition.field === "subject"
      ? state.ticket.subject
      : condition.field === "priority"
        ? state.ticket.priority
        : condition.field === "status"
          ? state.ticket.status
          : condition.field === "customerEmail"
            ? state.customerEmail
            : (state.ticket.inboxId ?? "");
  const needle = condition.value.toLowerCase();
  const target = haystack.toLowerCase();
  return condition.op === "is" ? target === needle : target.includes(needle);
}

/**
 * Runs enabled rules against one ticket. The same event key can never trigger a
 * rule twice: the run row insert is the deduplication point, so a replayed queue
 * message or overlapping request applies each rule at most once per event.
 */
export async function applyAutomations(
  env: AppBindings,
  organizationId: string,
  ticketId: string,
  eventKey = "created",
): Promise<void> {
  const db = createDb(env.DB);
  const [row] = await db
    .select({ ticket: tickets, customerEmail: customers.email })
    .from(tickets)
    .innerJoin(
      customers,
      and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tickets.organizationId)),
    )
    .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)))
    .limit(1);
  if (!row) return;
  const state: AutomationTicket = { ticket: row.ticket, customerEmail: row.customerEmail };
  const rules = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.organizationId, organizationId), eq(automationRules.enabled, true)))
    .orderBy(asc(automationRules.position), asc(automationRules.id))
    .limit(50);
  const now = new Date();
  for (const rule of rules) {
    const conditions = z.array(conditionSchema).max(5).safeParse(rule.conditions);
    if (!conditions.success || !conditions.data.every((condition) => matches(condition, state))) continue;
    const claimed = await db
      .insert(automationRuns)
      .values({
        id: newId("run"),
        organizationId,
        ruleId: rule.id,
        ticketId,
        eventKey,
        applied: "[]",
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: automationRuns.id });
    if (!claimed.length) continue;
    const applied: string[] = [];
    const actions = z.array(actionSchema).max(5).safeParse(rule.actions);
    for (const action of actions.success ? actions.data : []) {
      try {
        if (action.type === "set_priority" && state.ticket.priority !== action.priority) {
          await db
            .update(tickets)
            .set({ priority: action.priority, version: sql`${tickets.version} + 1`, updatedAt: now })
            .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)));
          state.ticket = { ...state.ticket, priority: action.priority };
          await db.insert(activityLogs).values({
            id: newId("act"),
            organizationId,
            ticketId,
            actorUserId: null,
            eventType: "automation.priority_changed",
            entityType: "ticket",
            entityId: ticketId,
            metadata: { rule: rule.name, to: action.priority },
            requestId: "automation",
          });
          applied.push(`priority:${action.priority}`);
        } else if (action.type === "set_status" && state.ticket.status !== action.status) {
          await db
            .update(tickets)
            .set({
              status: action.status,
              resolvedAt: action.status === "resolved" ? now : null,
              closedAt: action.status === "closed" ? now : null,
              waitingSince: action.status === "waiting_customer" ? (state.ticket.waitingSince ?? now) : null,
              version: sql`${tickets.version} + 1`,
              updatedAt: now,
            })
            .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)));
          state.ticket = { ...state.ticket, status: action.status };
          applied.push(`status:${action.status}`);
        } else if (action.type === "assign_user" && state.ticket.assignedUserId !== action.userId) {
          await assertActiveMember(env.DB, organizationId, action.userId);
          await db
            .update(tickets)
            .set({ assignedUserId: action.userId, version: sql`${tickets.version} + 1`, updatedAt: now })
            .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)));
          await db.insert(notifications).values({
            id: newId("ntf"),
            organizationId,
            userId: action.userId,
            ticketId,
            type: "ticket.assigned",
            title: `Ticket #${state.ticket.number} was assigned by automation “${rule.name}”`,
          });
          state.ticket = { ...state.ticket, assignedUserId: action.userId };
          applied.push(`assigned:${action.userId}`);
        } else if (action.type === "add_tag") {
          const name = action.name.toLowerCase();
          await db
            .insert(tags)
            .values({ id: newId("tag"), organizationId, name })
            .onConflictDoNothing();
          const [tag] = await db
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.organizationId, organizationId), eq(tags.name, name)))
            .limit(1);
          if (tag) {
            await db.insert(ticketTags).values({ organizationId, ticketId, tagId: tag.id }).onConflictDoNothing();
            applied.push(`tag:${name}`);
          }
        }
      } catch {
        // One broken action (missing assignee, dropped connection) must not stop the remaining rules.
      }
    }
    await db
      .update(automationRuns)
      .set({ applied: JSON.stringify(applied) })
      .where(eq(automationRuns.id, claimed[0].id));
  }
}
