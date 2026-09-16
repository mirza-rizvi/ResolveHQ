import { useState } from "react";
import { Bot, Copy } from "lucide-react";
import { Button } from "@/web/components/ui";
import { useToast } from "@/web/components/toast";

type ClientId = "claude-code" | "claude-desktop" | "cursor";

const CLIENTS: Array<{ id: ClientId; label: string; language: string }> = [
  { id: "claude-code", label: "Claude Code", language: "bash" },
  { id: "claude-desktop", label: "Claude Desktop", language: "json" },
  { id: "cursor", label: "Cursor", language: "json" },
];

/**
 * Prose instructions are where integrations go to die, so each snippet carries the real
 * deployment URL and — when a key was just created — the real key.
 */
function snippetFor(client: ClientId, endpoint: string, key: string) {
  if (client === "claude-code")
    return `claude mcp add resolvehq --transport http ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`;
  const config = {
    mcpServers: {
      resolvehq: {
        type: "http",
        url: endpoint,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

const CONFIG_PATHS: Record<ClientId, string> = {
  "claude-code": "Run this in a terminal.",
  "claude-desktop": "Add to claude_desktop_config.json.",
  cursor: "Add to .cursor/mcp.json in your project, or ~/.cursor/mcp.json.",
};

export function McpSection({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [client, setClient] = useState<ClientId>("claude-code");
  const endpoint = `${window.location.origin}/api/mcp`;
  // Filled in only if the operator pastes one; the key itself is never stored here.
  const [key, setKey] = useState("");
  const snippet = snippetFor(client, endpoint, key || "rhq_live_your_key_here");

  if (!canManage) return null;
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Bot size={18} />
          AI assistants (MCP)
        </h2>
        <p>
          Connect Claude Code, Claude Desktop, or Cursor to this workspace so your assistant can look things up
          directly. <strong>Read-only:</strong> it can search and read tickets, customers, queues, and knowledge-base
          articles, and it has no way to reply, assign, or change anything. Reply and status tools arrive in a later
          release, behind an approval screen.
        </p>
      </div>
      <div className="settings-inboxes">
        <p className="settings-empty">
          You need an API key with the <strong>Connect an AI assistant (MCP)</strong> permission. Create one above,
          then paste it here to fill in the snippet — it is only used to build the text below.
        </p>
        <label className="mcp-key-field">
          Your key
          <input
            value={key}
            onChange={(event) => setKey(event.target.value.trim())}
            placeholder="rhq_live_…"
            aria-label="API key to include in the snippet"
            spellCheck={false}
          />
        </label>

        <div className="mcp-clients" role="group" aria-label="MCP client">
          {CLIENTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={client === entry.id ? "active" : undefined}
              aria-pressed={client === entry.id}
              onClick={() => setClient(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <p className="settings-empty">{CONFIG_PATHS[client]}</p>
        <div className="mcp-snippet">
          <pre>{snippet}</pre>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              navigator.clipboard
                ?.writeText(snippet)
                .then(() => toast.push("Snippet copied.", "success"))
                .catch(() => toast.push("Copy it manually — the clipboard was not available.", "error"));
            }}
          >
            <Copy size={14} />
            Copy
          </Button>
        </div>
        <dl className="readiness-list">
          <div>
            <dt>Endpoint</dt>
            <dd>
              <code>{endpoint}</code>
            </dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>search_tickets, get_ticket, list_queues, get_customer, search_knowledge_base</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
