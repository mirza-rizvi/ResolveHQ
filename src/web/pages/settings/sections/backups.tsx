import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DatabaseBackup, Download } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";

interface BackupRow {
  id: string;
  status: "running" | "completed" | "failed" | "expired";
  sizeBytes: number;
  rowCounts: Record<string, number>;
  progressTable: string | null;
  rowsExported: number;
  startedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

interface BackupFile {
  table: string;
  chunks: number;
  bytes: number;
}

interface Schedule {
  enabled: boolean;
  retainDays: number;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(row: BackupRow) {
  if (row.status === "running")
    return row.progressTable
      ? `Exporting ${row.progressTable.replace(/_/g, " ")}… ${row.rowsExported.toLocaleString()} rows so far`
      : "Starting…";
  if (row.status === "failed") return row.error ?? "The export failed.";
  if (row.status === "expired") return "Expired. The files have been deleted.";
  return `${row.rowsExported.toLocaleString()} rows · ${formatBytes(row.sizeBytes)}`;
}

export function BackupsSection({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<BackupRow[] | null>(null);
  const [schedule, setSchedule] = useState<Schedule>({ enabled: false, retainDays: 30 });
  const [files, setFiles] = useState<Record<string, BackupFile[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ backups: BackupRow[]; schedule: Schedule }>("/organization/backups");
      setRows(result.backups);
      setSchedule(result.schedule);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Backups could not be loaded."));
    }
  }, []);
  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  async function create() {
    setBusy(true);
    setError("");
    try {
      await api("/organization/backups", { method: "POST" });
      toast.push("Export started. It runs in the background.", "success");
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "The export could not be started."));
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ schedule: Schedule }>("/organization/backups/schedule", {
        method: "PUT",
        body: JSON.stringify(schedule),
      });
      setSchedule(result.schedule);
      toast.push("Backup settings saved.", "success");
    } catch (reason) {
      toast.push(errorMessage(reason, "The backup settings could not be saved."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function showFiles(row: BackupRow) {
    if (files[row.id]) {
      setFiles((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      return;
    }
    try {
      const result = await api<{ files: BackupFile[] }>(`/organization/backups/${row.id}/files`);
      setFiles((current) => ({ ...current, [row.id]: result.files }));
    } catch (reason) {
      toast.push(errorMessage(reason, "The file list could not be loaded."), "error");
    }
  }

  async function remove(row: BackupRow) {
    if (!window.confirm("Delete this export? The files are removed from storage immediately.")) return;
    try {
      await api(`/organization/backups/${row.id}`, { method: "DELETE" });
      toast.push("Export deleted.", "success");
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The export could not be deleted."), "error");
    }
  }

  if (!canManage || !rows) return null;
  const running = rows.some((row) => row.status === "running");
  return (
    <section className="settings-section">
      <div>
        <h2>
          <DatabaseBackup size={18} />
          Workspace export
        </h2>
        <p>
          Export every table in this workspace as newline-delimited JSON, stored in your own Cloudflare account. For
          portability and audit. To restore, see the deployment guide.
        </p>
      </div>
      <div className="settings-inboxes">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <p className="settings-note">
          Point-in-time: rows written after an export starts may not be included. Attachment files are not included;
          their records are. Signing secrets, API key hashes and passwords are never exported.
        </p>

        <Button onClick={() => void create()} disabled={busy || running}>
          {running ? "Export in progress" : "Create backup"}
        </Button>

        <div className="backup-list" aria-live="polite">
          {rows.length ? (
            rows.map((row) => (
              <article key={row.id} className={row.status === "completed" ? undefined : "backup-inactive"}>
                <div>
                  <strong>{new Date(row.startedAt).toLocaleString()}</strong>
                  <small>{describe(row)}</small>
                  {row.expiresAt && row.status === "completed" && (
                    <small>Kept until {new Date(row.expiresAt).toLocaleDateString()}</small>
                  )}
                  {files[row.id] && (
                    <ul className="backup-files">
                      {files[row.id].map((file) => (
                        <li key={file.table}>
                          <a href={`/api/organization/backups/${row.id}/download/${file.table}`} download>
                            <Download size={12} /> {file.table}.ndjson
                          </a>
                          <span>{formatBytes(file.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="backup-actions">
                  {row.status === "completed" && (
                    <Button variant="secondary" size="small" onClick={() => void showFiles(row)}>
                      {files[row.id] ? "Hide files" : "Files"}
                    </Button>
                  )}
                  <Button variant="secondary" size="small" onClick={() => void remove(row)}>
                    Delete
                  </Button>
                </div>
              </article>
            ))
          ) : (
            <p className="settings-empty">No exports yet.</p>
          )}
        </div>

        <form className="backup-form" onSubmit={saveSchedule}>
          <label>
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(event) => setSchedule((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Export automatically once a week
          </label>
          <label>
            Keep exports for (days)
            <Input
              type="number"
              min={1}
              max={365}
              value={schedule.retainDays}
              onChange={(event) => setSchedule((current) => ({ ...current, retainDays: Number(event.target.value) }))}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={busy}>
            Save backup settings
          </Button>
        </form>
      </div>
    </section>
  );
}
