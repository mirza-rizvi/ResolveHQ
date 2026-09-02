import { env } from "cloudflare:test";
import app from "resolve-server/app";

export interface TestSession { cookie: string; csrf: string; userId: string; organizationId: string }

export async function signup(suffix: string): Promise<TestSession> {
  const response = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ name: `Owner ${suffix}`, email: `owner-${suffix}@example.test`, password: "a-secure-test-password", organizationName: `Workspace ${suffix}`, organizationSlug: `workspace-${suffix}` }),
  });
  if (response.status !== 201) throw new Error(`Signup failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { user: { id: string }; organization: { id: string }; csrfToken: string };
  const cookies = response.headers.get("set-cookie") ?? "";
  const found = [...cookies.matchAll(/(resolvehq_(?:session|csrf))=([^;,]+)/g)];
  const session: TestSession = { cookie: found.map((match) => `${match[1]}=${match[2]}`).join("; "), csrf: body.csrfToken, userId: body.user.id, organizationId: body.organization.id };
  const inboxResponse = await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: `support-${suffix}@example.test` }) }, session);
  if (inboxResponse.status !== 201) throw new Error(`Default inbox creation failed: ${inboxResponse.status} ${await inboxResponse.text()}`);
  return session;
}

export async function login(email: string, password: string): Promise<TestSession> {
  const response = await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (response.status !== 200) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { user: { id: string }; organization: { id: string }; csrfToken: string };
  const cookies = response.headers.get("set-cookie") ?? "";
  const found = [...cookies.matchAll(/(resolvehq_(?:session|csrf))=([^;,]+)/g)];
  return { cookie: found.map((match) => `${match[1]}=${match[2]}`).join("; "), csrf: body.csrfToken, userId: body.user.id, organizationId: body.organization.id };
}

export function request(path: string, init: RequestInit = {}, session?: TestSession) {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (session) { headers.set("cookie", session.cookie); headers.set("x-csrf-token", session.csrf); headers.set("origin", env.APP_URL); }
  return app.request(`http://localhost:8787/api${path}`, { ...init, headers }, env);
}
