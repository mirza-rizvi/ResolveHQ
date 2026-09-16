ALTER TABLE `activity_logs` ADD `actor_type` text NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `activity_logs` ADD `actor_label` text;--> statement-breakpoint
UPDATE `activity_logs` SET `actor_type` = 'system' WHERE `actor_user_id` IS NULL;--> statement-breakpoint
CREATE INDEX `activity_logs_org_actor_type_idx` ON `activity_logs` (`organization_id`,`actor_type`,`created_at`);
