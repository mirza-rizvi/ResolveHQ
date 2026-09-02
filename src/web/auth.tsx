import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api } from "./lib/api";

export interface Session {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string };
  role: "owner" | "admin" | "agent";
  csrfToken: string;
  workspaces?: Array<{ id: string; name: string; slug: string; role: "owner" | "admin" | "agent" }>;
}

const AuthContext = createContext<{ session: Session | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; switchWorkspace: (organizationId: string) => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setSession(await api<Session>("/auth/me")); }
    catch { setSession(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const clear = () => setSession(null);
    window.addEventListener("resolvehq:unauthenticated", clear);
    return () => window.removeEventListener("resolvehq:unauthenticated", clear);
  }, []);
  const logout = useCallback(async () => { await api("/auth/logout", { method: "POST" }); setSession(null); }, []);
  const switchWorkspace = useCallback(async (organizationId: string) => { await api("/auth/switch-workspace", { method: "POST", body: JSON.stringify({ organizationId }) }); await refresh(); }, [refresh]);
  const value = useMemo(() => ({ session, loading, refresh, logout, switchWorkspace }), [session, loading, refresh, logout, switchWorkspace]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-loading" aria-live="polite">Opening your workspace…</div>;
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}
