import { describe, expect, it } from "vitest";
import { safeNext } from "@/web/lib/next";

describe("safeNext()", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/inbox")).toBe("/inbox");
    expect(safeNext("/inbox/tkt_1?tab=notes")).toBe("/inbox/tkt_1?tab=notes");
  });

  it("rejects off-site destinations", () => {
    expect(safeNext("//evil.example")).toBe("/inbox");
    expect(safeNext("/\\evil.example")).toBe("/inbox");
    expect(safeNext("http://evil.example")).toBe("/inbox");
    expect(safeNext("javascript:alert(1)")).toBe("/inbox");
    expect(safeNext(null)).toBe("/inbox");
    expect(safeNext("")).toBe("/inbox");
  });
});
