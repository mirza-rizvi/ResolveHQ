export interface AppBindings {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  INBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  OUTBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  AUTH_RATE_LIMIT: RateLimit;
  WRITE_RATE_LIMIT: RateLimit;
  APP_URL: string;
  SESSION_PEPPER: string;
  DEV_MAIL_MODE: "capture" | "disabled";
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  SYSTEM_MAIL_FROM?: string;
}

export type MailQueueMessage =
  | { kind: "inbound-mail"; eventId: string; stagingObjectKey: string; from: string; to: string }
  | { kind: "outbound-mail"; jobId: string };

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
  requestId: string;
};

export type HonoEnv = { Bindings: AppBindings; Variables: AppVariables };
