import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/web/lib/api";

describe("api()", () => {
  it("throws ApiError with code and dispatches unauthenticated on 401", async () => {
    const listener = vi.fn();
    window.addEventListener("resolvehq:unauthenticated", listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Sign in to continue." } }), {
            status: 401,
          }),
      ),
    );
    await expect(api("/tickets")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new ApiError(409, "ticket_version_conflict", "x")).toBeInstanceOf(Error);
  });

  it("does not dispatch unauthenticated for silent auth probes", async () => {
    const listener = vi.fn();
    window.addEventListener("resolvehq:unauthenticated", listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Sign in to continue." } }), {
            status: 401,
          }),
      ),
    );
    await expect(api("/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not dispatch unauthenticated for a 401 that is not an expired session", async () => {
    const listener = vi.fn();
    window.addEventListener("resolvehq:unauthenticated", listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "invalid_credentials", message: "Your current password is incorrect." } }),
            { status: 401 },
          ),
      ),
    );
    await expect(api("/auth/change-password", { method: "POST" })).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to a generic code and message when the body is not the error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 502 })),
    );
    await expect(api("/tickets")).rejects.toMatchObject({
      status: 502,
      code: "request_failed",
      message: "The request could not be completed.",
    });
  });

  it("returns undefined for 204 responses and parses JSON otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await api("/tickets/x")).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    expect(await api("/tickets")).toEqual({ ok: true });
  });
});
