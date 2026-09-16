import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/web/auth";
import { MailRecovery } from "@/web/components/mail-recovery";
import { api, errorMessage } from "@/web/lib/api";
import { AccountSection } from "./sections/account";
import { AiSection } from "./sections/ai";
import { DevMailSection } from "./sections/dev-mail";
import { InboxesSection } from "./sections/inboxes";
import { MailDeliverySection } from "./sections/mail-delivery";
import { ReadinessSection } from "./sections/readiness";
import { SlaSection } from "./sections/sla";
import { WorkspaceSection } from "./sections/workspace";
import type { SettingsData } from "./types";

export function SettingsPage() {
  const { session } = useAuth();
  const [data, setData] = useState<SettingsData | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api<SettingsData>("/organization/settings").then(setData), []);
  useEffect(() => {
    load().catch((reason) => setError(errorMessage(reason, "Settings could not be loaded.")));
  }, [load]);
  const reload = useCallback(async () => {
    await load();
  }, [load]);

  if (!data)
    return (
      <div className="standard-page">
        {error ? <p className="page-error">{error}</p> : <div className="route-loading" aria-label="Loading settings" />}
      </div>
    );

  const canManage = session?.role !== "agent";
  const sectionProps = { data, canManage, reload, onMessage: setMessage, onError: setError };
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Workspace settings</h1>
          <p>Identity, support inboxes, and production mail readiness.</p>
        </div>
      </header>
      {message && (
        <p className="settings-success">
          <CheckCircle2 size={15} />
          {message}
        </p>
      )}
      {error && <p className="page-error">{error}</p>}
      {canManage && <ReadinessSection />}
      <WorkspaceSection {...sectionProps} />
      <InboxesSection {...sectionProps} />
      <SlaSection canManage={canManage} />
      <AccountSection />
      <MailDeliverySection data={data} />
      <AiSection {...sectionProps} />
      {canManage && <MailRecovery />}
      <DevMailSection />
    </div>
  );
}
