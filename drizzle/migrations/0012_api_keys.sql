CREATE TABLE `api_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `prefix` text NOT NULL,
  `key_hash` text NOT NULL,
  `scopes` text NOT NULL DEFAULT '[]',
  `inbox_ids` text,
  `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `last_used_at` integer,
  `expires_at` integer,
  `revoked_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uidx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_org_revoked_idx` ON `api_keys` (`organization_id`,`revoked_at`);
