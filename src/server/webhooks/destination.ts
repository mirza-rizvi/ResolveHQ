import { resolveAppUrl } from "../lib/app-url";
import type { AppBindings } from "../types";

/**
 * Validation for user-supplied webhook destinations.
 *
 * This is the most dangerous capability in the release: the Worker fetches an address a
 * customer typed. Everything here runs **twice** — once when the endpoint is saved, and
 * again immediately before every send, because DNS can change in between.
 */

export type DestinationRejection =
  | "invalid_url"
  | "scheme_not_allowed"
  | "host_not_public"
  | "host_not_qualified"
  | "self_reference";

export interface DestinationCheck {
  ok: boolean;
  reason?: DestinationRejection;
  message?: string;
}

const REJECTION_MESSAGES: Record<DestinationRejection, string> = {
  invalid_url: "That is not a valid URL.",
  scheme_not_allowed: "Use an https:// address.",
  host_not_public: "That address is on a private or internal network, which ResolveHQ will not send to.",
  host_not_qualified: "Use a full public hostname, for example hooks.example.com.",
  self_reference: "That address points back at this ResolveHQ deployment.",
};

/** Suffixes that never resolve publicly, whatever DNS says today. */
const PRIVATE_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".lan"];

function reject(reason: DestinationRejection): DestinationCheck {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

/** Parses dotted-quad IPv4, returning null for anything that is not one. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** RFC 1918 and friends: the ranges a request from the public internet can never reach. */
function isPrivateIpv4(octets: number[]) {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string) {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (address === "::1" || address === "::") return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true;
  // IPv4-mapped addresses smuggle a v4 target through a v6 literal. URL normalises the
  // dotted form to hextets, so ::ffff:127.0.0.1 arrives as ::ffff:7f00:1 and both
  // spellings have to be understood.
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) {
    const octets = ipv4(dotted[1]);
    return !octets || isPrivateIpv4(octets);
  }
  const hextets = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hextets) {
    const high = Number.parseInt(hextets[1], 16);
    const low = Number.parseInt(hextets[2], 16);
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return false;
}

/** Whether this deployment is itself local, which is the only case where a local destination makes sense. */
function deploymentIsLocal(env: Pick<AppBindings, "APP_URL">) {
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) return false;
  try {
    const host = new URL(appUrl).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]") return true;
    const octets = ipv4(host);
    return Boolean(octets && (octets[0] === 127 || isPrivateIpv4(octets)));
  } catch {
    return false;
  }
}

/**
 * Checks one destination.
 *
 * A local destination is permitted only when the deployment *itself* is local — derived
 * from APP_URL, not from a mail setting, so it cannot be switched on by accident in
 * production. Link-local addresses stay refused even then: a cloud metadata endpoint is
 * never a legitimate webhook target.
 */
export function checkDestination(
  env: Pick<AppBindings, "APP_URL" | "DEV_MAIL_MODE">,
  candidate: string,
  options: { request?: Request } = {},
): DestinationCheck {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return reject("invalid_url");
  }

  const allowLocal = deploymentIsLocal(env);
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) return reject("scheme_not_allowed");

  const host = url.hostname.toLowerCase();
  if (!host) return reject("invalid_url");

  const octets = ipv4(host);
  if (octets) {
    // 169.254.0.0/16 carries the cloud metadata service. Never a webhook target,
    // whatever the deployment is, so this one is not subject to allowLocal.
    if (octets[0] === 169 && octets[1] === 254) return reject("host_not_public");
    if (isPrivateIpv4(octets) && !allowLocal) return reject("host_not_public");
  } else if (host.includes(":") || host.startsWith("[")) {
    const address = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (/^fe[89ab][0-9a-f]:/.test(address)) return reject("host_not_public");
    if (isPrivateIpv6(host) && !allowLocal) return reject("host_not_public");
  } else {
    if (host === "localhost" && !allowLocal) return reject("host_not_public");
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)) && !allowLocal) return reject("host_not_public");
    // A bare hostname resolves through a local search domain, not public DNS.
    if (!host.includes(".") && !allowLocal) return reject("host_not_qualified");
  }

  // Delivering to ourselves would let an endpoint drive the product's own API.
  const selfHosts = new Set<string>();
  const appUrl = env.APP_URL?.trim();
  if (appUrl) {
    try {
      selfHosts.add(new URL(appUrl).host.toLowerCase());
    } catch {
      /* An unparseable APP_URL is reported by the readiness page, not here. */
    }
  }
  if (options.request) {
    try {
      selfHosts.add(new URL(resolveAppUrl(env as AppBindings, options.request)).host.toLowerCase());
      const forwarded = options.request.headers.get("host");
      if (forwarded) selfHosts.add(forwarded.toLowerCase());
    } catch {
      /* Fall back to APP_URL alone. */
    }
  }
  if (selfHosts.has(url.host.toLowerCase())) return reject("self_reference");

  return { ok: true };
}
