PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO organizations (id, name, slug, support_email, next_ticket_number, created_at, updated_at)
VALUES ('org_demo', 'Northstar Labs', 'northstar-labs', 'support@northstarlabs.test', 1004, 1788192000000, 1788192000000);

INSERT OR IGNORE INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at)
VALUES ('inb_demo', 'org_demo', 'Support', 'support@northstarlabs.test', 'cloudflare_email', 1, 1788192000000, 1788192000000);

INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at, updated_at)
VALUES
  ('usr_owner', 'owner@northstarlabs.test', 'Maya Chen', 'pbkdf2-sha256$310000$5YVp6WPqIjWJg4XXdTp-hg$tBZNVDTyqpuZWFVeu3sjpTjVX-05QRkhCDw5HLI-Guk', 1788192000000, 1788192000000),
  ('usr_agent', 'alex@northstarlabs.test', 'Alex Morgan', 'pbkdf2-sha256$310000$5YVp6WPqIjWJg4XXdTp-hg$tBZNVDTyqpuZWFVeu3sjpTjVX-05QRkhCDw5HLI-Guk', 1788192000000, 1788192000000);

INSERT OR IGNORE INTO organization_memberships (organization_id, user_id, role, created_at)
VALUES ('org_demo', 'usr_owner', 'owner', 1788192000000), ('org_demo', 'usr_agent', 'agent', 1788192000000);

INSERT OR IGNORE INTO customers (id, organization_id, name, email, company, phone, notes, normalized_search, last_contacted_at, created_at, updated_at)
VALUES
  ('cus_lina', 'org_demo', 'Lina Park', 'lina@papertrail.test', 'Papertrail Studio', '+1 415 555 0138', 'Prefers concise technical updates.', 'lina park lina@papertrail.test papertrail studio +1 415 555 0138', 1788275700000, 1787000000000, 1788275700000),
  ('cus_omar', 'org_demo', 'Omar Haddad', 'omar@relaycart.test', 'RelayCart', NULL, NULL, 'omar haddad omar@relaycart.test relaycart', 1788269400000, 1787100000000, 1788269400000),
  ('cus_sophie', 'org_demo', 'Sophie Laurent', 'sophie@acorn.test', 'Acorn Commerce', NULL, 'VIP annual customer.', 'sophie laurent sophie@acorn.test acorn commerce', 1788180000000, 1787200000000, 1788180000000);

INSERT OR IGNORE INTO customer_identities (id, organization_id, customer_id, kind, value, is_primary, source, created_at, updated_at)
VALUES
  ('cid_lina', 'org_demo', 'cus_lina', 'email', 'lina@papertrail.test', 1, 'backfill', 1787000000000, 1787000000000),
  ('cid_omar', 'org_demo', 'cus_omar', 'email', 'omar@relaycart.test', 1, 'backfill', 1787100000000, 1787100000000),
  ('cid_sophie', 'org_demo', 'cus_sophie', 'email', 'sophie@acorn.test', 1, 'backfill', 1787200000000, 1787200000000);

-- Additional customers backing the extra demo tickets below. Timestamps are relative to
-- seed time so "time ago" labels in the UI stay fresh no matter when the seed runs.
INSERT OR IGNORE INTO customers (id, organization_id, name, email, company, phone, notes, normalized_search, last_contacted_at, created_at, updated_at)
VALUES
  ('cus_priya', 'org_demo', 'Priya Nair', 'priya@dataflowmetrics.test', 'DataFlow Metrics', NULL, NULL, 'priya nair priya@dataflowmetrics.test dataflow metrics', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 3888000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000)),
  ('cus_owen', 'org_demo', 'Owen Fitzgerald', 'owen@brightdesk.test', 'BrightDesk', NULL, NULL, 'owen fitzgerald owen@brightdesk.test brightdesk', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 28800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 5184000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 28800000)),
  ('cus_maria', 'org_demo', 'Maria Gonzalez', 'maria@lumenanalytics.test', 'Lumen Analytics', NULL, NULL, 'maria gonzalez maria@lumenanalytics.test lumen analytics', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 777600000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 7776000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 432000000)),
  ('cus_derek', 'org_demo', 'Derek Osei', 'derek@fenwickrowe.test', 'Fenwick & Rowe', NULL, 'Escalation contact for their migration project.', 'derek osei derek@fenwickrowe.test fenwick rowe', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000));

INSERT OR IGNORE INTO customer_identities (id, organization_id, customer_id, kind, value, is_primary, source, created_at, updated_at)
VALUES
  ('cid_priya', 'org_demo', 'cus_priya', 'email', 'priya@dataflowmetrics.test', 1, 'backfill', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 3888000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 3888000000)),
  ('cid_owen', 'org_demo', 'cus_owen', 'email', 'owen@brightdesk.test', 1, 'backfill', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 5184000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 5184000000)),
  ('cid_maria', 'org_demo', 'cus_maria', 'email', 'maria@lumenanalytics.test', 1, 'backfill', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 7776000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 7776000000)),
  ('cid_derek', 'org_demo', 'cus_derek', 'email', 'derek@fenwickrowe.test', 1, 'backfill', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000));

INSERT OR IGNORE INTO tickets (id, organization_id, inbox_id, number, customer_id, subject, status, priority, assigned_user_id, normalized_search, last_message_preview, message_count, last_customer_reply_at, last_agent_reply_at, last_reply_at, created_at, updated_at)
VALUES
  ('tkt_1001', 'org_demo', 'inb_demo', 1001, 'cus_lina', 'Webhook deliveries retrying indefinitely', 'open', 'high', 'usr_agent', '1001 webhook deliveries retrying indefinitely lina park lina@papertrail.test', 'Thanks for flagging this, Lina. I have paused retries for the affected endpoint.', 3, 1788264000000, 1788275700000, 1788275700000, 1788264000000, 1788275700000),
  ('tkt_1002', 'org_demo', 'inb_demo', 1002, 'cus_omar', 'Need a copy of our August invoice', 'waiting_customer', 'normal', 'usr_owner', '1002 need a copy of our august invoice omar haddad omar@relaycart.test', 'Please confirm whether finance@relaycart.test is still the correct billing address.', 2, 1788250000000, 1788269400000, 1788269400000, 1788250000000, 1788269400000),
  ('tkt_1003', 'org_demo', 'inb_demo', 1003, 'cus_sophie', 'Checkout extension conflicts with theme', 'open', 'urgent', NULL, '1003 checkout extension conflicts with theme sophie laurent sophie@acorn.test', 'After today''s theme update, checkout is blank whenever the subscription extension is active.', 1, 1788170000000, NULL, 1788180000000, 1788170000000, 1788180000000);

INSERT OR IGNORE INTO messages (id, organization_id, ticket_id, author_type, author_user_id, author_customer_id, kind, body_text, normalized_search, delivery_status, created_at)
VALUES
  ('msg_1001_a', 'org_demo', 'tkt_1001', 'customer', NULL, 'cus_lina', 'message', 'Our webhook endpoint recovered, but ResolveHQ has retried the same delivery for two hours. Can you stop the duplicates without dropping the original event?', 'our webhook endpoint recovered but resolvehq has retried the same delivery for two hours can you stop the duplicates without dropping the original event', 'received', 1788264000000),
  ('msg_1001_b', 'org_demo', 'tkt_1001', 'agent', 'usr_agent', NULL, 'internal_note', 'The delivery worker is respecting the old retry-after header. Check the idempotency key before replying.', 'the delivery worker is respecting the old retry after header check the idempotency key before replying', 'received', 1788270000000),
  ('msg_1001_c', 'org_demo', 'tkt_1001', 'agent', 'usr_agent', NULL, 'message', 'Thanks for flagging this, Lina. I have paused retries for the affected endpoint while we verify the event idempotency key. No events have been discarded.', 'thanks for flagging this lina i have paused retries for the affected endpoint while we verify the event idempotency key no events have been discarded', 'sent', 1788275700000),
  ('msg_1002_a', 'org_demo', 'tkt_1002', 'customer', NULL, 'cus_omar', 'message', 'Could you send our August invoice to the billing address on file?', 'could you send our august invoice to the billing address on file', 'received', 1788250000000),
  ('msg_1002_b', 'org_demo', 'tkt_1002', 'agent', 'usr_owner', NULL, 'message', 'Absolutely. Please confirm whether finance@relaycart.test is still the correct billing address.', 'absolutely please confirm whether finance relaycart test is still the correct billing address', 'sent', 1788269400000),
  ('msg_1003_a', 'org_demo', 'tkt_1003', 'customer', NULL, 'cus_sophie', 'message', 'After today''s theme update, checkout is blank whenever the subscription extension is active. This is blocking orders.', 'after today theme update checkout is blank whenever the subscription extension is active this is blocking orders', 'received', 1788170000000);

-- Six more tickets spanning every status and priority, so the inbox, dashboard, and
-- reports pages have enough variety to be worth screenshotting.
INSERT OR IGNORE INTO tickets (id, organization_id, inbox_id, number, customer_id, subject, status, priority, assigned_user_id, normalized_search, last_message_preview, message_count, last_customer_reply_at, last_agent_reply_at, last_reply_at, resolved_at, closed_at, created_at, updated_at)
VALUES
  ('tkt_1004', 'org_demo', 'inb_demo', 1004, 'cus_priya', 'Bulk CSV export missing custom fields', 'pending', 'normal', 'usr_agent', '1004 bulk csv export missing custom fields priya nair priya@dataflowmetrics.test dataflow metrics', 'Thanks for the report — custom fields aren''t in the CSV export yet, but we''ve queued it for our next release.', 3, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 72000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 72000000), NULL, NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 72000000)),
  ('tkt_1005', 'org_demo', 'inb_demo', 1005, 'cus_owen', 'How do I change my workspace timezone?', 'resolved', 'low', 'usr_owner', '1005 how do i change my workspace timezone owen fitzgerald owen@brightdesk.test brightdesk', 'Yes — go to Settings, Workspace identity, and set your timezone there.', 2, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 28800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 25200000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 25200000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000), NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 28800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000)),
  ('tkt_1006', 'org_demo', 'inb_demo', 1006, 'cus_maria', 'SSO login redirect loop', 'closed', 'normal', 'usr_agent', '1006 sso login redirect loop maria gonzalez maria@lumenanalytics.test lumen analytics', 'This was caused by a stale session cookie predating SSO setup. Clearing cookies for affected teammates resolved the loop.', 3, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 777600000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 604800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 604800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 518400000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 432000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 777600000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 432000000)),
  ('tkt_1007', 'org_demo', 'inb_demo', 1007, 'cus_lina', 'Feature request: dark mode for the customer help center', 'open', 'low', NULL, '1007 feature request dark mode for the customer help center lina park lina@papertrail.test papertrail studio', 'Loving ResolveHQ so far! Any plans to add a dark mode to the public help center pages?', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000), NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000), NULL, NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000)),
  ('tkt_1008', 'org_demo', 'inb_demo', 1008, 'cus_omar', 'API rate limit hit during migration', 'waiting_customer', 'high', 'usr_agent', '1008 api rate limit hit during migration omar haddad omar@relaycart.test relaycart', 'You can sustain 5 requests per second per API key; anything above that will 429.', 2, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 10800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1800000), NULL, NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 10800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1800000)),
  ('tkt_1009', 'org_demo', 'inb_demo', 1009, 'cus_derek', 'Data export stuck at 0%', 'pending', 'urgent', 'usr_agent', '1009 data export stuck at 0 percent derek osei derek@fenwickrowe.test fenwick rowe', 'Our full data export job has been stuck at 0% for 20 minutes and support says it should take seconds.', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000), NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000), NULL, NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000));

INSERT OR IGNORE INTO messages (id, organization_id, ticket_id, author_type, author_user_id, author_customer_id, kind, body_text, normalized_search, delivery_status, created_at)
VALUES
  ('msg_1004_a', 'org_demo', 'tkt_1004', 'customer', NULL, 'cus_priya', 'message', 'The CSV export from Reports is missing our custom field columns (Plan Tier, Renewal Date). Can these be included?', 'the csv export from reports is missing our custom field columns plan tier renewal date can these be included', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000)),
  ('msg_1004_b', 'org_demo', 'tkt_1004', 'agent', 'usr_agent', NULL, 'internal_note', 'Confirmed custom fields are excluded from the CSV serializer. Filed as a follow-up; flagged for the next release.', 'confirmed custom fields are excluded from the csv serializer filed as a follow up flagged for the next release', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000)),
  ('msg_1004_c', 'org_demo', 'tkt_1004', 'agent', 'usr_agent', NULL, 'message', 'Thanks for the report — custom fields aren''t in the CSV export yet, but we''ve queued it for our next release. I''ll update this ticket once it ships.', 'thanks for the report custom fields are not in the csv export yet but we have queued it for our next release i will update this ticket once it ships', 'sent', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 72000000)),
  ('msg_1005_a', 'org_demo', 'tkt_1005', 'customer', NULL, 'cus_owen', 'message', 'Is there a setting to change the timezone shown on ticket timestamps?', 'is there a setting to change the timezone shown on ticket timestamps', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 28800000)),
  ('msg_1005_b', 'org_demo', 'tkt_1005', 'agent', 'usr_owner', NULL, 'message', 'Yes — go to Settings, Workspace identity, and set your timezone there. Existing timestamps display in the new zone automatically.', 'yes go to settings workspace identity and set your timezone there existing timestamps display in the new zone automatically', 'sent', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 25200000)),
  ('msg_1006_a', 'org_demo', 'tkt_1006', 'customer', NULL, 'cus_maria', 'message', 'After enabling SSO, some teammates get stuck in a redirect loop between our IdP and ResolveHQ.', 'after enabling sso some teammates get stuck in a redirect loop between our idp and resolvehq', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 777600000)),
  ('msg_1006_b', 'org_demo', 'tkt_1006', 'agent', 'usr_agent', NULL, 'internal_note', 'Reproduced with a stale session cookie from before SSO was enabled. Recommending a cookie clear for affected teammates.', 'reproduced with a stale session cookie from before sso was enabled recommending a cookie clear for affected teammates', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 691200000)),
  ('msg_1006_c', 'org_demo', 'tkt_1006', 'agent', 'usr_agent', NULL, 'message', 'This was caused by a stale session cookie predating SSO setup. Clearing cookies for affected teammates resolved the loop. Let us know if it recurs.', 'this was caused by a stale session cookie predating sso setup clearing cookies for affected teammates resolved the loop let us know if it recurs', 'sent', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 604800000)),
  ('msg_1007_a', 'org_demo', 'tkt_1007', 'customer', NULL, 'cus_lina', 'message', 'Loving ResolveHQ so far! Any plans to add a dark mode to the public help center pages?', 'loving resolvehq so far any plans to add a dark mode to the public help center pages', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000)),
  ('msg_1008_a', 'org_demo', 'tkt_1008', 'customer', NULL, 'cus_omar', 'message', 'We''re migrating 10k historical tickets via the API and keep hitting 429 rate limit errors. What''s the sustained rate we should throttle to?', 'we are migrating 10k historical tickets via the api and keep hitting 429 rate limit errors what is the sustained rate we should throttle to', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 10800000)),
  ('msg_1008_b', 'org_demo', 'tkt_1008', 'agent', 'usr_agent', NULL, 'message', 'You can sustain 5 requests per second per API key; anything above that will 429. Are you able to add a client-side limiter, or would batching help more?', 'you can sustain 5 requests per second per api key anything above that will 429 are you able to add a client side limiter or would batching help more', 'sent', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1800000)),
  ('msg_1009_a', 'org_demo', 'tkt_1009', 'customer', NULL, 'cus_derek', 'message', 'Our full data export job has been stuck at 0% for 20 minutes and support says it should take seconds. Can someone look at this urgently?', 'our full data export job has been stuck at 0 percent for 20 minutes and support says it should take seconds can someone look at this urgently', 'received', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000));

INSERT OR IGNORE INTO tags (id, organization_id, name, color, created_at)
VALUES
  ('tag_bug', 'org_demo', 'bug', 'red', 1788192000000),
  ('tag_billing', 'org_demo', 'billing', 'blue', 1788192000000),
  ('tag_vip', 'org_demo', 'vip', 'violet', 1788192000000),
  ('tag_urgent', 'org_demo', 'urgent', 'amber', 1788192000000),
  ('tag_feature', 'org_demo', 'feature-request', 'cyan', 1788192000000),
  ('tag_question', 'org_demo', 'question', 'green', 1788192000000);

INSERT OR IGNORE INTO ticket_tags (organization_id, ticket_id, tag_id)
VALUES
  ('org_demo', 'tkt_1001', 'tag_bug'), ('org_demo', 'tkt_1002', 'tag_billing'), ('org_demo', 'tkt_1003', 'tag_bug'), ('org_demo', 'tkt_1003', 'tag_vip'), ('org_demo', 'tkt_1003', 'tag_urgent'),
  ('org_demo', 'tkt_1004', 'tag_bug'), ('org_demo', 'tkt_1005', 'tag_question'), ('org_demo', 'tkt_1006', 'tag_bug'), ('org_demo', 'tkt_1007', 'tag_feature'), ('org_demo', 'tkt_1008', 'tag_bug'), ('org_demo', 'tkt_1009', 'tag_bug'), ('org_demo', 'tkt_1009', 'tag_urgent');

INSERT OR IGNORE INTO customer_tags (organization_id, customer_id, tag_id)
VALUES ('org_demo', 'cus_sophie', 'tag_vip');

INSERT OR IGNORE INTO saved_replies (id, organization_id, name, content, category, created_by_user_id, created_at, updated_at)
VALUES
  ('rpl_debug', 'org_demo', 'Request debug information', 'Could you send the relevant logs, environment details, and exact steps that reproduce the issue? Please remove any secrets before attaching files.', 'Troubleshooting', 'usr_owner', 1788192000000, 1788192000000),
  ('rpl_received', 'org_demo', 'Issue received', 'Thanks for the detailed report. We are reviewing it now and will update you as soon as we know more.', 'General', 'usr_owner', 1788192000000, 1788192000000);

-- Keep the ticket-number counter ahead of every ticket number seeded above.
UPDATE organizations SET next_ticket_number = 1010 WHERE id = 'org_demo' AND next_ticket_number < 1010;

INSERT OR IGNORE INTO knowledge_base_articles (id, organization_id, title, slug, category, body, status, version, published_at, created_by_user_id, created_at, updated_at)
VALUES
  ('kb_forwarding', 'org_demo', 'Setting up email forwarding for your support inbox', 'email-forwarding-setup', 'Getting started', 'ResolveHQ receives mail through Cloudflare Email Routing. Point your support address''s MX records at Cloudflare, then add a catch-all or address-specific rule that forwards to your Worker.

Once routing is active, incoming mail appears as a new ticket within a few seconds. Replies sent from the inbox thread automatically, using the same subject and message headers as the original email.

If a message does not arrive, check Email Routing settings in your Cloudflare dashboard first — most delivery issues trace back to a route that points at the wrong destination.', 'published', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000), 'usr_owner', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2592000000)),
  ('kb_priorities', 'org_demo', 'Understanding ticket priorities', 'ticket-priorities-explained', 'Tickets', 'Every ticket has a priority: Low, Normal, High, or Urgent. Priority does not change automatically — your team sets it based on impact and urgency.

Urgent is meant for outages or anything blocking a customer''s core workflow right now. High is for issues affecting one customer significantly but without a full outage. Normal covers most day-to-day requests, and Low is for questions or minor requests that can wait.

ResolveHQ does not run SLA timers today, so priority is a signal for your team''s own triage rather than an automated countdown.', 'published', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2160000000), 'usr_owner', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2160000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 2160000000)),
  ('kb_automations', 'org_demo', 'How automations trigger on new tickets', 'how-automations-trigger', 'Automations', 'Automations run whenever a ticket is created or updated. Each rule checks its conditions — matching on subject, priority, status, customer email, or inbox — and if every condition matches, the rule''s actions run in order.

Actions can change priority or status, assign the ticket to a teammate, or add a tag. A ticket can match more than one rule, and rules run in the order shown on the Automations page.

Use the position controls on that page to reorder rules if two of them could both match the same ticket and you need one to win.', 'published', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 864000000), 'usr_owner', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 864000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 864000000)),
  ('kb_webhook_draft', 'org_demo', 'Troubleshooting webhook retry storms', 'webhook-retry-storms', 'Troubleshooting', 'Draft notes on webhook retry storms.

When a customer''s endpoint is briefly unreachable, our delivery worker retries with backoff. If the endpoint comes back up mid-storm, it can look like duplicate events even though only one was actually new.

TODO: document how to confirm this via the idempotency key before telling a customer we have paused retries, and add a section on pausing retries for a single endpoint on purpose.', 'draft', 1, NULL, 'usr_agent', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 172800000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000));

INSERT OR IGNORE INTO automation_rules (id, organization_id, name, enabled, position, conditions, actions, created_by_user_id, created_at, updated_at)
VALUES
  ('rul_billing_tag', 'org_demo', 'Tag invoice mentions as billing', 1, 0, '[{"field":"subject","op":"contains","value":"invoice"}]', '[{"type":"add_tag","name":"billing"}]', 'usr_owner', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1728000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1728000000)),
  ('rul_vip_assign', 'org_demo', 'Route Acorn Commerce to Maya', 1, 1, '[{"field":"customerEmail","op":"contains","value":"acorn.test"}]', '[{"type":"assign_user","userId":"usr_owner"},{"type":"add_tag","name":"vip"}]', 'usr_owner', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1728000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1728000000));

INSERT OR IGNORE INTO notifications (id, organization_id, user_id, ticket_id, type, title, read_at, created_at)
VALUES
  ('ntf_1009_assigned', 'org_demo', 'usr_agent', 'tkt_1009', 'ticket.assigned', 'Ticket #1009 was assigned to you', NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000)),
  ('ntf_1008_replied', 'org_demo', 'usr_agent', 'tkt_1008', 'ticket.customer_replied', 'Customer replied to ticket #1008', NULL, (CAST(strftime('%s','now') AS INTEGER) * 1000 - 10800000));

INSERT OR IGNORE INTO saved_views (id, organization_id, owner_user_id, name, visibility, filters, created_at, updated_at)
VALUES
  ('viw_urgent_unassigned', 'org_demo', 'usr_owner', 'Urgent & unassigned', 'shared', '{"priority":"urgent","assignee":"unassigned"}', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1296000000), (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1296000000));

INSERT OR IGNORE INTO activity_logs (id, organization_id, ticket_id, actor_user_id, event_type, entity_type, entity_id, created_at)
VALUES
  ('act_1009_created', 'org_demo', 'tkt_1009', NULL, 'ticket.created', 'ticket', 'tkt_1009', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 900000)),
  ('act_1009_assigned', 'org_demo', 'tkt_1009', 'usr_owner', 'ticket.assigned', 'ticket', 'tkt_1009', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 840000)),
  ('act_1008_replied', 'org_demo', 'tkt_1008', 'usr_agent', 'ticket.agent_replied', 'ticket', 'tkt_1008', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 1800000)),
  ('act_1007_created', 'org_demo', 'tkt_1007', NULL, 'ticket.created', 'ticket', 'tkt_1007', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000)),
  ('act_1005_status', 'org_demo', 'tkt_1005', 'usr_owner', 'ticket.status_changed', 'ticket', 'tkt_1005', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 21600000)),
  ('act_1006_status', 'org_demo', 'tkt_1006', 'usr_agent', 'ticket.status_changed', 'ticket', 'tkt_1006', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 432000000)),
  ('act_1004_tag', 'org_demo', 'tkt_1004', 'usr_agent', 'ticket.tag_added', 'ticket', 'tkt_1004', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000)),
  ('act_1004_note', 'org_demo', 'tkt_1004', 'usr_agent', 'ticket.note_added', 'ticket', 'tkt_1004', (CAST(strftime('%s','now') AS INTEGER) * 1000 - 84600000));

DELETE FROM ticket_search WHERE organization_id = 'org_demo';
INSERT INTO ticket_search (organization_id, ticket_id, content)
SELECT t.organization_id, t.id, t.normalized_search || ' ' || coalesce(group_concat(m.normalized_search, ' '), '') || ' ' || coalesce(group_concat(g.name, ' '), '')
FROM tickets t LEFT JOIN messages m ON m.ticket_id = t.id AND m.organization_id = t.organization_id
LEFT JOIN ticket_tags tt ON tt.ticket_id = t.id AND tt.organization_id = t.organization_id
LEFT JOIN tags g ON g.id = tt.tag_id AND g.organization_id = t.organization_id
WHERE t.organization_id = 'org_demo' GROUP BY t.id;
