import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import type { SectionProps } from "../types";

export function AiSection({ data, canManage, reload, onMessage, onError }: SectionProps) {
  const [busy, setBusy] = useState(false);
  async function setAiAssistance(enabled: boolean) {
    setBusy(true);
    onError("");
    try {
      await api("/organization/settings", { method: "PATCH", body: JSON.stringify({ aiEnabled: enabled }) });
      onMessage(enabled ? "AI assistance enabled for this workspace." : "AI assistance disabled for this workspace.");
      await reload();
    } catch (reason) {
      onError(errorMessage(reason, "AI setting could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Sparkles size={18} />
          AI assistance
        </h2>
        <p>
          {data.ai.provider === "workers-ai"
            ? "Off by default. When enabled, AI drafting, summaries, and translation send this workspace's ticket conversations to Cloudflare Workers AI, which runs in your own Cloudflare account."
            : data.ai.provider === "openai"
              ? "Off by default. When enabled, AI drafting, summaries, and translation send this workspace's ticket conversations to OpenAI for processing, subject to OpenAI's data policies."
              : "Off by default. When a provider is configured on the Worker, AI drafting, summaries, and translation send this workspace's ticket conversations to that provider."}
        </p>
      </div>
      <div className="settings-inboxes">
        <dl className="readiness-list">
          <div>
            <dt>Provider</dt>
            <dd>
              {data.ai.provider === "workers-ai"
                ? "Cloudflare Workers AI"
                : data.ai.provider === "openai"
                  ? "OpenAI"
                  : "Missing"}
            </dd>
          </div>
          <div>
            <dt>This workspace</dt>
            <dd>{data.ai.enabled ? "Enabled" : "Disabled"}</dd>
          </div>
        </dl>
        {canManage && data.ai.available && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void setAiAssistance(!data.ai.enabled);
            }}
          >
            <Button type="submit" variant="secondary" disabled={busy}>
              {data.ai.enabled ? "Disable AI assistance" : "Enable AI assistance"}
            </Button>
          </form>
        )}
        {!data.ai.available && (
          <p className="settings-empty">
            Deploy the Worker with the Workers AI binding, or set OPENAI_API_KEY on it, to make AI available to
            workspaces.
          </p>
        )}
      </div>
    </section>
  );
}
