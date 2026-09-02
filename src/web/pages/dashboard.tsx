import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CircleAlert, Clock3, Inbox, TriangleAlert, UserRoundX } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/web/lib/api";

interface DashboardData {
  metrics: { openTickets: number; unassignedTickets: number; waitingForCustomer: number; urgentTickets: number; resolvedToday: number };
  recentTickets: Array<{ id: string; number: number; subject: string; status: string; priority: string; customerName: string; updatedAt: string }>;
  recentActivity: Array<{ id: string; eventType: string; ticketId: string | null; actorName: string | null; createdAt: string }>;
}

export function DashboardPage() {
  const { data, isPending, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api<DashboardData>("/operations/dashboard"), refetchInterval: 30_000 });
  const { data: settings } = useQuery({ queryKey: ["organization-settings"], queryFn: () => api<{ inboxes: unknown[] }>("/organization/settings") });
  const metrics = data?.metrics ?? { openTickets: 0, unassignedTickets: 0, waitingForCustomer: 0, urgentTickets: 0, resolvedToday: 0 };
  const measures = [
    ["Open tickets", metrics.openTickets, Inbox, "/inbox?queue=open"],
    ["Unassigned", metrics.unassignedTickets, UserRoundX, "/inbox?queue=unassigned"],
    ["Waiting for customer", metrics.waitingForCustomer, Clock3, "/inbox?queue=waiting_customer"],
    ["Urgent", metrics.urgentTickets, CircleAlert, "/inbox?priority=urgent"],
    ["Resolved today", metrics.resolvedToday, ArrowUpRight, "/inbox?queue=resolved"],
  ] as const;
  return <div className="standard-page"><header className="page-header"><div><h1>Overview</h1><p>What needs the team’s attention right now.</p></div><Link className="text-link" to="/inbox">Open inbox <ArrowUpRight size={15} /></Link></header>
    {settings && !settings.inboxes.length && <p className="page-banner"><TriangleAlert size={15} />No support inbox configured — replies cannot be sent. <Link to="/settings">Add one in Settings.</Link></p>}
    <section className="measure-strip" aria-label="Ticket summary">{measures.map(([label, count, Icon, href]) => <Link key={label} to={href} aria-busy={isPending}><Icon size={17} /><span>{label}</span><strong>{isPending ? "—" : count}</strong></Link>)}</section>
    {error && <p className="page-error">Dashboard data could not be refreshed. Try again in a moment.</p>}
    <div className="dashboard-columns"><section><div className="section-heading"><h2>Recent tickets</h2><span>Last activity</span></div><div className="activity-ledger">{data?.recentTickets.map((ticket) => <Link key={ticket.id} to={`/inbox/${ticket.id}`}><span className={`status-pin status-${ticket.status}`} /><div><strong>{ticket.subject}</strong><small>#{ticket.number} · {ticket.customerName}</small></div><time>{relativeTime(ticket.updatedAt)}</time></Link>)}</div></section>
      <section><div className="section-heading"><h2>Recent activity</h2><span>Team trail</span></div><div className="activity-ledger activity-events">{data?.recentActivity.map((event) => event.ticketId ? <Link key={event.id} to={`/inbox/${event.ticketId}`}><span className="status-pin" /><div><strong>{activityLabel(event.eventType)}</strong><small>{event.actorName ?? "System"}</small></div><time>{relativeTime(event.createdAt)}</time></Link> : <div key={event.id}><span className="status-pin" /><div><strong>{activityLabel(event.eventType)}</strong><small>{event.actorName ?? "System"}</small></div><time>{relativeTime(event.createdAt)}</time></div>)}</div></section></div>
  </div>;
}

function relativeTime(value: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-hours, "hour");
}

function activityLabel(value: string) {
  const labels: Record<string, string> = { "ticket.created": "Ticket created", "ticket.assigned": "Ticket assigned", "ticket.agent_replied": "Agent replied", "ticket.note_added": "Private note added", "ticket.status_changed": "Status changed", "ticket.priority_changed": "Priority changed", "ticket.tag_added": "Tag added", "ticket.tag_removed": "Tag removed" };
  return labels[value] ?? value.replaceAll(".", " ");
}
