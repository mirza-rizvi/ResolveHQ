CREATE TABLE `backups` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL DEFAULT 'running',
  `object_prefix` text NOT NULL,
  `size_bytes` integer NOT NULL DEFAULT 0,
  `row_counts` text NOT NULL DEFAULT '{}',
  `cursor` text,
  `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `started_at` integer NOT NULL,
  `completed_at` integer,
  `expires_at` integer,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `backups_org_started_idx` ON `backups` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `backups_expiry_idx` ON `backups` (`expires_at`) WHERE `expires_at` IS NOT NULL;
