import { type FormEvent } from "react";
import { Button, Input } from "@/web/components/ui";
import { api, errorMessage } from "@/web/lib/api";
import type { SectionProps } from "../types";

export function WorkspaceSection({ data, canManage, reload, onMessage, onError }: SectionProps) {
  async function saveWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onError("");
    const name = String(new FormData(event.currentTarget).get("name"));
    try {
      await api("/organization/settings", { method: "PATCH", body: JSON.stringify({ name }) });
      onMessage("Workspace name saved.");
      await reload();
    } catch (reason) {
      onError(errorMessage(reason, "Workspace could not be saved."));
    }
  }
  return (
    <section className="settings-section">
      <div>
        <h2>Workspace identity</h2>
        <p>The name agents see throughout ResolveHQ.</p>
      </div>
      <form onSubmit={saveWorkspace}>
        <label>
          Name
          <Input name="name" defaultValue={data.workspace.name} disabled={!canManage} required />
        </label>
        <label>
          Slug
          <Input value={data.workspace.slug} disabled />
        </label>
        {canManage && <Button type="submit">Save workspace</Button>}
      </form>
    </section>
  );
}
