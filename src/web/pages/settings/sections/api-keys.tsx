import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, KeySquare, TriangleAlert } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";

const SCOPES = [
  { value: "tickets:read", label: "Read tickets" },
  { value: "tickets:write", label: "Create and change tickets" },
  { value: "customers:read", label: "Read customers" },
  { value: "customers:write", label: "Create and change customers" },
  { value: "kb:read", label: "Read knowledge base" },
  { value: "reports:read", label: "Read reports" },
  { value: "mcp:read", label: "Connect an AI assistant (MCP)" },
] as const;

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  inboxIds: string[] | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  orphaned: boolean;
}

export function ApiKeysSection({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>(["tickets:read"]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ keys: ApiKeyRow[] }>("/organization/api-keys");
      setKeys(result.keys);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "API keys could not be loaded."));
    }
  }, []);
  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const expiresAt = String(values.get("expiresAt") ?? "").trim();
    try {
      const result = await api<{ key: string }>("/organization/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: values.get("name"),
          scopes: selected,
          expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
        }),
      });
      form.reset();
      setSelected(["tickets:read"]);
      setRevealed(result.key);
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "The API key could not be created."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: ApiKeyRow) {
    if (!window.confirm(`Revoke “${row.name}”? Anything using it stops working immediately.`)) return;
    try {
      await api(`/organization/api-keys/${row.id}`, { method: "DELETE" });
      toast.push("API key revoked.", "success");
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The API key could not be revoked."), "error");
    }
  }

  if (!canManage || !keys) return null;
  return (
    <section className="settings-section">
      <div>
        <h2>
          <KeySquare size={18} />
          API keys
        </h2>
        <p>
          Keys work against <code>/api/v1</code> and carry only the permissions you tick. A key can never do more than
          the person who created it: if that member is demoted or removed, the key loses the same powers immediately.
        </p>
      </div>
      <div className="settings-inboxes">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {revealed && <RevealDialog value={revealed} onDone={() => setRevealed(null)} />}

        <div className="api-key-list">
          {keys.length ? (
            keys.map((row) => (
              <article key={row.id} className={row.revokedAt || row.orphaned ? "api-key-inactive" : undefined}>
                <div>
                  <strong>{row.name}</strong>
                  <small>
                    <code>{row.prefix}…</code> · {row.scopes.join(", ") || "no scopes"}
                    {row.lastUsedAt ? ` · last used ${new Date(row.lastUsedAt).toLocaleDateString()}` : " · never used"}
                    {row.expiresAt ? ` · expires ${new Date(row.expiresAt).toLocaleDateString()}` : ""}
                  </small>
                  {row.revokedAt && <small className="api-key-note">Revoked.</small>}
                  {!row.revokedAt && row.orphaned && (
                    <small className="api-key-note">
                      <TriangleAlert size={12} /> The member who created this key is no longer active, so it is
                      inactive. Create a new one to replace it.
                    </small>
                  )}
                </div>
                {!row.revokedAt && (
                  <Button variant="secondary" size="small" onClick={() => void revoke(row)}>
                    Revoke
                  </Button>
                )}
              </article>
            ))
          ) : (
            <p className="settings-empty">No API keys yet.</p>
          )}
        </div>

        <form onSubmit={create} className="api-key-form">
          <label>
            Name
            <Input name="name" placeholder="Zapier integration" required />
          </label>
          <fieldset>
            <legend>What this key may do</legend>
            {SCOPES.map((scope) => (
              <label key={scope.value}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope.value)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, scope.value]
                        : current.filter((entry) => entry !== scope.value),
                    )
                  }
                />
                {scope.label}
              </label>
            ))}
          </fieldset>
          <label>
            Expires (optional)
            <Input name="expiresAt" type="date" />
          </label>
          <Button type="submit" disabled={busy || !selected.length}>
            Create key
          </Button>
        </form>
      </div>
    </section>
  );
}

/**
 * The key is shown once and never again, so this cannot be dismissed by clicking away
 * or pressing Escape — only by confirming it has been saved.
 */
function RevealDialog({ value, onDone }: { value: string; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="api-key-reveal" role="dialog" aria-modal="true" aria-label="Your new API key">
      <div>
        <h3>Copy your key now</h3>
        <p>This is the only time you will see it. If you lose it, revoke the key and create another.</p>
        <div className="api-key-value">
          <code>{value}</code>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              navigator.clipboard
                ?.writeText(value)
                .then(() => setCopied(true))
                .catch(() => toast.push("Copy it manually — the clipboard was not available.", "error"));
            }}
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <Button type="button" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}
