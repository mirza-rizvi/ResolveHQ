import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  ChartNoAxesColumn,
  ChevronDown,
  CircleGauge,
  Command,
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
import { NavLink, Outlet, useNavigate } from "react-router-dom";
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
  return (
    <div className="app-shell">
      <header className="command-bar">
        <NavLink className="wordmark" to="/inbox">
          ResolveHQ
        </NavLink>
        <div className="workspace-menu">
          {workspaces.length > 1 ? (
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
          ) : (
            <span>{session?.organization.name}</span>
          )}
        </div>
        <nav className="command-navigation" aria-label="Primary navigation">
          {navigation.map(({ label, href }) => (
            <NavLink
              key={href}
              to={href}
              className={({ isActive }) => (isActive ? "command-link active" : "command-link")}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <button className="command-trigger" type="button" onClick={() => setCommandOpen(true)}>
          <Search size={15} />
          <span>Search or jump to</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="header-controls">
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <div className="notifications-menu" ref={notificationsRef}>
            <button
              className="notifications-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={notificationsOpen}
              aria-label={
                notifications.some((row) => !row.readAt)
                  ? `Notifications, ${notifications.filter((row) => !row.readAt).length} unread`
                  : "Notifications"
              }
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <Bell size={15} />
              {notifications.some((row) => !row.readAt) && <i aria-hidden="true" />}
            </button>
            {notificationsOpen && (
              <div className="notifications-popover" role="menu" aria-label="Notifications">
                <header>
                  <strong>Notifications</strong>
                  <button type="button" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)}>
                    <X size={13} />
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
                  <p className="notifications-empty">You are all caught up.</p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="account-menu" ref={accountRef}>
          <button
            className="account-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span>{session?.user.name.slice(0, 2).toUpperCase()}</span>
            <strong>{session?.user.name}</strong>
            <ChevronDown size={14} />
          </button>
          {accountOpen && (
            <div className="account-dropdown" role="menu" aria-label="Account">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  navigate("/settings");
                }}
              >
                <Settings size={15} />
                Settings
              </button>
              <button type="button" role="menuitem" onClick={() => void signOut()}>
                <LogOut size={15} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="workspace">
        <Outlet />
      </main>
      <nav className="mobile-navigation" aria-label="Mobile navigation">
        {navigation
          .filter((item) => "primary" in item && item.primary)
          .map(({ label, href, icon: Icon }) => (
            <NavLink key={href} to={href} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        <button type="button" onClick={() => setCommandOpen(true)}>
          <Command size={18} />
          <span>More</span>
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
