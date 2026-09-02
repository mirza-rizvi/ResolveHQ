import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Mail, ShieldCheck, TriangleAlert } from "lucide-react";
import { useAuth } from "@/web/auth";
import { useToast } from "@/web/components/toast";
import { Button, Input } from "@/web/components/ui";
import { ApiError, api, errorMessage } from "@/web/lib/api";

interface SettingsData { workspace: { id: string; name: string; slug: string }; inboxes: Array<{ id: string; name: string; emailAddress: string; provider: string; isDefault: boolean; disabledAt: string | null }>; mail: { resendConfigured: boolean; webhookConfigured: boolean } }
interface MailCapture { id: string; toAddress: string; fromAddress: string; subject: string; text: string | null; html: string | null; createdAt: string }

export function SettingsPage() {
  const { session } = useAuth(); const toast = useToast();
  const [data, setData] = useState<SettingsData | null>(null); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [captures, setCaptures] = useState<MailCapture[] | null>(null); const [captureError, setCaptureError] = useState("");
  const load = useCallback(() => api<SettingsData>("/organization/settings").then(setData), []);
  useEffect(() => { load().catch((reason) => setError(errorMessage(reason, "Settings could not be loaded."))); }, [load]);
  useEffect(() => {
    api<{ captures: MailCapture[] }>("/operations/dev-mail").then((result) => { setCaptures(result.captures); setCaptureError(""); }).catch((reason) => {
      if (reason instanceof ApiError && [403, 404].includes(reason.status)) return;
      setCaptureError("Captured mail could not be loaded.");
      toast.push(errorMessage(reason, "Captured mail could not be loaded."), "error");
    });
  }, [toast]);
  async function saveWorkspace(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const name = String(new FormData(event.currentTarget).get("name")); try { await api("/organization/settings", { method: "PATCH", body: JSON.stringify({ name }) }); setMessage("Workspace name saved."); await load(); } catch (reason) { setError(errorMessage(reason, "Workspace could not be saved.")); } }
  async function addInbox(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const form = event.currentTarget; try { await api("/organization/inboxes", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); setMessage("Inbox added. Route this address to the ResolveHQ Worker in Cloudflare Email Routing."); await load(); } catch (reason) { setError(errorMessage(reason, "Inbox could not be added.")); } }
  async function changePassword(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const form = event.currentTarget; const values = new FormData(form); try { await api("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: values.get("currentPassword"), newPassword: values.get("newPassword") }) }); form.reset(); toast.push("Password updated. Other sessions were signed out.", "success"); } catch (reason) { toast.push(errorMessage(reason, "Password could not be changed."), "error"); } }
  if (!data) return <div className="standard-page">{error ? <p className="page-error">{error}</p> : <div className="route-loading" aria-label="Loading settings" />}</div>;
  const canManage = session?.role !== "agent";
  return <div className="standard-page"><header className="page-header"><div><h1>Workspace settings</h1><p>Identity, support inboxes, and production mail readiness.</p></div></header>
    {message && <p className="settings-success"><CheckCircle2 size={15} />{message}</p>}{error && <p className="page-error">{error}</p>}
    <section className="settings-section"><div><h2>Workspace identity</h2><p>The name agents see throughout ResolveHQ.</p></div><form onSubmit={saveWorkspace}><label>Name<Input name="name" defaultValue={data.workspace.name} disabled={!canManage} required /></label><label>Slug<Input value={data.workspace.slug} disabled /></label>{canManage && <Button type="submit">Save workspace</Button>}</form></section>
    <section className="settings-section"><div><h2><Mail size={18} />Support inboxes</h2><p>Each address is globally unique and resolves to this tenant server-side.</p></div><div className="settings-inboxes">{!data.inboxes.length && <p className="page-banner"><TriangleAlert size={15} />No support inbox configured — replies cannot be sent. Add one below.</p>}{data.inboxes.map((inbox) => <article key={inbox.id}><div><strong>{inbox.name}</strong><small>{inbox.emailAddress}</small></div><span>{inbox.disabledAt ? "Disabled" : inbox.isDefault ? "Default" : "Active"}</span></article>)}{canManage && <form onSubmit={addInbox}><Input name="name" placeholder="Billing support" required /><Input name="emailAddress" type="email" placeholder="billing@example.com" required /><Button type="submit">Add inbox</Button></form>}</div></section>
    <section className="settings-section"><div><h2><KeyRound size={18} />Account</h2><p>Changing your password signs out every other session on this account.</p></div><form onSubmit={changePassword}><label>Current password<Input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>New password<Input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /><small>At least 12 characters.</small></label><Button type="submit">Change password</Button></form></section>
    <section className="settings-section"><div><h2><ShieldCheck size={18} />Mail delivery</h2><p>Secrets remain Worker bindings and are never returned to the browser.</p></div><dl className="readiness-list"><div><dt>Resend API key</dt><dd>{data.mail.resendConfigured ? "Configured" : "Missing"}</dd></div><div><dt>Signed webhook</dt><dd>{data.mail.webhookConfigured ? "Configured" : "Missing"}</dd></div></dl></section>
    {(captures || captureError) && <section className="settings-section"><div><h2><Mail size={18} />Captured outgoing mail (development)</h2><p>Mail is captured instead of delivered while no Resend key is configured.</p></div><div className="mail-captures">{captureError ? <p className="form-error" role="alert">{captureError}</p> : captures?.length ? captures.map((capture) => <article key={capture.id}><header><strong>{capture.toAddress}</strong><span>{capture.subject}</span><time>{new Date(capture.createdAt).toLocaleString()}</time></header>{capture.text && <details><summary>View text</summary><pre>{capture.text}</pre></details>}</article>) : <p className="settings-empty">Nothing captured yet.</p>}</div></section>}
  </div>;
}
