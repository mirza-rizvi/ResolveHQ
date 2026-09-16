CREATE TABLE `webhook_endpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'generic',
  `url` text NOT NULL,
  `secret` text NOT NULL,
  `config` text NOT NULL DEFAULT '{}',
  `events` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT 1,
  `failure_count` integer NOT NULL DEFAULT 0,
  `disabled_at` integer,
  `last_success_at` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `webhook_endpoints_org_enabled_idx` ON `webhook_endpoints` (`organization_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `endpoint_id` text NOT NULL REFERENCES `webhook_endpoints`(`id`) ON DELETE CASCADE,
  `event` text NOT NULL,
  `payload` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `next_attempt_at` integer,
  `response_code` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_retry_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`) WHERE `status` = 'pending';--> statement-breakpoint
CREATE INDEX `webhook_deliveries_org_endpoint_idx` ON `webhook_deliveries` (`organization_id`,`endpoint_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `sla_breach_notified_at` integer;
