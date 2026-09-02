import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, MailCheck } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import { AuthSurface } from "./login";

const CONFIRMATION = "If that email exists, a reset link is on its way.";

export function ForgotPasswordPage() {
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const email = String(new FormData(event.currentTarget).get("email"));
    try {
      await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setSent(true);
    } catch (reason) {
      setError(errorMessage(reason, "The reset email could not be requested."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthSurface>
      <div className="auth-heading">
        <h1>Reset your password</h1>
        <p>We will email a link that stays valid for 30 minutes.</p>
      </div>
      {sent ? (
        <p className="settings-success" role="status">
          <MailCheck size={15} />
          {CONFIRMATION}
        </p>
      ) : (
        <form onSubmit={submit} className="auth-form">
          <label>
            Email
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button disabled={submitting} type="submit">
            {submitting ? "Sending…" : "Send reset link"}
            <ArrowRight size={16} />
          </Button>
        </form>
      )}
      <p className="auth-switch">
        Remembered it? <Link to="/login">Back to sign in</Link>
      </p>
    </AuthSurface>
  );
}
