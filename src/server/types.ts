export interface AppBindings {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  INBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  OUTBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  AUTH_RATE_LIMIT: RateLimit;
  APP_URL: string;
  SESSION_PEPPER: string;
  DEV_MAIL_MODE: "capture" | "disabled";
}

export type MailQueueMessage =
  | { kind: "inbound-mail"; from: string; to: string; raw: ArrayBuffer }
  | { kind: "outbound-mail"; organizationId: string; messageId: string };

export type Role = "owner" | "admin" | "agent";

export interface TenantContext {
  requestId: string;
  userId: string;
  organizationId: string;
  role: Role;
  csrfToken: string;
}

export type AppVariables = {
  tenant: TenantContext;
};

export type HonoEnv = { Bindings: AppBindings; Variables: AppVariables };
