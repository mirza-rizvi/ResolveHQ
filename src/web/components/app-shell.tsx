import { BookOpen, ChartNoAxesColumn, CircleGauge, Inbox, LogOut, Settings, Sparkles, Tickets, Users, Workflow } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/web/auth";
import { Button } from "./ui";

const navigation = [
  ["Inbox", "/inbox", Inbox], ["Tickets", "/tickets", Tickets], ["Customers", "/customers", Users],
  ["Knowledge Base", "/knowledge-base", BookOpen], ["Reports", "/reports", ChartNoAxesColumn],
  ["Automations", "/automations", Workflow], ["Team", "/team", CircleGauge], ["Settings", "/settings", Settings],
] as const;

export function AppShell() {
  const { session, logout } = useAuth();
  return (
    <div className="app-shell">
      <aside className="global-rail">
        <div className="brand-lockup"><span className="brand-mark"><Sparkles size={16} /></span><span>ResolveHQ</span></div>
        <NavLink to="/dashboard" className="workspace-switcher">
          <span className="workspace-avatar">{session?.organization.name.slice(0, 2).toUpperCase()}</span>
          <span><strong>{session?.organization.name}</strong><small>{session?.role}</small></span>
        </NavLink>
        <nav aria-label="Primary navigation">
          {navigation.map(([label, href, Icon]) => <NavLink key={href} to={href} className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}><Icon size={17} /><span>{label}</span></NavLink>)}
        </nav>
        <div className="rail-footer">
          <div className="agent-chip"><span>{session?.user.name.slice(0, 1)}</span><div><strong>{session?.user.name}</strong><small>{session?.user.email}</small></div></div>
          <Button aria-label="Sign out" title="Sign out" variant="ghost" size="icon" onClick={() => void logout()}><LogOut size={17} /></Button>
        </div>
      </aside>
      <main className="workspace"><Outlet /></main>
    </div>
  );
}
