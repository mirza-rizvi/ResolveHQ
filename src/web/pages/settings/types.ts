export interface SettingsData {
  workspace: { id: string; name: string; slug: string };
  inboxes: Array<{
    id: string;
    name: string;
    emailAddress: string;
    provider: string;
    isDefault: boolean;
    disabledAt: string | null;
  }>;
  mail: {
    provider: "cloudflare" | "resend" | "capture" | null;
    resendConfigured: boolean;
    webhookConfigured: boolean;
  };
  ai: { available: boolean; enabled: boolean; provider: "workers-ai" | "openai" | null };
}

export interface MailCapture {
  id: string;
  toAddress: string;
  fromAddress: string;
  subject: string;
  text: string | null;
  html: string | null;
  createdAt: string;
}

/** Shared by every section: the loaded data, whether this member may change it, and how to reload. */
export interface SectionProps {
  data: SettingsData;
  canManage: boolean;
  reload: () => Promise<void>;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}
