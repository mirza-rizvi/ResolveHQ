UPDATE `inboxes` SET `disabled_at` = CAST(strftime('%s','now') AS INTEGER) * 1000, `updated_at` = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE `disabled_at` IS NULL AND `id` NOT IN (
  SELECT `id` FROM (
    SELECT `id`, row_number() OVER (PARTITION BY lower(`email_address`) ORDER BY `created_at`, `id`) AS rn
    FROM `inboxes` WHERE `disabled_at` IS NULL
  ) WHERE rn = 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `inboxes_lower_email_uidx` ON `inboxes` (lower(`email_address`)) WHERE `disabled_at` IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `inboxes_lower_email_idx`;
