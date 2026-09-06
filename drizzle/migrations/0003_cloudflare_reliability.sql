CREATE TABLE `attachment_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachment_uploads_created_idx` ON `attachment_uploads` (`created_at`);--> statement-breakpoint
CREATE TABLE `maintenance_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text,
	`customer_id` text,
	`cursor` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`dispatch_until` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_due_idx` ON `maintenance_tasks` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `ticket_search_rows` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_search_rows_ticket_idx` ON `ticket_search_rows` (`organization_id`,`ticket_id`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `cleanup_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `lease_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `dispatch_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `terminal_reason` text;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `envelope_to` text;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `envelope_from` text;--> statement-breakpoint
ALTER TABLE `inbound_mail_events` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `lease_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `dispatch_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `terminal_reason` text;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `first_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `outbound_mail_jobs` ADD `envelope` text;--> statement-breakpoint
CREATE INDEX `outbound_jobs_stale_idx` ON `outbound_mail_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `customers_created_id_idx` ON `customers` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `inboxes_lower_email_idx` ON `inboxes` (lower("email_address"));--> statement-breakpoint
CREATE INDEX `messages_orphan_queued_idx` ON `messages` (`created_at`,`id`) WHERE "messages"."author_type" = 'agent' AND "messages"."kind" = 'message' AND "messages"."delivery_status" = 'queued';--> statement-breakpoint
CREATE INDEX `password_reset_tokens_expires_idx` ON `password_reset_tokens` (`expires_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO ticket_search_rows (row_id, organization_id, ticket_id) SELECT rowid, organization_id, ticket_id FROM ticket_search;
--> statement-breakpoint
UPDATE outbound_mail_jobs SET terminal_reason = 'delivery_uncertain' WHERE status IN ('failed','processing') AND attempts > 0;
