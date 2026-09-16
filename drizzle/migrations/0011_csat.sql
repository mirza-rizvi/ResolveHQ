CREATE TABLE `csat_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `ticket_id` text NOT NULL REFERENCES `tickets`(`id`) ON DELETE CASCADE,
  `customer_id` text NOT NULL REFERENCES `customers`(`id`) ON DELETE CASCADE,
  `message_id` text REFERENCES `messages`(`id`) ON DELETE SET NULL,
  `rating` integer,
  `comment` text,
  `sent_at` integer NOT NULL,
  `responded_at` integer,
  `consumed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `csat_responses_ticket_uidx` ON `csat_responses` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `csat_responses_org_responded_idx` ON `csat_responses` (`organization_id`,`responded_at`);--> statement-breakpoint
CREATE INDEX `csat_responses_org_customer_idx` ON `csat_responses` (`organization_id`,`customer_id`);
