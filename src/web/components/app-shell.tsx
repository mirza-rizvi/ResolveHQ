import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ChartNoAxesColumn, CircleGauge, Command, Inbox, LogOut, Search, Settings, Users, Workflow, X } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/web/auth";
import { useDialogFocus } from "@/web/hooks/use-dialog-focus";
import { Button } from "./ui";

const navigation = [
  { label: "Inbox", href: "/inbox", icon: Inbox, shortcut: "I", primary: true },
  { label: "Dashboard", href: "/dashboard", icon: CircleGauge, shortcut: "D", primary: true },
  { label: "Customers", href: "/customers", icon: Users, shortcut: "C", primary: true },
  { label: "Knowledge", href: "/knowledge-base", icon: BookOpen, shortcut: "K" },
  { label: "Reports", href: "/reports", icon: ChartNoAxesColumn, shortcut: "R" },
  { label: "Automations", href: "/automations", icon: Workflow, shortcut: "A" },
  { label: "Team", href: "/team", icon: Users, shortcut: "T", primary: true },
  { label: "Settings", href: "/settings", icon: Settings, shortcut: "S" },
] as const;

export function AppShell() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const chordStartedAt = useRef(0);
  const closeCommand = useCallback(() => setCommandOpen(false), []);
  const commandDialogRef = useDialogFocus(commandOpen, closeCommand);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setCommandOpen(true); return;
      }
      if (event.key === "Escape") { setCommandOpen(false); return; }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "g") { chordStartedAt.current = Date.now(); return; }
      if (Date.now() - chordStartedAt.current < 1_000) {
        const destination = navigation.find((item) => item.shortcut.toLowerCase() === key);
        if (destination) { event.preventDefault(); navigate(destination.href); }
        chordStartedAt.current = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const filteredNavigation = navigation.filter((item) => item.label.toLowerCase().includes(commandQuery.trim().toLowerCase()));
  return <div className="app-shell">
    <header className="command-bar">
      <NavLink className="wordmark" to="/inbox">ResolveHQ</NavLink>
      <div className="workspace-menu"><span>{session?.organization.name}</span></div>
      <nav className="command-navigation" aria-label="Primary navigation">
        {navigation.map(({ label, href }) => <NavLink key={href} to={href} className={({ isActive }) => isActive ? "command-link active" : "command-link"}>{label}</NavLink>)}
      </nav>
      <button className="command-trigger" type="button" onClick={() => setCommandOpen(true)}><Search size={15} /><span>Search or jump to</span><kbd>⌘K</kbd></button>
      <div className="account-menu"><span>{session?.user.name.slice(0, 2).toUpperCase()}</span><strong>{session?.user.name}</strong></div>
    </header>
    <main className="workspace"><Outlet /></main>
    <nav className="mobile-navigation" aria-label="Mobile navigation">
      {navigation.filter((item) => "primary" in item && item.primary).map(({ label, href, icon: Icon }) => <NavLink key={href} to={href} className={({ isActive }) => isActive ? "active" : ""}><Icon size={18} /><span>{label}</span></NavLink>)}
      <button type="button" onClick={() => setCommandOpen(true)}><Command size={18} /><span>More</span></button>
    </nav>
    {commandOpen && <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}>
      <section ref={commandDialogRef} className="command-dialog" role="dialog" aria-modal="true" aria-label="Command menu">
        <header><Search size={17} /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search pages and actions" aria-label="Search commands" /><button type="button" onClick={() => setCommandOpen(false)} aria-label="Close command menu"><X size={17} /></button></header>
        <div className="command-results"><span>Go to</span>{filteredNavigation.map(({ label, href, icon: Icon, shortcut }) => <button key={href} type="button" onClick={() => { navigate(href); setCommandOpen(false); setCommandQuery(""); }}><Icon size={16} /><strong>{label}</strong><kbd>G {shortcut}</kbd></button>)}{!filteredNavigation.length && <p>No matching destination.</p>}</div>
        <footer><div><span className="user-dot">{session?.user.name.slice(0, 1)}</span><span><strong>{session?.user.name}</strong><small>{session?.user.email}</small></span></div><Button variant="ghost" size="small" onClick={() => void logout()}><LogOut size={15} />Sign out</Button></footer>
      </section>
    </div>}
  </div>;
}
