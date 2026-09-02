import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAuth, type Session } from "@/web/auth";
import { api, errorMessage } from "@/web/lib/api";
import { safeNext } from "@/web/lib/next";
import { Button, Input } from "@/web/components/ui";

export function LoginPage() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const destination = safeNext(params.get("next"));
  if (session) return <Navigate to={destination} replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      await refresh();
      navigate(destination);
    } catch (reason) {
      setError(errorMessage(reason, "Sign in failed."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthSurface>
      <div className="auth-heading">
        <h1>Sign in to ResolveHQ</h1>
        <p>Continue to your team’s support workspace.</p>
      </div>
      <form onSubmit={submit} className="auth-form">
        <label>
          Email
          <Input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <Input name="password" type="password" autoComplete="current-password" minLength={12} required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button disabled={submitting} type="submit">
          {submitting ? "Signing in…" : "Sign in"}
          <ArrowRight size={16} />
        </Button>
        <Link className="auth-form-link" to="/forgot-password">
          Forgot password?
        </Link>
      </form>
      <p className="auth-switch">
        New workspace? <Link to="/signup">Create an account</Link>
      </p>
    </AuthSurface>
  );
}

export function AuthSurface({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-surface">
      <section className="auth-panel">
        <Link className="auth-brand" to="/">
          ResolveHQ
        </Link>
        {children}
      </section>
      <aside className="auth-aside" aria-hidden="true">
        <span>Support operations, without the overhead.</span>
        <ol>
          <li>Prioritize the queue</li>
          <li>Keep customer context close</li>
          <li>Resolve work together</li>
        </ol>
      </aside>
    </main>
  );
}
