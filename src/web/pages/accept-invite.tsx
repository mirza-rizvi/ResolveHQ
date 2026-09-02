import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/web/auth";
import { Button, Input } from "@/web/components/ui";
import { api } from "@/web/lib/api";

export function AcceptInvitePage() {
  const [params] = useSearchParams(); const navigate = useNavigate(); const { session, refresh } = useAuth(); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const token = params.get("token");
  if (session) return <Navigate to="/inbox" replace />;
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token) return; setSubmitting(true); setError(""); const data = new FormData(event.currentTarget);
    try { await api("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token, name: data.get("name"), password: data.get("password") }) }); await refresh(); navigate("/inbox", { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The invitation could not be accepted."); }
    finally { setSubmitting(false); }
  }
  return <main className="auth-surface"><section className="auth-panel"><div className="auth-heading"><span>ResolveHQ</span><h1>Join the support team</h1><p>Create your agent account to open the shared inbox.</p></div>{!token ? <p className="form-error">This invitation link is incomplete. Ask the workspace owner for a new link.</p> : <form className="auth-form" onSubmit={accept}><label>Full name<Input name="name" autoComplete="name" required minLength={2} /></label><label>Password<Input name="password" type="password" autoComplete="new-password" required minLength={12} /></label>{error && <p className="form-error">{error}</p>}<Button type="submit" disabled={submitting}>{submitting ? "Joining…" : "Join workspace"}</Button></form>}</section><aside className="auth-aside"><blockquote>One workspace, one accountable conversation history.</blockquote><p>Your role and tenant access are enforced on every request.</p></aside></main>;
}
