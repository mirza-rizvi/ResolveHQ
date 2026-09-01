export interface ApiErrorBody { error?: { code?: string; message?: string } }

function readCookie(name: string) {
  return document.cookie.split("; ").find((part) => part.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const csrf = readCookie("resolvehq_csrf");
  if (csrf && !["GET", "HEAD"].includes(init.method ?? "GET")) headers.set("x-csrf-token", decodeURIComponent(csrf));
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(body.error?.message ?? "The request could not be completed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
