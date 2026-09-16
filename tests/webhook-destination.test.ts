import { describe, expect, it } from "vitest";
import { checkDestination } from "resolve-server/webhooks/destination";
import type { AppBindings } from "resolve-server/types";

/** A deployed Worker: no local addresses are ever acceptable. */
const deployed = { APP_URL: "https://support.example.com", DEV_MAIL_MODE: "disabled" } as Pick<
  AppBindings,
  "APP_URL" | "DEV_MAIL_MODE"
>;

describe("webhook destination validation", () => {
  it("accepts a public https endpoint", () => {
    expect(checkDestination(deployed, "https://hooks.example.com/incoming").ok).toBe(true);
    expect(checkDestination(deployed, "https://hooks.slack.com/services/T0/B0/xyz").ok).toBe(true);
  });

  it("refuses anything that is not https on a deployment", () => {
    expect(checkDestination(deployed, "http://hooks.example.com/x").reason).toBe("scheme_not_allowed");
    expect(checkDestination(deployed, "ftp://hooks.example.com/x").reason).toBe("scheme_not_allowed");
    expect(checkDestination(deployed, "file:///etc/passwd").reason).toBe("scheme_not_allowed");
    expect(checkDestination(deployed, "not a url").reason).toBe("invalid_url");
  });

  it("refuses every private and loopback IPv4 range", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.254",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
    ])
      expect(checkDestination(deployed, `https://${host}/hook`).reason).toBe("host_not_public");
  });

  it("allows public IPv4 addresses that merely look similar", () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "192.167.1.1", "100.63.0.1"])
      expect(checkDestination(deployed, `https://${host}/hook`).ok).toBe(true);
  });

  it("refuses loopback, unique-local and link-local IPv6, including IPv4-mapped forms", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:127.0.0.1]"])
      expect(checkDestination(deployed, `https://${host}/hook`).reason).toBe("host_not_public");
    // A public address wrapped in the mapped form is still public.
    expect(checkDestination(deployed, "https://[::ffff:93.184.216.34]/hook").ok).toBe(true);
  });

  it("refuses internal-only hostnames and bare names with no dot", () => {
    for (const host of ["localhost", "buildserver.internal", "printer.local", "db.lan", "router.home.arpa"])
      expect(checkDestination(deployed, `https://${host}/hook`).reason).toBe("host_not_public");
    expect(checkDestination(deployed, "https://intranet/hook").reason).toBe("host_not_qualified");
  });

  it("refuses an address pointing back at this deployment", () => {
    expect(checkDestination(deployed, "https://support.example.com/api/v1/tickets").reason).toBe("self_reference");
    // Also when the deployment is only known from the incoming request.
    const request = new Request("https://helpdesk.example.org/api/organization/webhooks", {
      headers: { host: "helpdesk.example.org" },
    });
    expect(
      checkDestination({ DEV_MAIL_MODE: "disabled" } as Pick<AppBindings, "APP_URL" | "DEV_MAIL_MODE">, "https://helpdesk.example.org/hook", {
        request,
      }).reason,
    ).toBe("self_reference");
  });

  it("carries a plain-language message for every rejection", () => {
    for (const candidate of ["not a url", "http://x.example.com", "https://10.0.0.1", "https://intranet"]) {
      const result = checkDestination(deployed, candidate);
      expect(result.ok).toBe(false);
      expect(result.message?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("lets a local deployment point at the developer's own machine, and only then", () => {
    // Derived from APP_URL, so it cannot be switched on by a mail setting in production.
    const local = { APP_URL: "http://localhost:8787", DEV_MAIL_MODE: "disabled" } as Pick<
      AppBindings,
      "APP_URL" | "DEV_MAIL_MODE"
    >;
    expect(checkDestination(local, "http://localhost:4000/hook").ok).toBe(true);
    expect(checkDestination(local, "http://127.0.0.1:4000/hook").ok).toBe(true);
    // The same addresses on a deployment are refused.
    expect(checkDestination(deployed, "http://localhost:4000/hook").ok).toBe(false);
    // A mail setting must not be able to relax this.
    const productionCapturingMail = { APP_URL: "https://support.example.com", DEV_MAIL_MODE: "capture" } as Pick<
      AppBindings,
      "APP_URL" | "DEV_MAIL_MODE"
    >;
    expect(checkDestination(productionCapturingMail, "https://10.0.0.1/hook").ok).toBe(false);
  });

  it("refuses link-local metadata addresses even on a local deployment", () => {
    const local = { APP_URL: "http://localhost:8787", DEV_MAIL_MODE: "disabled" } as Pick<
      AppBindings,
      "APP_URL" | "DEV_MAIL_MODE"
    >;
    // 169.254.169.254 is the cloud metadata service; it is never a webhook target.
    expect(checkDestination(local, "http://169.254.169.254/latest/meta-data").reason).toBe("host_not_public");
    expect(checkDestination(local, "http://[fe80::1]/hook").reason).toBe("host_not_public");
  });
});
