CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text,
	`actor_user_id` text,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`request_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_logs_organization_created_idx` ON `activity_logs` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_logs_organization_ticket_idx` ON `activity_logs` (`organization_id`,`ticket_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`message_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`uploaded_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_object_key_unique` ON `attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `attachments_organization_ticket_idx` ON `attachments` (`organization_id`,`ticket_id`);--> statement-breakpoint
CREATE INDEX `attachments_organization_message_idx` ON `attachments` (`organization_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `customer_tags` (
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`customer_id`, `tag_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_tags_organization_tag_idx` ON `customer_tags` (`organization_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`company` text,
	`phone` text,
	`notes` text,
	`normalized_search` text DEFAULT '' NOT NULL,
	`last_contacted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_organization_email_uidx` ON `customers` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `customers_organization_name_idx` ON `customers` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX `customers_organization_last_contact_idx` ON `customers` (`organization_id`,`last_contacted_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_user_id` text,
	`author_customer_id` text,
	`kind` text DEFAULT 'message' NOT NULL,
	`body_text` text NOT NULL,
	`body_html` text,
	`normalized_search` text DEFAULT '' NOT NULL,
	`provider_message_id` text,
	`delivery_status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_organization_ticket_created_idx` ON `messages` (`organization_id`,`ticket_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_organization_provider_idx` ON `messages` (`organization_id`,`provider_message_id`);--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_hash_unique` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_organization_email_idx` ON `organization_invitations` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `invitations_expires_idx` ON `organization_invitations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `organization_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_organization_role_idx` ON `organization_memberships` (`organization_id`,`role`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`support_email` text,
	`next_ticket_number` integer DEFAULT 1001 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `saved_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`category` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `saved_replies_organization_category_idx` ON `saved_replies` (`organization_id`,`category`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`user_agent` text,
	`ip_hash` text,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_organization_idx` ON `sessions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `key`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'slate' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_organization_name_uidx` ON `tags` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `ticket_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`assigned_to_user_id` text,
	`assigned_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ticket_assignments_organization_ticket_idx` ON `ticket_assignments` (`organization_id`,`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_tags` (
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `tag_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_tags_organization_tag_idx` ON `ticket_tags` (`organization_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`number` integer NOT NULL,
	`customer_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assigned_user_id` text,
	`normalized_search` text DEFAULT '' NOT NULL,
	`last_reply_at` integer,
	`resolved_at` integer,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_organization_number_uidx` ON `tickets` (`organization_id`,`number`);--> statement-breakpoint
CREATE INDEX `tickets_organization_status_updated_idx` ON `tickets` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `tickets_organization_assignee_status_idx` ON `tickets` (`organization_id`,`assigned_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `tickets_organization_customer_idx` ON `tickets` (`organization_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `tickets_organization_priority_idx` ON `tickets` (`organization_id`,`priority`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`avatar_url` text,
	`disabled_at` integer,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);