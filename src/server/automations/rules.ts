import { z } from "zod";
import { ticketPriorities, ticketStatuses } from "resolve-shared/domain";
import { HttpError } from "resolve-server/http/errors";

const identifier = z.string().min(1).max(160);
export const conditionsSchema = z
  .object({
    subjectContains: z.string().trim().min(1).max(200).optional(),
    inboxId: identifier.optional(),
    priority: z.enum(ticketPriorities).optional(),
    status: z.enum(ticketStatuses).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one condition.");
export const actionsSchema = z
  .object({
    assignedUserId: identifier.nullable().optional(),
    priority: z.enum(ticketPriorities).optional(),
    status: z.enum(ticketStatuses).optional(),
    tagId: identifier.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose at least one action.");
export const ruleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    position: z.number().int().min(0).max(9999).default(0),
    conditions: conditionsSchema,
    actions: actionsSchema,
  })
  .strict();
export type RuleInput = z.infer<typeof ruleSchema>;
export interface Rule extends RuleInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
export interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  position: number;
  conditions: string;
  actions: string;
  created_at: number;
  updated_at: number;
}
export function decodeRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    position: row.position,
    conditions: conditionsSchema.parse(JSON.parse(row.conditions)),
    actions: actionsSchema.parse(JSON.parse(row.actions)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function matchesRule(
  conditions: RuleInput["conditions"],
  ticket: {
    subject: string;
    inboxId: string | null;
    priority: string;
    status: string;
  },
): boolean {
  return (
    (!conditions.subjectContains || ticket.subject.toLowerCase().includes(conditions.subjectContains.toLowerCase())) &&
    (!conditions.inboxId || ticket.inboxId === conditions.inboxId) &&
    (!conditions.priority || ticket.priority === conditions.priority) &&
    (!conditions.status || ticket.status === conditions.status)
  );
}

export async function validRuleReferences(
  database: D1Database,
  organizationId: string,
  rule: RuleInput,
): Promise<boolean> {
  const checks: D1PreparedStatement[] = [];
  if (rule.conditions.inboxId)
    checks.push(
      database
        .prepare("SELECT id FROM inboxes WHERE organization_id = ? AND id = ?")
        .bind(organizationId, rule.conditions.inboxId),
    );
  if (rule.actions.assignedUserId)
    checks.push(
      database
        .prepare(
          "SELECT user_id FROM organization_memberships WHERE organization_id = ? AND user_id = ? AND disabled_at IS NULL",
        )
        .bind(organizationId, rule.actions.assignedUserId),
    );
  if (rule.actions.tagId)
    checks.push(
      database
        .prepare("SELECT id FROM tags WHERE organization_id = ? AND id = ?")
        .bind(organizationId, rule.actions.tagId),
    );
  if (!checks.length) return true;
  const results = await database.batch(checks);
  return results.every((result) => result.results.length > 0);
}
export async function assertRuleReferences(database: D1Database, organizationId: string, rule: RuleInput) {
  if (!(await validRuleReferences(database, organizationId, rule))) {
    throw new HttpError(
      400,
      "invalid_rule_reference",
      "Choose an inbox, active teammate, and tag from this workspace.",
    );
  }
}
