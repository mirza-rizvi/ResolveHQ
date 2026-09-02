CREATE TABLE `inboxes` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `email_address` text NOT NULL,
  `provider` text DEFAULT 'cloudflare_email' NOT NULL,
  `is_default` integer DEFAULT 0 NOT NULL,
  `disabled_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inboxes_email_address_uidx` ON `inboxes` (`email_address`);
--> statement-breakpoint
CREATE INDEX `inboxes_organization_idx` ON `inboxes` (`organization_id`);
--> statement-breakpoint
INSERT INTO `inboxes` (`id`, `organization_id`, `name`, `email_address`, `provider`, `is_default`, `created_at`, `updated_at`)
SELECT 'inb_' || lower(hex(randomblob(12))), `id`, 'Support', lower(`support_email`), 'cloudflare_email', 1, `created_at`, `updated_at`
FROM `organizations` WHERE `support_email` IS NOT NULL AND trim(`support_email`) <> '';
--> statement-breakpoint
ALTER TABLE `tickets` ADD `inbox_id` text REFERENCES `inboxes`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `assigned_team_id` text;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `last_message_preview` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `message_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `last_customer_reply_at` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `last_agent_reply_at` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `waiting_since` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `tickets` SET
  `inbox_id` = (SELECT `id` FROM `inboxes` WHERE `inboxes`.`organization_id` = `tickets`.`organization_id` AND `is_default` = 1 LIMIT 1),
  `message_count` = (SELECT count(*) FROM `messages` WHERE `messages`.`ticket_id` = `tickets`.`id` AND `messages`.`organization_id` = `tickets`.`organization_id`),
  `last_message_preview` = coalesce((SELECT substr(`body_text`, 1, 280) FROM `messages` WHERE `messages`.`ticket_id` = `tickets`.`id` AND `messages`.`organization_id` = `tickets`.`organization_id` ORDER BY `created_at` DESC LIMIT 1), ''),
  `last_customer_reply_at` = (SELECT max(`created_at`) FROM `messages` WHERE `messages`.`ticket_id` = `tickets`.`id` AND `author_type` = 'customer'),
  `last_agent_reply_at` = (SELECT max(`created_at`) FROM `messages` WHERE `messages`.`ticket_id` = `tickets`.`id` AND `author_type` = 'agent' AND `kind` = 'message');
--> statement-breakpoint
CREATE INDEX `tickets_organization_updated_id_idx` ON `tickets` (`organization_id`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX `tickets_organization_inbox_status_idx` ON `tickets` (`organization_id`, `inbox_id`, `status`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `client_message_id` text;
--> statement-breakpoint
DROP INDEX `messages_organization_provider_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_organization_provider_uidx` ON `messages` (`organization_id`, `provider_message_id`) WHERE `provider_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_organization_client_uidx` ON `messages` (`organization_id`, `client_message_id`) WHERE `client_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `inbound_mail_events` (
  `id` text PRIMARY KEY NOT NULL, `inbox_id` text REFERENCES `inboxes`(`id`) ON DELETE set null,
  `organization_id` text REFERENCES `organizations`(`id`) ON DELETE cascade, `staging_object_key` text NOT NULL UNIQUE,
  `provider_message_id` text, `status` text DEFAULT 'staged' NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null,
  `attachment_cursor` integer DEFAULT 0 NOT NULL, `attempts` integer DEFAULT 0 NOT NULL, `last_error` text,
  `completed_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_events_inbox_provider_uidx` ON `inbound_mail_events` (`inbox_id`, `provider_message_id`) WHERE `provider_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `inbound_events_status_updated_idx` ON `inbound_mail_events` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `outbound_mail_jobs` (
  `id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
  `message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE cascade, `idempotency_key` text NOT NULL UNIQUE,
  `status` text DEFAULT 'pending' NOT NULL, `attempts` integer DEFAULT 0 NOT NULL, `next_attempt_at` integer NOT NULL,
  `provider_message_id` text, `last_error` text, `sent_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_jobs_message_uidx` ON `outbound_mail_jobs` (`message_id`);
--> statement-breakpoint
CREATE INDEX `outbound_jobs_status_next_idx` ON `outbound_mail_jobs` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE TABLE `provider_webhook_events` (
  `id` text PRIMARY KEY NOT NULL, `provider` text NOT NULL, `external_event_id` text NOT NULL, `event_type` text NOT NULL,
  `payload` text NOT NULL, `processed_at` integer, `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_webhook_event_uidx` ON `provider_webhook_events` (`provider`, `external_event_id`);
--> statement-breakpoint
CREATE TABLE `ticket_read_states` (
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
  `ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `last_read_at` integer NOT NULL,
  PRIMARY KEY (`ticket_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_read_states_org_user_idx` ON `ticket_read_states` (`organization_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE `ticket_drafts` (
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
  `ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `kind` text DEFAULT 'message' NOT NULL,
  `body` text DEFAULT '' NOT NULL, `revision` integer DEFAULT 1 NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`ticket_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `teams` (`id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade, `name` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_organization_name_uidx` ON `teams` (`organization_id`, `name`);
--> statement-breakpoint
CREATE TABLE `team_members` (`organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade, `team_id` text NOT NULL REFERENCES `teams`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `created_at` integer NOT NULL, PRIMARY KEY (`team_id`, `user_id`));
--> statement-breakpoint
CREATE INDEX `team_members_org_user_idx` ON `team_members` (`organization_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE `saved_views` (`id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade, `owner_user_id` text REFERENCES `users`(`id`) ON DELETE cascade, `name` text NOT NULL, `visibility` text DEFAULT 'personal' NOT NULL, `filters` text DEFAULT '{}' NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `saved_views_organization_owner_idx` ON `saved_views` (`organization_id`, `owner_user_id`);
--> statement-breakpoint
CREATE TABLE `notifications` (`id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `ticket_id` text REFERENCES `tickets`(`id`) ON DELETE cascade, `type` text NOT NULL, `title` text NOT NULL, `read_at` integer, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `notifications_org_user_read_idx` ON `notifications` (`organization_id`, `user_id`, `read_at`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `ticket_search` USING fts5(`organization_id` UNINDEXED, `ticket_id` UNINDEXED, `content`, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
INSERT INTO `ticket_search` (`organization_id`, `ticket_id`, `content`)
SELECT t.`organization_id`, t.`id`, t.`normalized_search` || ' ' || coalesce(group_concat(m.`normalized_search`, ' '), '') || ' ' || coalesce(group_concat(g.`name`, ' '), '')
FROM `tickets` t LEFT JOIN `messages` m ON m.`ticket_id` = t.`id` AND m.`organization_id` = t.`organization_id`
LEFT JOIN `ticket_tags` tt ON tt.`ticket_id` = t.`id` AND tt.`organization_id` = t.`organization_id`
LEFT JOIN `tags` g ON g.`id` = tt.`tag_id` AND g.`organization_id` = t.`organization_id`
GROUP BY t.`id`;
