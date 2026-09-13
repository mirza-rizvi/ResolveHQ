import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "@/web/lib/api";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Turnstile."));
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

// Cached across the SPA session so every auth page shares one /auth/config request.
let cachedSiteKey: string | null | undefined;
let siteKeyPromise: Promise<string | null> | null = null;
function fetchSiteKey(): Promise<string | null> {
  if (cachedSiteKey !== undefined) return Promise.resolve(cachedSiteKey);
  if (!siteKeyPromise) {
    siteKeyPromise = api<{ turnstileSiteKey: string | null }>("/auth/config")
      .then((config) => (cachedSiteKey = config.turnstileSiteKey))
      .catch(() => (cachedSiteKey = null));
  }
  return siteKeyPromise;
}

export interface TurnstileHandle {
  reset: () => void;
}

/**
 * Optional Cloudflare Turnstile widget for auth forms. Renders a hidden input named
 * "turnstileToken" so it is picked up automatically by FormData. Completely inert (no
 * script load, no widget, no hidden input) when the server has no public site key configured.
 */
export const Turnstile = forwardRef<TurnstileHandle>(function Turnstile(_props, ref) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSiteKey().then((key) => {
      if (!cancelled) setSiteKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    void loadTurnstileScript().then(() => {
      if (cancelled || !window.turnstile || !containerRef.current) return;
      widgetId.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token) => {
          if (inputRef.current) inputRef.current.value = token;
        },
        "expired-callback": () => {
          if (inputRef.current) inputRef.current.value = "";
        },
      });
    });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
      if (inputRef.current) inputRef.current.value = "";
    },
  }));

  if (!siteKey) return null;

  return (
    <div className="turnstile-widget">
      <div ref={containerRef} />
      <input ref={inputRef} type="hidden" name="turnstileToken" />
    </div>
  );
});
