import { useCallback, useEffect, useState } from "react";
import { Play, Plus, Workflow, X, Zap } from "lucide-react";
import { useAuth } from "@/web/auth";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";
import { Badge, Button, Input } from "@/web/components/ui";

interface RuleCondition {
  field: "subject" | "priority" | "status" | "customerEmail" | "inboxId";
  op: "is" | "contains";
  value: string;
}
type RuleAction =
  | { type: "set_priority"; priority: string }
  | { type: "set_status"; status: string }
  | { type: "assign_user"; userId: string }
  | { type: "add_tag"; name: string };
interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: RuleCondition[];
  actions: RuleAction[];
}
interface Run {
  id: string;
  ruleName: string;
  ticketNumber: number;
  ticketSubject: string;
  ticketId: string;
  eventKey: string;
  applied: string;
  createdAt: string;
}

const fieldLabels: Record<RuleCondition["field"], string> = {
  subject: "Subject",
  priority: "Priority",
  status: "Status",
  customerEmail: "Customer email",
  inboxId: "Inbox",
};

function describe(action: RuleAction): string {
  if (action.type === "set_priority") return `set priority to ${action.priority}`;
  if (action.type === "set_status") return `set status to ${action.status}`;
  if (action.type === "assign_user") return "assign to member";
  return `add tag “${action.name}”`;
}

export function AutomationsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const canManage = session?.role === "owner" || session?.role === "admin";

  const load = useCallback(async () => {
    try {
      const [ruleResult, runResult] = await Promise.all([
        api<{ rules: Rule[] }>("/automations"),
        api<{ runs: Run[] }>("/automations/runs"),
      ]);
      setRules(ruleResult.rules);
      setRuns(runResult.runs);
      setLoaded(true);
    } catch (reason) {
      toast.push(errorMessage(reason, "Automations could not be loaded."), "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const condition = {
      field: String(form.get("field")) as RuleCondition["field"],
      op: String(form.get("op")) as RuleCondition["op"],
      value: String(form.get("value") ?? "").trim(),
    };
    const actionType = String(form.get("actionType"));
    const action: RuleAction =
      actionType === "set_priority"
        ? { type: "set_priority", priority: String(form.get("priority") ?? "high") }
        : actionType === "set_status"
          ? { type: "set_status", status: String(form.get("status") ?? "pending") }
          : actionType === "assign_user"
            ? { type: "assign_user", userId: String(form.get("userId") ?? "") }
            : { type: "add_tag", name: String(form.get("tagName") ?? "") };
    const values = {
      name: String(form.get("name") ?? "").trim(),
      enabled: true,
      conditions: [condition],
      actions: [action],
    };
    try {
      if (editing && editing !== "new") {
        await api(`/automations/${editing.id}`, { method: "PATCH", body: JSON.stringify(values) });
      } else {
        await api("/automations", { method: "POST", body: JSON.stringify(values) });
      }
      setEditing(null);
      toast.push("Automation saved.", "success");
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The automation could not be saved."), "error");
    }
  }

  async function toggle(rule: Rule) {
    try {
      await api(`/automations/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !rule.enabled }) });
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The automation could not be updated."), "error");
    }
  }

  async function remove(rule: Rule) {
    if (!window.confirm(`Delete the automation “${rule.name}”?`)) return;
    try {
      await api(`/automations/${rule.id}`, { method: "DELETE" });
      toast.push("Automation deleted.", "success");
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The automation could not be deleted."), "error");
    }
  }

  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Automations</h1>
          <p>
            Rules run top to bottom when a ticket is created or a customer replies. Each event triggers a rule once.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setEditing((current) => (current ? null : "new"))}>
            {editing ? <X size={15} /> : <Plus size={15} />}
            {editing ? "Close" : "New rule"}
          </Button>
        )}
      </header>
      {editing && (
        <form className="kb-editor" onSubmit={save}>
          <div className="kb-editor-row">
            <label>
              Rule name
              <Input
                name="name"
                required
                maxLength={120}
                defaultValue={editing !== "new" ? editing.name : ""}
                placeholder="Escalate angry replies"
              />
            </label>
            <label>
              When
              <select name="field" defaultValue={editing !== "new" ? editing.conditions[0]?.field : "subject"}>
                {(Object.keys(fieldLabels) as RuleCondition["field"][]).map((field) => (
                  <option key={field} value={field}>
                    {fieldLabels[field]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Match
              <select name="op" defaultValue={editing !== "new" ? editing.conditions[0]?.op : "contains"}>
                <option value="contains">contains</option>
                <option value="is">is exactly</option>
              </select>
            </label>
            <label>
              Value
              <Input
                name="value"
                required
                maxLength={240}
                defaultValue={editing !== "new" ? editing.conditions[0]?.value : ""}
              />
            </label>
          </div>
          <div className="kb-editor-row">
            <label>
              Then
              <select
                name="actionType"
                defaultValue={editing !== "new" ? (editing.actions[0]?.type ?? "set_priority") : "set_priority"}
              >
                <option value="set_priority">Set priority</option>
                <option value="set_status">Set status</option>
                <option value="assign_user">Assign to member</option>
                <option value="add_tag">Add tag</option>
              </select>
            </label>
            <label>
              Priority
              <Input name="priority" defaultValue="high" />
            </label>
            <label>
              Status
              <Input name="status" defaultValue="pending" />
            </label>
            <label>
              Member id
              <Input name="userId" placeholder="usr_…" />
            </label>
            <label>
              Tag
              <Input name="tagName" placeholder="escalate" />
            </label>
          </div>
          <p className="kb-hint">Fill in only the field for the action you picked — the others are ignored.</p>
          <div className="kb-editor-actions">
            <Button type="submit">
              <Play size={14} />
              Save rule
            </Button>
          </div>
        </form>
      )}
      {loaded && !rules.length && (
        <p className="ledger-empty">
          No automations yet. A first rule could tag every reply containing “invoice” for the billing team.
        </p>
      )}
      <div className="kb-list">
        {rules.map((rule) => (
          <article key={rule.id}>
            <Workflow size={16} />
            <button
              type="button"
              className="kb-title"
              disabled={!canManage}
              onClick={() => setEditing(canManage ? rule : null)}
            >
              <strong>{rule.name}</strong>
              <small>
                {rule.conditions
                  .map((condition) => `${fieldLabels[condition.field]} ${condition.op} “${condition.value}”`)
                  .join(" · ")}
              </small>
            </button>
            <span>{rule.actions.map(describe).join(", ")}</span>
            <button type="button" className="rule-toggle" onClick={() => void toggle(rule)} disabled={!canManage}>
              <Badge tone={rule.enabled ? "green" : "neutral"}>{rule.enabled ? "on" : "off"}</Badge>
            </button>
            {canManage && (
              <Button variant="ghost" size="icon" aria-label={`Delete ${rule.name}`} onClick={() => void remove(rule)}>
                <X size={13} />
              </Button>
            )}
          </article>
        ))}
      </div>
      <section className="role-notes">
        <h2>
          <Zap size={16} />
          Recent runs
        </h2>
        {loaded && !runs.length && <p className="ledger-empty">No rules have fired yet.</p>}
        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <strong>{run.ruleName}</strong>
              <span>
                #{run.ticketNumber} {run.ticketSubject}
              </span>
              <small>{new Date(run.createdAt).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
