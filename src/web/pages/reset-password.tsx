import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useToast } from "@/web/components/toast";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import { AuthSurface } from "./login";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const token = params.get("token");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError("");
    setSubmitting(true);
    const password = String(new FormData(event.currentTarget).get("password"));
    try {
      await api("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
      toast.push("Password updated. Sign in with your new password.", "success");
      navigate("/login", { replace: true });
    } catch (reason) {
      setError(errorMessage(reason, "This reset link is invalid or has expired."));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <AuthSurface>
      <div className="auth-heading">
        <h1>Choose a new password</h1>
        <p>Every other signed-in session is ended once the password changes.</p>
      </div>
      {!token ? (
        <p className="form-error" role="alert">
          This reset link is incomplete. Request a new one from the sign-in page.
        </p>
      ) : (
        <form onSubmit={submit} className="auth-form">
          <label>
            New password
            <Input name="password" type="password" autoComplete="new-password" minLength={12} required />
            <small>At least 12 characters.</small>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button disabled={submitting} type="submit">
            {submitting ? "Updating…" : "Update password"}
            <ArrowRight size={16} />
          </Button>
        </form>
      )}
      <p className="auth-switch">
        Need another link? <Link to="/forgot-password">Request a reset</Link>
      </p>
    </AuthSurface>
  );
}
