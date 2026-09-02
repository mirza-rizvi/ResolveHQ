PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO organizations (id, name, slug, support_email, next_ticket_number, created_at, updated_at)
VALUES ('org_demo', 'Northstar Labs', 'northstar-labs', 'support@northstarlabs.test', 1004, 1788192000000, 1788192000000);

INSERT OR IGNORE INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at)
VALUES ('inb_demo', 'org_demo', 'Support', 'support@northstarlabs.test', 'cloudflare_email', 1, 1788192000000, 1788192000000);

INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
VALUES
  ('usr_owner', 'owner@northstarlabs.test', 'Maya Chen', 'pbkdf2-sha256$310000$5YVp6WPqIjWJg4XXdTp-hg$tBZNVDTyqpuZWFVeu3sjpTjVX-05QRkhCDw5HLI-Guk', 1788192000000, 1788192000000),
  ('usr_agent', 'alex@northstarlabs.test', 'Alex Morgan', 'pbkdf2-sha256$310000$5YVp6WPqIjWJg4XXdTp-hg$tBZNVDTyqpuZWFVeu3sjpTjVX-05QRkhCDw5HLI-Guk', 1788192000000, 1788192000000)
ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;

INSERT OR IGNORE INTO organization_memberships (organization_id, user_id, role, created_at)
VALUES ('org_demo', 'usr_owner', 'owner', 1788192000000), ('org_demo', 'usr_agent', 'agent', 1788192000000);

INSERT OR IGNORE INTO customers (id, organization_id, name, email, company, phone, notes, normalized_search, last_contacted_at, created_at, updated_at)
VALUES
  ('cus_lina', 'org_demo', 'Lina Park', 'lina@papertrail.test', 'Papertrail Studio', '+1 415 555 0138', 'Prefers concise technical updates.', 'lina park lina@papertrail.test papertrail studio +1 415 555 0138', 1788275700000, 1787000000000, 1788275700000),
  ('cus_omar', 'org_demo', 'Omar Haddad', 'omar@relaycart.test', 'RelayCart', NULL, NULL, 'omar haddad omar@relaycart.test relaycart', 1788269400000, 1787100000000, 1788269400000),
  ('cus_sophie', 'org_demo', 'Sophie Laurent', 'sophie@acorn.test', 'Acorn Commerce', NULL, 'VIP annual customer.', 'sophie laurent sophie@acorn.test acorn commerce', 1788180000000, 1787200000000, 1788180000000);

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

INSERT OR IGNORE INTO tags (id, organization_id, name, color, created_at)
VALUES
  ('tag_bug', 'org_demo', 'bug', 'red', 1788192000000),
  ('tag_billing', 'org_demo', 'billing', 'blue', 1788192000000),
  ('tag_vip', 'org_demo', 'vip', 'violet', 1788192000000),
  ('tag_urgent', 'org_demo', 'urgent', 'amber', 1788192000000);

INSERT OR IGNORE INTO ticket_tags (organization_id, ticket_id, tag_id)
VALUES ('org_demo', 'tkt_1001', 'tag_bug'), ('org_demo', 'tkt_1002', 'tag_billing'), ('org_demo', 'tkt_1003', 'tag_bug'), ('org_demo', 'tkt_1003', 'tag_vip'), ('org_demo', 'tkt_1003', 'tag_urgent');

INSERT OR IGNORE INTO customer_tags (organization_id, customer_id, tag_id)
VALUES ('org_demo', 'cus_sophie', 'tag_vip');

INSERT OR IGNORE INTO saved_replies (id, organization_id, name, content, category, created_by_user_id, created_at, updated_at)
VALUES
  ('rpl_debug', 'org_demo', 'Request debug information', 'Could you send the relevant logs, environment details, and exact steps that reproduce the issue? Please remove any secrets before attaching files.', 'Troubleshooting', 'usr_owner', 1788192000000, 1788192000000),
  ('rpl_received', 'org_demo', 'Issue received', 'Thanks for the detailed report. We are reviewing it now and will update you as soon as we know more.', 'General', 'usr_owner', 1788192000000, 1788192000000);

DELETE FROM ticket_search WHERE organization_id = 'org_demo';
INSERT INTO ticket_search (organization_id, ticket_id, content)
SELECT t.organization_id, t.id, t.normalized_search || ' ' || coalesce(group_concat(m.normalized_search, ' '), '') || ' ' || coalesce(group_concat(g.name, ' '), '')
FROM tickets t LEFT JOIN messages m ON m.ticket_id = t.id AND m.organization_id = t.organization_id
LEFT JOIN ticket_tags tt ON tt.ticket_id = t.id AND tt.organization_id = t.organization_id
LEFT JOIN tags g ON g.id = tt.tag_id AND g.organization_id = t.organization_id
WHERE t.organization_id = 'org_demo' GROUP BY t.id;
