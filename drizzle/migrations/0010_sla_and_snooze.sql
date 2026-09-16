CREATE TABLE `sla_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `priority` text,
  `first_response_minutes` integer,
  `resolution_minutes` integer,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `sla_policies_org_enabled_idx` ON `sla_policies` (`organization_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `sla_policies_org_priority_uidx` ON `sla_policies` (`organization_id`,`priority`) WHERE `priority` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sla_policies_org_default_uidx` ON `sla_policies` (`organization_id`) WHERE `priority` IS NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `sla_policy_id` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `first_response_due_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resolution_due_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `first_response_at` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `sla_state` text NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE `tickets` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `snooze_reason` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `snoozed_total_ms` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `tickets` ADD `snooze_started_at` integer;--> statement-breakpoint
CREATE INDEX `tickets_org_sla_due_idx` ON `tickets` (`organization_id`,`sla_state`,`first_response_due_at`);--> statement-breakpoint
CREATE INDEX `tickets_org_snoozed_idx` ON `tickets` (`organization_id`,`snoozed_until`) WHERE `snoozed_until` IS NOT NULL;
