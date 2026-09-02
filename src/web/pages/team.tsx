import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, MailPlus, ShieldCheck } from "lucide-react";
import { useAuth } from "@/web/auth";
import { useToast } from "@/web/components/toast";
import { api, errorMessage } from "@/web/lib/api";
import { Badge, Button, Input } from "@/web/components/ui";

interface Member { id: string; name: string; email: string; role: "owner" | "admin" | "agent"; disabledAt: string | null }

export function TeamPage() {
  const { session } = useAuth(); const toast = useToast(); const [members, setMembers] = useState<Member[]>([]); const [inviteUrl, setInviteUrl] = useState(""); const [error, setError] = useState(""); const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try { setMembers((await api<{ members: Member[] }>("/organization/members")).members); setLoaded(true); }
    catch (reason) { setLoaded(false); toast.push(errorMessage(reason, "Teammates could not be loaded."), "error"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const form = event.currentTarget; try { const result = await api<{ invitation: { inviteUrl: string } }>("/organization/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); setInviteUrl(result.invitation.inviteUrl); form.reset(); } catch (reason) { setError(errorMessage(reason, "Could not create invitation.")); } }
  async function updateMember(member: Member, values: { role?: "admin" | "agent"; disabled?: boolean }) { setError(""); try { await api(`/organization/members/${member.id}`, { method: "PATCH", body: JSON.stringify(values) }); await load(); } catch (reason) { toast.push(errorMessage(reason, "Team access could not be updated."), "error"); } }
  return <div className="standard-page"><header className="page-header"><div><h1>Team</h1><p>Invite people, choose their operating role, and disable access when needed.</p></div></header>
    {session?.role !== "agent" && <form className="invite-strip" onSubmit={invite}><MailPlus size={18} /><label><span>Email address</span><Input name="email" type="email" placeholder="agent@company.com" required /></label><label><span>Role</span><select name="role" defaultValue="agent"><option value="agent">Agent</option><option value="admin">Admin</option></select></label><Button type="submit">Create invitation</Button>{error && <p className="form-error">{error}</p>}{inviteUrl && <p className="invite-result"><CheckCircle2 size={15} />Invitation ready: <a href={inviteUrl}>{inviteUrl}</a></p>}</form>}
    <div className="team-ledger"><div className="section-heading"><h2>{members.length} teammates</h2><span>Workspace access</span></div>{loaded && !members.length && <p className="ledger-empty">No teammates yet. Invite one above to share the queue.</p>}{members.map((member) => <article key={member.id}><div className="team-avatar">{member.name.slice(0, 2).toUpperCase()}</div><div><strong>{member.name}</strong><small>{member.email}</small></div>{session?.role !== "agent" && member.role !== "owner" && member.id !== session?.user.id ? <select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => void updateMember(member, { role: event.target.value as "admin" | "agent" })}><option value="agent">Agent</option><option value="admin">Admin</option></select> : <Badge tone={member.role === "owner" ? "violet" : member.role === "admin" ? "blue" : "neutral"}>{member.role}</Badge>}<span className={member.disabledAt ? "access-disabled" : "access-active"}>{member.disabledAt ? "Disabled" : "Active"}</span>{session?.role !== "agent" && member.role !== "owner" && member.id !== session?.user.id ? <button className="member-access-button" onClick={() => void updateMember(member, { disabled: !member.disabledAt })}>{member.disabledAt ? "Enable" : "Disable"}</button> : <span />}</article>)}</div>
    <section className="role-notes"><h2><ShieldCheck size={18} />Role boundaries</h2><dl><div><dt>Owner</dt><dd>Full workspace, team, and sensitive settings access.</dd></div><div><dt>Admin</dt><dd>Manage support operations and teammates.</dd></div><div><dt>Agent</dt><dd>Handle customers and tickets without sensitive settings.</dd></div></dl></section>
  </div>;
}
