import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
};

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  supportEmail: text("support_email"),
  nextTicketNumber: integer("next_ticket_number").notNull().default(1001),
  ...timestamps,
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  avatarUrl: text("avatar_url"),
  disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "agent"] }).notNull(),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("memberships_user_idx").on(table.userId),
    index("memberships_organization_role_idx").on(table.organizationId, table.role),
  ],
);

export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "agent"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("invitations_organization_email_idx").on(table.organizationId, table.email),
    index("invitations_expires_idx").on(table.expiresAt),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_organization_idx").on(table.organizationId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    company: text("company"),
    phone: text("phone"),
    notes: text("notes"),
    normalizedSearch: text("normalized_search").notNull().default(""),
    lastContactedAt: integer("last_contacted_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("customers_organization_email_uidx").on(table.organizationId, table.email),
    index("customers_organization_name_idx").on(table.organizationId, table.name),
    index("customers_organization_last_contact_idx").on(table.organizationId, table.lastContactedAt),
  ],
);

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    status: text("status", { enum: ["open", "pending", "waiting_customer", "resolved", "closed"] }).notNull().default("open"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
    assignedUserId: text("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    normalizedSearch: text("normalized_search").notNull().default(""),
    lastReplyAt: integer("last_reply_at", { mode: "timestamp_ms" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("tickets_organization_number_uidx").on(table.organizationId, table.number),
    index("tickets_organization_status_updated_idx").on(table.organizationId, table.status, table.updatedAt),
    index("tickets_organization_assignee_status_idx").on(table.organizationId, table.assignedUserId, table.status),
    index("tickets_organization_customer_idx").on(table.organizationId, table.customerId),
    index("tickets_organization_priority_idx").on(table.organizationId, table.priority),
  ],
);

export const ticketAssignments = sqliteTable(
  "ticket_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedByUserId: text("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("ticket_assignments_organization_ticket_idx").on(table.organizationId, table.ticketId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    authorType: text("author_type", { enum: ["customer", "agent", "system"] }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorCustomerId: text("author_customer_id").references(() => customers.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["message", "internal_note"] }).notNull().default("message"),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    normalizedSearch: text("normalized_search").notNull().default(""),
    providerMessageId: text("provider_message_id"),
    deliveryStatus: text("delivery_status", { enum: ["received", "queued", "sent", "failed"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("messages_organization_ticket_created_idx").on(table.organizationId, table.ticketId, table.createdAt),
    index("messages_organization_provider_idx").on(table.organizationId, table.providerMessageId),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("slate"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("tags_organization_name_uidx").on(table.organizationId, table.name)],
);

export const ticketTags = sqliteTable(
  "ticket_tags",
  {
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.ticketId, table.tagId] }),
    index("ticket_tags_organization_tag_idx").on(table.organizationId, table.tagId),
  ],
);

export const customerTags = sqliteTable(
  "customer_tags",
  {
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.customerId, table.tagId] }),
    index("customer_tags_organization_tag_idx").on(table.organizationId, table.tagId),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    checksum: text("checksum").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("attachments_organization_ticket_idx").on(table.organizationId, table.ticketId),
    index("attachments_organization_message_idx").on(table.organizationId, table.messageId),
  ],
);

export const savedReplies = sqliteTable(
  "saved_replies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull(),
    category: text("category"),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [index("saved_replies_organization_category_idx").on(table.organizationId, table.category)],
);

export const activityLogs = sqliteTable(
  "activity_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    requestId: text("request_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("activity_logs_organization_created_idx").on(table.organizationId, table.createdAt),
    index("activity_logs_organization_ticket_idx").on(table.organizationId, table.ticketId),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.key] })],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Message = typeof messages.$inferSelect;
