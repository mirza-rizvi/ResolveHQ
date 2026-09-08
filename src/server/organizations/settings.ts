import { and, eq } from "drizzle-orm";
import { createDb } from "../db";
import { settings } from "../db/schema";

export const AI_SETTING_KEY = "ai.enabled";

/**
 * AI is opt-in per workspace: the Worker key only makes the feature available,
 * and an absent setting means disabled. Nothing may call the provider before
 * this check passes for the requesting organization.
 */
export async function readAiEnabled(database: D1Database, organizationId: string): Promise<boolean> {
  const [row] = await createDb(database)
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, AI_SETTING_KEY)))
    .limit(1);
  return row?.value === true;
}
