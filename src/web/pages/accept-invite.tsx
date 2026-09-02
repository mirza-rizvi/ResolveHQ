import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/web/auth";
import { Button, Input } from "@/web/components/ui";
import { ApiError, api, errorMessage } from "@/web/lib/api";

export function AcceptInvitePage() {
  const [params] = useSearchParams(); const navigate = useNavigate(); const { session, logout, refresh } = useAuth(); const [error, setError] = useState(""); const [wrongAccount, setWrongAccount] = useState(false); const [submitting, setSubmitting] = useState(false);
  const token = params.get("token");
  const signInHref = `/login?next=${encodeURIComponent(`/accept-invite?token=${token ?? ""}`)}`;
  async function send(body: Record<string, unknown>) {
    setSubmitting(true); setError(""); setWrongAccount(false);
    try { await api("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token, ...body }) }); await refresh(); navigate("/inbox", { replace: true }); }
    catch (reason) { if (reason instanceof ApiError && reason.code === "wrong_account") setWrongAccount(true); setError(errorMessage(reason, "The invitation could not be accepted.")); }
    finally { setSubmitting(false); }
  }
  async function signOut() { try { await logout(); } catch (reason) { setError(errorMessage(reason, "Sign out failed.")); } }
  async function acceptSignedOut(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!token) return; const data = new FormData(event.currentTarget); await send({ name: data.get("name"), password: data.get("password") }); }
  return <main className="auth-surface"><section className="auth-panel"><div className="auth-heading"><span>ResolveHQ</span><h1>Join the support team</h1><p>{session ? "Accept this invitation with the account you are signed in as." : "Create your agent account to open the shared inbox."}</p></div>
    {!token ? <p className="form-error">This invitation link is incomplete. Ask the workspace owner for a new link.</p> : session
      ? <div className="auth-form">
        <p className="invite-identity">Join workspace as <strong>{session.user.email}</strong></p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {wrongAccount
          ? <Button type="button" variant="secondary" onClick={() => void signOut()}>Sign out</Button>
          : <Button type="button" disabled={submitting} onClick={() => void send({})}>{submitting ? "Joining…" : `Join workspace as ${session.user.email}`}</Button>}
      </div>
      : <><form className="auth-form" onSubmit={acceptSignedOut}>
        <label>Full name<Input name="name" autoComplete="name" required minLength={2} /></label>
        <label>Password<Input name="password" type="password" autoComplete="new-password" required minLength={12} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" disabled={submitting}>{submitting ? "Joining…" : "Join workspace"}</Button>
      </form><p className="auth-switch">Already have an account? <Link to={signInHref}>Sign in</Link></p></>}
  </section><aside className="auth-aside"><blockquote>One workspace, one accountable conversation history.</blockquote><p>Your role and tenant access are enforced on every request.</p></aside></main>;
}
