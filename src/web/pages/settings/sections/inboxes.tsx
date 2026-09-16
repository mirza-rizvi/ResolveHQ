import { type FormEvent } from "react";
import { Mail, TriangleAlert } from "lucide-react";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import type { SectionProps } from "../types";

export function InboxesSection({ data, canManage, reload, onMessage, onError }: SectionProps) {
  async function addInbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onError("");
    const form = event.currentTarget;
    try {
      await api("/organization/inboxes", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
      onMessage("Inbox added. Route this address to the ResolveHQ Worker in Cloudflare Email Routing.");
      await reload();
    } catch (reason) {
      onError(errorMessage(reason, "Inbox could not be added."));
    }
  }
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Mail size={18} />
          Support inboxes
        </h2>
        <p>Each address is globally unique and resolves to this tenant server-side.</p>
      </div>
      <div className="settings-inboxes">
        {!data.inboxes.length && (
          <p className="page-banner">
            <TriangleAlert size={15} />
            No support inbox configured — replies cannot be sent. Add one below.
          </p>
        )}
        {data.inboxes.map((inbox) => (
          <article key={inbox.id}>
            <div>
              <strong>{inbox.name}</strong>
              <small>{inbox.emailAddress}</small>
            </div>
            <span>{inbox.disabledAt ? "Disabled" : inbox.isDefault ? "Default" : "Active"}</span>
          </article>
        ))}
        {canManage && (
          <form onSubmit={addInbox}>
            <Input name="name" placeholder="Billing support" required />
            <Input name="emailAddress" type="email" placeholder="billing@example.com" required />
            <Button type="submit">Add inbox</Button>
          </form>
        )}
      </div>
    </section>
  );
}
