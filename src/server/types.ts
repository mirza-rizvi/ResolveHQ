export interface AppBindings {
  DB: D1Database;
  AUTH_TIMING_SAMPLE_RATE?: string;
  MAINTENANCE_QUEUE?: Queue<MailQueueMessage>;
  MAINTENANCE_DLQ?: Queue<MailQueueMessage>;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  INBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  OUTBOUND_MAIL_QUEUE: Queue<MailQueueMessage>;
  /** Dead-letter consumers retain stopped work for administrative recovery. */
  INBOUND_MAIL_DLQ?: Queue<MailQueueMessage>;
  OUTBOUND_MAIL_DLQ?: Queue<MailQueueMessage>;
  AUTH_RATE_LIMIT: RateLimit;
  WRITE_RATE_LIMIT: RateLimit;
  /** Optional public origin. When unset, the request origin is used (see lib/app-url.ts). */
  APP_URL?: string;
  SESSION_PEPPER: string;
  DEV_MAIL_MODE: "capture" | "disabled";
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  SYSTEM_MAIL_FROM?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  /** Optional retention window in days; resolved and closed tickets older than this are deleted by the cron sweep. */
  TICKET_RETENTION_DAYS?: string;
}

export type MailQueueMessage =
  | { kind: "inbound-mail"; eventId: string; stagingObjectKey: string; from?: string; to?: string; generation?: number }
  | { kind: "outbound-mail"; jobId: string; generation?: number }
  | { kind: "maintenance"; taskId: string; generation?: number };

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
  authTimings?: import("./auth/password").AuthTiming[];
};

export type HonoEnv = { Bindings: AppBindings; Variables: AppVariables };
