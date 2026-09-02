export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface TicketSummary {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  assigneeName: string | null;
  customerId: string;
  customerName: string;
  customerEmail: string;
  lastReplyAt: string | null;
  updatedAt: string;
  version: number;
  preview?: string;
  unread?: boolean;
  tags?: Tag[];
}

export interface ThreadMessage {
  id: string;
  ticketId: string;
  authorType: string;
  authorUserId: string | null;
  kind: "message" | "internal_note";
  bodyText: string;
  bodyHtml: string | null;
  deliveryStatus: "received" | "queued" | "sent" | "failed";
  deliveryError: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface AttachmentSummary {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  size: number;
}

export interface Conversation {
  ticket: TicketSummary & { customerCompany?: string | null; createdAt: string };
  messages: ThreadMessage[];
  tags: Tag[];
  attachments: AttachmentSummary[];
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  disabledAt: string | null;
}

export interface CustomerOption {
  id: string;
  name: string;
  email: string;
}

export interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    email: string;
    company: string | null;
    phone: string | null;
    notes: string | null;
    createdAt: string;
  };
  tickets: Array<{ id: string; number: number; subject: string; status: string; updatedAt: string }>;
}

export interface SavedReply {
  id: string;
  name: string;
  content: string;
  category: string | null;
}

export interface Team {
  id: string;
  name: string;
  memberCount: number;
}

export interface SavedViewFilters {
  status?: string;
  priority?: string;
  assignee?: string;
  tagId?: string;
}

export interface SavedView {
  id: string;
  name: string;
  filters: SavedViewFilters;
  visibility: "personal" | "shared";
}

export type MessageKind = "message" | "internal_note";

export type QueueKey = "all" | "open" | "pending" | "unassigned" | "mine" | "waiting_customer" | "resolved" | "closed";

export type QueueCounts = Record<QueueKey, number>;
