CREATE TABLE `knowledge_base_articles` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `title` text NOT NULL,
  `slug` text NOT NULL,
  `category` text,
  `body` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft',
  `version` integer NOT NULL DEFAULT 1,
  `published_at` integer,
  `created_by_user_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_organization_slug_uidx` ON `knowledge_base_articles` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `kb_organization_status_idx` ON `knowledge_base_articles` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `name` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `position` integer NOT NULL DEFAULT 0,
  `conditions` text NOT NULL,
  `actions` text NOT NULL,
  `created_by_user_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `automation_rules_organization_idx` ON `automation_rules` (`organization_id`,`position`,`id`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `rule_id` text NOT NULL,
  `ticket_id` text NOT NULL,
  `event_key` text NOT NULL,
  `applied` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_event_uidx` ON `automation_runs` (`organization_id`,`event_key`,`rule_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_ticket_idx` ON `automation_runs` (`organization_id`,`ticket_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_rule_idx` ON `automation_runs` (`organization_id`,`rule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tickets_organization_created_idx` ON `tickets` (`organization_id`,`created_at`);

CREATE TABLE `mail_dlq_events` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `reference` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_dlq_events_reference_uidx` ON `mail_dlq_events` (`id`);
