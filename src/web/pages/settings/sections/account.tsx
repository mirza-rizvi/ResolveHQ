import { type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { useToast } from "@/web/components/toast";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";

export function AccountSection() {
  const toast = useToast();
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: values.get("currentPassword"),
          newPassword: values.get("newPassword"),
        }),
      });
      form.reset();
      toast.push("Password updated. Other sessions were signed out.", "success");
    } catch (reason) {
      toast.push(errorMessage(reason, "Password could not be changed."), "error");
    }
  }
  return (
    <section className="settings-section">
      <div>
        <h2>
          <KeyRound size={18} />
          Account
        </h2>
        <p>Changing your password signs out every other session on this account.</p>
      </div>
      <form onSubmit={changePassword}>
        <label>
          Current password
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <Input name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
          <small>At least 12 characters.</small>
        </label>
        <Button type="submit">Change password</Button>
      </form>
    </section>
  );
}
