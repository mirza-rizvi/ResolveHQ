import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/web/auth";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import { AuthSurface } from "./login";

export function SignupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(
      [...form.entries()].filter(([, value]) => typeof value !== "string" || value.trim() !== ""),
    );
    try {
      await api("/auth/signup", { method: "POST", body: JSON.stringify(payload) });
      await refresh();
      navigate("/inbox");
    } catch (reason) {
      setError(errorMessage(reason, "Workspace creation failed."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthSurface>
      <div className="auth-heading">
        <h1>Start with a clean queue.</h1>
        <p>Create your workspace and invite the team when you are ready.</p>
      </div>
      <form onSubmit={submit} className="auth-form">
        <label>
          Your name
          <Input name="name" autoComplete="name" required />
        </label>
        <label>
          Work email
          <Input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Workspace name
          <Input name="organizationName" required />
        </label>
        <label>
          Workspace URL
          <Input name="organizationSlug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="northstar-labs" required />
        </label>
        <label>
          Password
          <Input name="password" type="password" minLength={12} autoComplete="new-password" required />
          <small>At least 12 characters.</small>
        </label>
        <label>
          Support email (optional)
          <Input name="supportEmail" type="email" placeholder="support@example.com" />
          <small>The address customers write to. You can add it later in Settings.</small>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button disabled={submitting} type="submit">
          {submitting ? "Creating…" : "Create workspace"}
          <ArrowRight size={16} />
        </Button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthSurface>
  );
}
