import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  ChartNoAxesColumn,
  ChevronDown,
  CircleGauge,
  Menu,
  Inbox,
  LogOut,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/web/auth";
import { useDialogFocus } from "@/web/hooks/use-dialog-focus";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "./ui";
import { useToast } from "./toast";
import { chordPending, consumeChord, startChord } from "@/web/lib/chord";

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
  const { session, logout, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [commandOpen, setCommandOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("resolvehq-theme") as "light" | "dark" | null) ?? "light",
  );
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const accountRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const closeCommand = useCallback(() => setCommandOpen(false), []);
  const commandDialogRef = useDialogFocus(commandOpen, closeCommand);
  const location = useLocation();
  const closeRail = useCallback(() => setRailOpen(false), []);
  const railRef = useDialogFocus(railOpen && !commandOpen, closeRail);

  useEffect(() => {
    setRailOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("resolvehq-theme", theme);
  }, [theme]);

  const loadNotifications = useCallback(() => {
    api<{ notifications: NotificationRow[] }>("/operations/notifications")
      .then((result) => setNotifications(result.notifications))
      .catch(() => setNotifications([]));
  }, []);

  useEffect(() => {
    loadNotifications();
    const interval = window.setInterval(loadNotifications, 30_000);
    return () => window.clearInterval(interval);
  }, [loadNotifications]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setAccountOpen(false);
        setNotificationsOpen(false);
        setRailOpen(false);
        return;
      }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      // The chord lives in a module the inbox can read, so its own j/k/r
      // shortcuts can stand aside for the second keystroke of `g <key>`.
      if (key === "g") {
        startChord();
        return;
      }
      if (chordPending()) {
        const destination = navigation.find((item) => item.shortcut.toLowerCase() === key);
        if (destination) {
          event.preventDefault();
          navigate(destination.href);
        }
        // Recorded against this event so a page handler that runs after this
        // one still knows the keystroke belonged to the chord.
        consumeChord(event);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    if (!accountOpen && !notificationsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!accountRef.current?.contains(target)) setAccountOpen(false);
      if (!notificationsRef.current?.contains(target)) setNotificationsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [accountOpen, notificationsOpen]);

  const signOut = async () => {
    setAccountOpen(false);
    try {
      await logout();
    } catch (reason) {
      toast.push(errorMessage(reason, "Sign out failed."), "error");
      return;
    }
    queryClient.clear();
    navigate("/login");
  };
  const changeWorkspace = async (organizationId: string) => {
    try {
      await switchWorkspace(organizationId);
      queryClient.clear();
      navigate("/inbox");
    } catch (reason) {
      toast.push(errorMessage(reason, "Workspace could not be switched."), "error");
    }
  };
  const workspaces = session?.workspaces ?? [];
  const filteredNavigation = navigation.filter((item) =>
    item.label.toLowerCase().includes(commandQuery.trim().toLowerCase()),
  );
  const hasUnread = notifications.some((row) => !row.readAt);

  return (
    <div className={`app-shell ${railOpen ? "rail-open" : ""}`}>
      {railOpen && <button className="rail-scrim" aria-label="Close navigation" onClick={closeRail} tabIndex={-1} />}
      <aside
        className="rail"
        ref={railRef}
        role={railOpen ? "dialog" : undefined}
        aria-modal={railOpen || undefined}
        aria-label="Workspace navigation"
      >
        <button className="rail-close" aria-label="Close navigation" onClick={closeRail}>
          <X size={20} />
        </button>
        {workspaces.length > 1 ? (
          <label className="rail-workspace">
            <span className="rail-workspace-mark">{(session?.organization.name ?? "R").slice(0, 1)}</span>
            <span>
              <strong>{session?.organization.name}</strong>
              <small>Switch workspace</small>
            </span>
            <select
              aria-label="Workspace"
              value={session?.organization.id ?? ""}
              onChange={(event) => void changeWorkspace(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="rail-workspace">
            <span className="rail-workspace-mark">{(session?.organization.name ?? "R").slice(0, 1)}</span>
            <span>
              <strong>{session?.organization.name}</strong>
              <small>Support workspace</small>
            </span>
          </div>
        )}
        <button className="rail-jump" type="button" onClick={() => setCommandOpen(true)}>
          <Search size={15} />
          <span>Jump to…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="rail-nav" aria-label="Primary navigation" onClick={closeRail}>
          <div className="rail-section">Workspace</div>
          {navigation.slice(0, 3).map(({ label, href, icon: Icon }) => (
            <NavLink key={href} to={href} className={({ isActive }) => (isActive ? "rail-link active" : "rail-link")}>
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
          <div className="rail-section">Grow</div>
          {navigation.slice(3, 6).map(({ label, href, icon: Icon }) => (
            <NavLink key={href} to={href} className={({ isActive }) => (isActive ? "rail-link active" : "rail-link")}>
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
          <div className="rail-section">Workspace admin</div>
          {navigation.slice(6).map(({ label, href, icon: Icon }) => (
            <NavLink key={href} to={href} className={({ isActive }) => (isActive ? "rail-link active" : "rail-link")}>
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="rail-dock">
          <div ref={notificationsRef} style={{ position: "relative" }}>
            <button
              className="rail-dock-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={notificationsOpen}
              aria-label={
                hasUnread
                  ? `Notifications, ${notifications.filter((row) => !row.readAt).length} unread`
                  : "Notifications"
              }
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <Bell size={17} />
              {hasUnread && <i aria-hidden="true" />}
            </button>
            {notificationsOpen && (
              <div className="rail-popover" role="menu" aria-label="Notifications">
                <header>
                  <strong>Notifications</strong>
                  <button type="button" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)}>
                    <X size={14} />
                  </button>
                </header>
                {notifications.length ? (
                  <ul>
                    {notifications.slice(0, 12).map((row) => (
                      <li key={row.id} className={row.readAt ? "" : "unread"}>
                        <button
                          type="button"
                          onClick={() => {
                            setNotificationsOpen(false);
                            if (row.ticketId) navigate(`/inbox/${row.ticketId}`);
                            if (!row.readAt)
                              void api(`/operations/notifications/${row.id}/read`, { method: "POST" }).then(
                                loadNotifications,
                              );
                          }}
                        >
                          <span>{row.title}</span>
                          <small>{new Date(row.createdAt).toLocaleString()}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="notifications-empty">You're all caught up.</p>
                )}
              </div>
            )}
          </div>
          <button
            className="rail-dock-trigger"
            type="button"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <div ref={accountRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button
              className="rail-account"
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="rail-account-mark">{session?.user.name.slice(0, 2).toUpperCase()}</span>
              <strong>{session?.user.name}</strong>
              <ChevronDown size={14} />
            </button>
            {accountOpen && (
              <div className="rail-popover" role="menu" aria-label="Account">
                <header>
                  <strong>{session?.user.name}</strong>
                  <button type="button" aria-label="Close account menu" onClick={() => setAccountOpen(false)}>
                    <X size={14} />
                  </button>
                </header>
                <ul>
                  <li>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountOpen(false);
                        navigate("/settings");
                      }}
                    >
                      <span>Settings</span>
                      <small>Profile, password, and mail readiness</small>
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" onClick={() => void signOut()}>
                      <span>Sign out</span>
                      <small>End this session on all tabs</small>
                    </button>
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </aside>
      <div className="rail-page">
        <main className="workspace" inert={railOpen || undefined}>
          <Outlet />
        </main>
        <nav className="mobile-navigation" aria-label="Mobile navigation">
          {navigation
            .filter((item) => "primary" in item && item.primary)
            .map(({ label, href, icon: Icon }) => (
              <NavLink
                key={href}
                to={href}
                className={({ isActive }) => (isActive ? "active" : "")}
                onClick={() => setRailOpen(false)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </NavLink>
            ))}
          <button type="button" aria-expanded={railOpen} onClick={() => setRailOpen((open) => !open)}>
            <Menu size={18} />
            <span>Menu</span>
          </button>
        </nav>
        {commandOpen && (
          <div
            className="command-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setCommandOpen(false);
            }}
          >
            <section
              ref={commandDialogRef}
              className="command-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Command menu"
            >
              <header>
                <Search size={17} />
                <input
                  autoFocus
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  placeholder="Search pages and actions"
                  aria-label="Search commands"
                />
                <button type="button" onClick={() => setCommandOpen(false)} aria-label="Close command menu">
                  <X size={17} />
                </button>
              </header>
              <div className="command-results">
                <span>Go to</span>
                {filteredNavigation.map(({ label, href, icon: Icon, shortcut }) => (
                  <button
                    key={href}
                    type="button"
                    onClick={() => {
                      navigate(href);
                      setCommandOpen(false);
                      setCommandQuery("");
                    }}
                  >
                    <Icon size={16} />
                    <strong>{label}</strong>
                    <kbd>G {shortcut}</kbd>
                  </button>
                ))}
                {!filteredNavigation.length && <p>No matching destination.</p>}
              </div>
              <footer>
                <div>
                  <span className="user-dot">{session?.user.name.slice(0, 1)}</span>
                  <span>
                    <strong>{session?.user.name}</strong>
                    <small>{session?.user.email}</small>
                  </span>
                </div>
                <Button variant="ghost" size="small" onClick={() => void signOut()}>
                  <LogOut size={15} />
                  Sign out
                </Button>
              </footer>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

interface NotificationRow {
  id: string;
  ticketId: string | null;
  type: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}
