import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../db";
import { inboxes, organizations, settings } from "../db/schema";
import type { AppBindings } from "../types";

export type ReadinessStatus = "ready" | "degraded" | "failed" | "unknown";

export interface ReadinessCheck {
  /** Stable identifier, e.g. `dns.mx.acme.com`. */
  id: string;
  group: "configuration" | "inbound" | "outbound";
  label: string;
  status: ReadinessStatus;
  /** Plain English, and it contains the fix. Written for someone who has never configured DNS. */
  detail: string;
  /** Advisory rows inform but never block the setup banner. */
  advisory: boolean;
  /** Deep link or documentation anchor for the fix. */
  fixHref?: string;
  /** What the resolver actually returned. Always show your work, so the owner can judge a wrong verdict. */
  observed?: string;
}

export interface ReadinessReport {
  checkedAt: number;
  checks: ReadinessCheck[];
}

export const READINESS_CACHE_KEY = "readiness.cache";
/** Ten minutes. DNS changes take minutes to propagate, so a fresh check per page load buys nothing. */
export const READINESS_CACHE_TTL_MS = 10 * 60 * 1000;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;

/** Cloudflare Email Routing publishes these; an answer ending in `.mx.cloudflare.net` is the signal. */
const CLOUDFLARE_MX_SUFFIX = ".mx.cloudflare.net";
const CLOUDFLARE_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";

interface DnsAnswer {
  name: string;
  type: number;
  data: string;
}

type DnsOutcome =
  | { ok: true; answers: string[] }
  | { ok: false; reason: "nxdomain" }
  | { ok: false; reason: "unreachable" };

/**
 * Resolves one record over DNS-over-HTTPS.
 *
 * Deliberately not the Cloudflare API: that would require every self-hoster to mint a
 * scoped API token before the checklist works at all. DoH needs nothing.
 *
 * Never throws — a resolver problem is reported as `unreachable` so the caller can say
 * "unknown" rather than accusing the owner of a missing record.
 */
async function resolve(name: string, type: "MX" | "TXT", fetchImpl: typeof fetch): Promise<DnsOutcome> {
  try {
    const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "unreachable" };
    const body = (await response.json()) as { Status?: number; Answer?: DnsAnswer[] };
    if (body.Status === 3) return { ok: false, reason: "nxdomain" };
    if (body.Status !== 0) return { ok: false, reason: "unreachable" };
    const answers = (body.Answer ?? [])
      .filter((answer) => answer.type === (type === "MX" ? 15 : 16))
      .map((answer) => unquote(answer.data.trim()));
    return { ok: true, answers };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** DoH returns TXT data quoted, and long records arrive as several concatenated quoted strings. */
function unquote(value: string) {
  if (!value.includes('"')) return value;
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]).join("");
}

function domainOf(address: string) {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function unreachable(id: string, group: ReadinessCheck["group"], label: string): ReadinessCheck {
  return {
    id,
    group,
    label,
    status: "unknown",
    advisory: false,
    detail: "Could not reach the DNS resolver. This does not mean your record is missing — try Re-check in a moment.",
  };
}

async function checkMx(domain: string, fetchImpl: typeof fetch): Promise<ReadinessCheck> {
  const id = `dns.mx.${domain}`;
  const label = `Email Routing (MX) for ${domain}`;
  const outcome = await resolve(domain, "MX", fetchImpl);
  if (!outcome.ok && outcome.reason === "unreachable") return unreachable(id, "inbound", label);
  const answers = outcome.ok ? outcome.answers : [];
  const hosts = answers.map((answer) => answer.replace(/^\d+\s+/, "").replace(/\.$/, "").toLowerCase());
  const observed = hosts.length ? `Found: ${hosts.join(", ")}` : "Found: no MX records";
  if (!hosts.length)
    return {
      id,
      group: "inbound",
      label,
      status: "failed",
      advisory: false,
      observed,
      detail: `${domain} has no MX records, so mail sent to it is never delivered anywhere. In Cloudflare, enable Email Routing for ${domain} and let it add the MX records for you.`,
    };
  if (hosts.some((host) => host.endsWith(CLOUDFLARE_MX_SUFFIX)))
    return {
      id,
      group: "inbound",
      label,
      status: "ready",
      advisory: false,
      observed,
      detail: `Mail to ${domain} reaches Cloudflare Email Routing. Check that a routing rule forwards it to this Worker.`,
    };
  return {
    id,
    group: "inbound",
    label,
    status: "degraded",
    advisory: false,
    observed,
    detail: `${domain} has MX records, but none of them point at Cloudflare Email Routing, so inbound mail goes to another provider instead of ResolveHQ. This is expected if you route mail somewhere else on purpose.`,
  };
}

async function checkSpf(domain: string, provider: MailProvider, fetchImpl: typeof fetch): Promise<ReadinessCheck> {
  const id = `dns.spf.${domain}`;
  const label = `SPF for ${domain}`;
  const outcome = await resolve(domain, "TXT", fetchImpl);
  if (!outcome.ok && outcome.reason === "unreachable") return unreachable(id, "outbound", label);
  const records = (outcome.ok ? outcome.answers : []).filter((answer) => answer.toLowerCase().startsWith("v=spf1"));
  if (!records.length)
    return {
      id,
      group: "outbound",
      label,
      status: "failed",
      advisory: false,
      observed: "Found: no SPF record",
      detail: `${domain} publishes no SPF record, so receiving servers have nothing authorising your mail and are likely to treat it as spam. Add a TXT record at the root of ${domain} with the value your mail provider gives you — for Cloudflare Email Routing that is "v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all".`,
    };
  const observed = `Found: ${records.join(" | ")}`;
  if (records.length > 1)
    return {
      id,
      group: "outbound",
      label,
      status: "degraded",
      advisory: false,
      observed,
      detail: `${domain} publishes more than one SPF record. That breaks SPF entirely — the standard allows exactly one — and receiving servers will fail the check. Merge them into a single TXT record containing every include you need.`,
    };
  const record = records[0];
  const expected = provider === "cloudflare" ? CLOUDFLARE_SPF_INCLUDE : "include:amazonses.com";
  if (record.toLowerCase().includes(expected))
    return { id, group: "outbound", label, status: "ready", advisory: false, observed, detail: `${domain} authorises your mail provider to send on its behalf.` };
  return {
    id,
    group: "outbound",
    label,
    status: "degraded",
    advisory: false,
    observed,
    detail: `${domain} has an SPF record, but it does not mention ${expected}, which is what your configured mail provider sends through. Add that include to the existing record — do not add a second SPF record. If you verified your domain with different values, this check can be ignored.`,
  };
}

async function checkDkim(domain: string, provider: MailProvider, fetchImpl: typeof fetch): Promise<ReadinessCheck> {
  const id = `dns.dkim.${domain}`;
  const label = `DKIM for ${domain}`;
  // Cloudflare Email Sending publishes its DKIM on the `cf-bounce` subdomain, not the root.
  const selector = provider === "cloudflare" ? `cf-bounce._domainkey.${domain}` : `resend._domainkey.${domain}`;
  const outcome = await resolve(selector, "TXT", fetchImpl);
  if (!outcome.ok && outcome.reason === "unreachable") return unreachable(id, "outbound", label);
  const records = (outcome.ok ? outcome.answers : []).filter((answer) => answer.toLowerCase().includes("v=dkim1"));
  if (records.length)
    return {
      id,
      group: "outbound",
      label,
      status: "ready",
      advisory: false,
      observed: `Found a DKIM key at ${selector}`,
      detail: `${domain} publishes a DKIM key, so receiving servers can verify your mail was not tampered with.`,
    };
  return {
    id,
    group: "outbound",
    label,
    status: "degraded",
    advisory: false,
    observed: `Found: nothing at ${selector}`,
    detail: `ResolveHQ looked for your provider's DKIM record at ${selector} and found nothing. Your provider shows the exact record to add when you verify the domain. If you verified with a different selector, this check can be ignored — it cannot see records it does not know the name of.`,
  };
}

async function checkDmarc(domain: string, fetchImpl: typeof fetch): Promise<ReadinessCheck> {
  const id = `dns.dmarc.${domain}`;
  const label = `DMARC for ${domain}`;
  const outcome = await resolve(`_dmarc.${domain}`, "TXT", fetchImpl);
  if (!outcome.ok && outcome.reason === "unreachable")
    return { ...unreachable(id, "outbound", label), advisory: true };
  const records = (outcome.ok ? outcome.answers : []).filter((answer) => answer.toLowerCase().startsWith("v=dmarc1"));
  if (records.length)
    return {
      id,
      group: "outbound",
      label,
      status: "ready",
      advisory: true,
      observed: `Found: ${records.join(" | ")}`,
      detail: `${domain} tells receiving servers what to do with mail that fails SPF or DKIM.`,
    };
  return {
    id,
    group: "outbound",
    label,
    status: "degraded",
    advisory: true,
    observed: "Found: no DMARC record",
    detail: `${domain} publishes no DMARC policy. Mail still delivers without one, but adding a TXT record at _dmarc.${domain} with the value "v=DMARC1; p=none;" tells you who is sending as your domain. Recommended, not required.`,
  };
}

type MailProvider = "cloudflare" | "resend" | "capture" | "none";

function mailProviderOf(env: AppBindings): MailProvider {
  if (env.EMAIL) return "cloudflare";
  if (env.RESEND_API_KEY) return "resend";
  if (env.DEV_MAIL_MODE === "capture") return "capture";
  return "none";
}

function configurationChecks(env: AppBindings, provider: MailProvider, inboxCount: number): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  const pepper = env.SESSION_PEPPER ?? "";
  checks.push({
    id: "config.session_pepper",
    group: "configuration",
    label: "Session secret",
    advisory: false,
    status: pepper.length >= 32 ? "ready" : "failed",
    detail:
      pepper.length >= 32
        ? "SESSION_PEPPER is set and long enough to derive session keys."
        : "SESSION_PEPPER is missing or shorter than 32 characters, and sign-in fails closed without it. Set it as a Worker secret: wrangler secret put SESSION_PEPPER. Changing it later signs everyone out.",
    observed: pepper ? `Found: a secret of ${pepper.length} characters` : "Found: no value",
  });

  checks.push({
    id: "config.mail_provider",
    group: "configuration",
    label: "Outgoing mail provider",
    advisory: false,
    status: provider === "none" ? "failed" : provider === "capture" ? "degraded" : "ready",
    observed: `Found: ${
      provider === "cloudflare"
        ? "the Cloudflare EMAIL binding"
        : provider === "resend"
          ? "RESEND_API_KEY"
          : provider === "capture"
            ? "no provider, DEV_MAIL_MODE=capture"
            : "no provider"
    }`,
    detail:
      provider === "none"
        ? "No way to send mail is configured, so replies never leave ResolveHQ. Set RESEND_API_KEY as a Worker secret, or uncomment the send_email binding in wrangler.jsonc to use Cloudflare Email Sending."
        : provider === "capture"
          ? "Replies are being captured for local development instead of delivered. This is correct on a development machine and wrong in production — set RESEND_API_KEY or the Cloudflare EMAIL binding before routing real customers here."
          : "Replies have a way out of ResolveHQ.",
  });

  const appUrl = env.APP_URL?.trim() ?? "";
  let appUrlStatus: ReadinessStatus = "degraded";
  let appUrlDetail =
    "APP_URL is not set, so links in outgoing mail are built from whatever origin the request arrived on. That is fine behind a single hostname and wrong behind a proxy or a custom domain. Set APP_URL to the address your agents actually use.";
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        appUrlStatus = "ready";
        appUrlDetail = "Links in outgoing mail are built from APP_URL.";
      } else {
        appUrlStatus = "failed";
        appUrlDetail = `APP_URL is set to "${appUrl}", which is not an http or https address, so links in outgoing mail will be broken. Set it to the full address of your deployment, for example https://support.example.com.`;
      }
    } catch {
      appUrlStatus = "failed";
      appUrlDetail = `APP_URL is set to "${appUrl}", which is not a valid URL, so links in outgoing mail will be broken. Set it to the full address of your deployment, for example https://support.example.com.`;
    }
  }
  checks.push({
    id: "config.app_url",
    group: "configuration",
    label: "Public address",
    advisory: false,
    status: appUrlStatus,
    detail: appUrlDetail,
    observed: appUrl ? `Found: ${appUrl}` : "Found: no value",
  });

  const siteKey = Boolean(env.TURNSTILE_SITE_KEY);
  const secretKey = Boolean(env.TURNSTILE_SECRET_KEY);
  checks.push({
    id: "config.turnstile",
    group: "configuration",
    label: "Turnstile",
    advisory: siteKey === secretKey,
    status: siteKey === secretKey ? "ready" : "failed",
    observed: `Found: ${siteKey ? "TURNSTILE_SITE_KEY" : "no site key"}, ${secretKey ? "TURNSTILE_SECRET_KEY" : "no secret key"}`,
    detail:
      siteKey === secretKey
        ? siteKey
          ? "Turnstile protects sign-up, sign-in, and password reset."
          : "Turnstile is off. Both keys must be set to turn it on; neither is."
        : `Turnstile is half-configured: ${siteKey ? "the site key is set but the secret key is missing" : "the secret key is set but the site key is missing"}. Sign-in forms will not work correctly until you set both, or remove both.`,
  });

  checks.push({
    id: "config.inbox",
    group: "configuration",
    label: "Support inbox",
    advisory: false,
    status: inboxCount > 0 ? "ready" : "failed",
    observed: `Found: ${inboxCount} active ${inboxCount === 1 ? "inbox" : "inboxes"}`,
    detail:
      inboxCount > 0
        ? "At least one support address is configured for this workspace."
        : "This workspace has no support inbox, so there is no address for customers to write to and no address to reply from. Add one under Settings → Support inboxes.",
  });

  const aiConfigured = Boolean(env.AI || env.OPENAI_API_KEY);
  checks.push({
    id: "config.ai",
    group: "configuration",
    label: "AI provider",
    advisory: true,
    status: aiConfigured ? "ready" : "degraded",
    observed: `Found: ${env.AI ? "the Workers AI binding" : env.OPENAI_API_KEY ? "OPENAI_API_KEY" : "no provider"}`,
    detail: aiConfigured
      ? "AI drafting, summaries, and translation can be switched on per workspace."
      : "No AI provider is configured. Everything else works; the AI features simply stay unavailable. Optional.",
  });

  return checks;
}

/**
 * Evaluates every readiness check for one workspace. Never throws: this page's job
 * is to inventory what is being checked, so a partial answer beats an error.
 *
 * Nothing in the product may gate an action on this result. It informs; a false red
 * that prevented work would be worse than no checklist at all.
 */
export async function evaluateReadiness(
  env: AppBindings,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadinessReport> {
  const db = createDb(env.DB);
  const provider = mailProviderOf(env);

  const activeInboxes = await db
    .select({ emailAddress: inboxes.emailAddress })
    .from(inboxes)
    .where(and(eq(inboxes.organizationId, organizationId), isNull(inboxes.disabledAt)));
  const [organization] = await db
    .select({ supportEmail: organizations.supportEmail })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  // Several inboxes commonly share one domain; query each domain once.
  const domains = [...new Set(
    [...activeInboxes.map((inbox) => inbox.emailAddress), organization?.supportEmail ?? ""]
      .map(domainOf)
      .filter(Boolean),
  )].sort();

  const checks = configurationChecks(env, provider, activeInboxes.length);
  for (const domain of domains) {
    const [mx, spf, dkim, dmarc] = await Promise.all([
      checkMx(domain, fetchImpl),
      checkSpf(domain, provider, fetchImpl),
      checkDkim(domain, provider, fetchImpl),
      checkDmarc(domain, fetchImpl),
    ]);
    checks.push(mx, spf, dkim, dmarc);
  }

  return { checkedAt: Date.now(), checks };
}

/**
 * Reads this organization's cached report.
 *
 * The cache is a per-organization settings row on purpose. A domain-keyed global cache
 * would leak one workspace's configuration state into another's UI whenever two
 * workspaces share a sending domain.
 */
export async function readReadinessCache(env: AppBindings, organizationId: string): Promise<ReadinessReport | null> {
  const [row] = await createDb(env.DB)
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, READINESS_CACHE_KEY)))
    .limit(1);
  const cached = row?.value as ReadinessReport | undefined;
  if (!cached || typeof cached.checkedAt !== "number" || !Array.isArray(cached.checks)) return null;
  if (Date.now() - cached.checkedAt > READINESS_CACHE_TTL_MS) return null;
  return cached;
}

export async function writeReadinessCache(env: AppBindings, organizationId: string, report: ReadinessReport) {
  await createDb(env.DB)
    .insert(settings)
    .values({ organizationId, key: READINESS_CACHE_KEY, value: report, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [settings.organizationId, settings.key],
      set: { value: report, updatedAt: new Date() },
    });
}

/** A workspace is set up when no required (non-advisory) check has failed. */
export function readinessBlocking(report: ReadinessReport): ReadinessCheck[] {
  return report.checks.filter((check) => !check.advisory && check.status === "failed");
}
