import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface Toast { id: number; message: string; tone: "info" | "success" | "error" }

const ToastContext = createContext<{ push: (message: string, tone?: Toast["tone"]) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }].slice(-4));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-stack" role="status" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>)}</div></ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
