export const ticketStatuses = ["open", "pending", "waiting_customer", "resolved", "closed"] as const;
export const ticketPriorities = ["low", "normal", "high", "urgent"] as const;
export const memberRoles = ["owner", "admin", "agent"] as const;

export type TicketStatus = (typeof ticketStatuses)[number];
export type TicketPriority = (typeof ticketPriorities)[number];
export type MemberRole = (typeof memberRoles)[number];

export const roleRank: Record<MemberRole, number> = { agent: 1, admin: 2, owner: 3 };
