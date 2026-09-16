import { ShieldCheck } from "lucide-react";
import type { SettingsData } from "../types";

export function MailDeliverySection({ data }: { data: SettingsData }) {
  return (
    <section className="settings-section">
      <div>
        <h2>
          <ShieldCheck size={18} />
          Mail delivery
        </h2>
        <p>Secrets remain Worker bindings and are never returned to the browser.</p>
      </div>
      <dl className="readiness-list">
        <div>
          <dt>Provider</dt>
          <dd>
            {data.mail.provider === "cloudflare"
              ? "Cloudflare Email Sending"
              : data.mail.provider === "resend"
                ? "Resend"
                : data.mail.provider === "capture"
                  ? "Captured locally"
                  : "Missing"}
          </dd>
        </div>
        <div>
          <dt>Resend API key</dt>
          <dd>{data.mail.resendConfigured ? "Configured" : "Missing"}</dd>
        </div>
        <div>
          <dt>Signed webhook</dt>
          <dd>{data.mail.webhookConfigured ? "Configured" : "Missing"}</dd>
        </div>
      </dl>
    </section>
  );
}
