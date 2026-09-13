CREATE UNIQUE INDEX `inboxes_lower_email_uidx` ON `inboxes` (lower(`email_address`));--> statement-breakpoint
DROP INDEX IF EXISTS `inboxes_lower_email_idx`;
