import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api } from "./lib/api";

export interface Session {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string };
  role: "owner" | "admin" | "agent";
  csrfToken: string;
  workspaces?: Array<{ id: string; name: string; slug: string; role: "owner" | "admin" | "agent" }>;
}

const AuthContext = createContext<{ session: Session | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try { setSession(await api<Session>("/auth/me")); }
    catch { setSession(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const logout = async () => { await api("/auth/logout", { method: "POST" }); setSession(null); };
  const value = useMemo(() => ({ session, loading, refresh, logout }), [session, loading]);
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
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}
