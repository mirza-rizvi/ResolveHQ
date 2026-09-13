CREATE TABLE `customer_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `customer_id` text NOT NULL REFERENCES `customers`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'email',
  `value` text NOT NULL,
  `is_primary` integer NOT NULL DEFAULT 0,
  `source` text NOT NULL DEFAULT 'backfill',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_identities_org_value_uidx` ON `customer_identities` (`organization_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `customer_identities_customer_idx` ON `customer_identities` (`organization_id`,`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_identities_primary_uidx` ON `customer_identities` (`customer_id`) WHERE `is_primary` = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `customer_identities` (`id`, `organization_id`, `customer_id`, `kind`, `value`, `is_primary`, `source`, `created_at`, `updated_at`)
  SELECT 'cid_' || `id`, `organization_id`, `id`, 'email', lower(`email`), 1, 'backfill', `created_at`, `updated_at`
  FROM (
    SELECT `id`, `organization_id`, `email`, `created_at`, `updated_at`,
      row_number() OVER (PARTITION BY `organization_id`, lower(`email`) ORDER BY `created_at`, `id`) AS rn
    FROM `customers`
  ) WHERE rn = 1;
