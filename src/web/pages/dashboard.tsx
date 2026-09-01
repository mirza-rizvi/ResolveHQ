import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CircleAlert, Clock3, Inbox, UserRoundX } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/web/lib/api";

interface Ticket { id: string; number: number; subject: string; status: string; priority: string; customerName: string; updatedAt: string; assignedUserId: string | null }

export function DashboardPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  useEffect(() => { void api<{ tickets: Ticket[] }>("/tickets").then((result) => setTickets(result.tickets)); }, []);
  const measures = useMemo(() => [
    ["Open tickets", tickets.filter((ticket) => ticket.status === "open").length, Inbox, "/inbox?queue=open"],
    ["Unassigned", tickets.filter((ticket) => !ticket.assignedUserId).length, UserRoundX, "/inbox?queue=unassigned"],
    ["Waiting for customer", tickets.filter((ticket) => ticket.status === "waiting_customer").length, Clock3, "/inbox?queue=waiting_customer"],
    ["Urgent", tickets.filter((ticket) => ticket.priority === "urgent").length, CircleAlert, "/inbox"],
    ["Resolved today", tickets.filter((ticket) => ticket.status === "resolved" && new Date(ticket.updatedAt).toDateString() === new Date().toDateString()).length, ArrowUpRight, "/inbox?queue=resolved"],
  ] as const, [tickets]);
  return <div className="standard-page"><header className="page-header"><div><h1>Today’s support ledger</h1><p>What needs attention across the workspace right now.</p></div><Link className="text-link" to="/inbox">Open inbox <ArrowUpRight size={15} /></Link></header>
    <section className="measure-strip" aria-label="Ticket summary">{measures.map(([label, count, Icon, href]) => <Link key={label} to={href}><Icon size={17} /><span>{label}</span><strong>{count}</strong></Link>)}</section>
    <div className="dashboard-columns"><section><div className="section-heading"><h2>Recent tickets</h2><span>Last activity</span></div><div className="activity-ledger">{tickets.slice(0, 8).map((ticket) => <Link key={ticket.id} to={`/inbox/${ticket.id}`}><span className={`status-pin status-${ticket.status}`} /><div><strong>{ticket.subject}</strong><small>#{ticket.number} · {ticket.customerName}</small></div><time>{new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.max(0, Math.floor((Date.now() - new Date(ticket.updatedAt).getTime()) / 3_600_000)), "hour")}</time></Link>)}</div></section>
      <section><div className="section-heading"><h2>Recent activity</h2><span>Team trail</span></div><div className="quiet-state"><p>Activity events are recorded with every assignment, reply, note, status, priority, and tag change.</p><Link to="/inbox">Review conversations</Link></div></section></div>
  </div>;
}
