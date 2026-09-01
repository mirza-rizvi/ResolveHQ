import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, MailPlus, ShieldCheck, UserRoundCog } from "lucide-react";
import { useAuth } from "@/web/auth";
import { api } from "@/web/lib/api";
import { Badge, Button, Input } from "@/web/components/ui";

interface Member { id: string; name: string; email: string; role: "owner" | "admin" | "agent"; disabledAt: string | null }

export function TeamPage() {
  const { session } = useAuth(); const [members, setMembers] = useState<Member[]>([]); const [inviteUrl, setInviteUrl] = useState(""); const [error, setError] = useState("");
  const load = async () => setMembers((await api<{ members: Member[] }>("/organization/members")).members);
  useEffect(() => { void load(); }, []);
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const form = event.currentTarget; try { const result = await api<{ invitation: { inviteUrl: string } }>("/organization/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); setInviteUrl(result.invitation.inviteUrl); form.reset(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create invitation."); } }
  return <div className="standard-page"><header className="page-header"><div><h1>Team</h1><p>Invite people, choose their operating role, and disable access when needed.</p></div></header>
    {session?.role !== "agent" && <form className="invite-strip" onSubmit={invite}><MailPlus size={18} /><label><span>Email address</span><Input name="email" type="email" placeholder="agent@company.com" required /></label><label><span>Role</span><select name="role" defaultValue="agent"><option value="agent">Agent</option><option value="admin">Admin</option></select></label><Button type="submit">Create invitation</Button>{error && <p className="form-error">{error}</p>}{inviteUrl && <p className="invite-result"><CheckCircle2 size={15} />Invitation ready: <a href={inviteUrl}>{inviteUrl}</a></p>}</form>}
    <div className="team-ledger"><div className="section-heading"><h2>{members.length} teammates</h2><span>Workspace access</span></div>{members.map((member) => <article key={member.id}><div className="team-avatar">{member.name.slice(0, 2).toUpperCase()}</div><div><strong>{member.name}</strong><small>{member.email}</small></div><Badge tone={member.role === "owner" ? "violet" : member.role === "admin" ? "blue" : "neutral"}>{member.role}</Badge><span className={member.disabledAt ? "access-disabled" : "access-active"}>{member.disabledAt ? "Disabled" : "Active"}</span><button aria-label={`Manage ${member.name}`}><UserRoundCog size={17} /></button></article>)}</div>
    <section className="role-notes"><h2><ShieldCheck size={18} />Role boundaries</h2><dl><div><dt>Owner</dt><dd>Full workspace, team, and sensitive settings access.</dd></div><div><dt>Admin</dt><dd>Manage support operations and teammates.</dd></div><div><dt>Agent</dt><dd>Handle customers and tickets without sensitive settings.</dd></div></dl></section>
  </div>;
}
