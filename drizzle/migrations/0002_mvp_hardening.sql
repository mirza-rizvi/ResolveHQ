ALTER TABLE `messages` ADD `rfc_message_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_organization_rfc_uidx` ON `messages` (`organization_id`, `rfc_message_id`) WHERE `rfc_message_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `messages` SET `rfc_message_id` = `provider_message_id` WHERE `author_type` = 'customer' AND `provider_message_id` LIKE '<%';
--> statement-breakpoint
CREATE TABLE `mail_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	`to_address` text NOT NULL,
	`from_address` text NOT NULL,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`headers` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_captures_org_created_idx` ON `mail_captures` (`organization_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `mail_captures_to_created_idx` ON `mail_captures` (`to_address`,`created_at`);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	`token_hash` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `password_reset_tokens_user_idx` ON `password_reset_tokens` (`user_id`);
--> statement-breakpoint
CREATE TABLE `attachments_new` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	`ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	`message_id` text REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	`object_key` text NOT NULL UNIQUE,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`uploaded_by_user_id` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `attachments_new` (`id`, `organization_id`, `ticket_id`, `message_id`, `object_key`, `filename`, `content_type`, `size`, `checksum`, `uploaded_by_user_id`, `created_at`)
SELECT `id`, `organization_id`, `ticket_id`, `message_id`, `object_key`, `filename`, `content_type`, `size`, `checksum`, `uploaded_by_user_id`, `created_at` FROM `attachments`;
--> statement-breakpoint
DROP TABLE `attachments`;
--> statement-breakpoint
ALTER TABLE `attachments_new` RENAME TO `attachments`;
--> statement-breakpoint
CREATE INDEX `attachments_organization_ticket_idx` ON `attachments` (`organization_id`,`ticket_id`);
--> statement-breakpoint
CREATE INDEX `attachments_organization_message_idx` ON `attachments` (`organization_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX `attachments_pending_idx` ON `attachments` (`message_id`,`created_at`) WHERE `message_id` IS NULL;
