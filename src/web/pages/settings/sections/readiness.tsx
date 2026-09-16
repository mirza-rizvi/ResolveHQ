import { Stethoscope } from "lucide-react";
import { ReadinessChecklist, useReadiness } from "@/web/components/readiness-checklist";

export function ReadinessSection() {
  const { report, error, busy, refresh } = useReadiness();
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Stethoscope size={18} />
          Setup &amp; health
        </h2>
        <p>Whether this deployment can actually receive and send mail. Informational — nothing here blocks your work.</p>
      </div>
      <ReadinessChecklist report={report} error={error} busy={busy} onRefresh={refresh} />
    </section>
  );
}
