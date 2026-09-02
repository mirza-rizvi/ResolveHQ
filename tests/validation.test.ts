import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("validation envelope", () => {
  it("returns the standard error shape for invalid JSON bodies", async () => {
    const session = await signup("validation");
    const response = await request("/customers", { method: "POST", body: JSON.stringify({ name: "", email: "not-an-email" }) }, session);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
