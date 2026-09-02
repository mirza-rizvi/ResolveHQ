import { afterEach, describe, expect, it, vi } from "vitest";
import { ticketSearchParams } from "@/web/hooks/use-tickets";
import { resolveContentType } from "@/web/inbox/attachments";
import { formatBytes, relativeTime } from "@/web/inbox/format";
import { filtersForQueue, queueForFilters, queueLabel } from "@/web/inbox/queues";
import { chordPending, clearChord, startChord } from "@/web/lib/chord";

afterEach(() => { clearChord(); vi.useRealTimers(); });

describe("chord", () => {
  it("is not pending until a chord starts", () => {
    expect(chordPending()).toBe(false);
  });

  it("stays pending for a second after the chord key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00Z"));
    startChord();
    expect(chordPending()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(chordPending()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(chordPending()).toBe(false);
  });

  it("stops being pending once the chord is consumed", () => {
    startChord();
    clearChord();
    expect(chordPending()).toBe(false);
  });
});

describe("ticketSearchParams", () => {
  it("sends no status filter for the all queue", () => {
    expect(ticketSearchParams({ queue: "all", q: "" }).toString()).toBe("");
  });

  it("maps status queues onto the status filter", () => {
    expect(ticketSearchParams({ queue: "pending", q: "" }).get("status")).toBe("pending");
    expect(ticketSearchParams({ queue: "waiting_customer", q: "" }).get("status")).toBe("waiting_customer");
  });

  it("maps the assignment queues onto the assignee filter", () => {
    expect(ticketSearchParams({ queue: "unassigned", q: "" }).get("assignee")).toBe("unassigned");
    expect(ticketSearchParams({ queue: "mine", q: "" }).get("assignee")).toBe("me");
    expect(ticketSearchParams({ queue: "mine", q: "" }).get("status")).toBeNull();
  });

  it("carries the priority filter and a trimmed query", () => {
    const search = ticketSearchParams({ queue: "open", priority: "urgent", q: "  webhook  " });
    expect(search.get("priority")).toBe("urgent");
    expect(search.get("q")).toBe("webhook");
    expect(ticketSearchParams({ queue: "open", priority: "", q: "   " }).toString()).toBe("status=open");
  });
});

describe("queues", () => {
  it("round-trips a queue through saved view filters", () => {
    for (const queue of ["all", "open", "pending", "unassigned", "mine", "waiting_customer", "resolved", "closed"]) {
      expect(queueForFilters(filtersForQueue(queue))).toBe(queue);
    }
  });

  it("names queues for headings and generated views", () => {
    expect(queueLabel("waiting_customer")).toBe("Waiting");
    expect(queueLabel("all")).toBe("All");
  });
});

describe("resolveContentType", () => {
  it("keeps a reported type that the server allows", () => {
    expect(resolveContentType({ name: "notes.txt", type: "text/plain" })).toBe("text/plain");
  });

  it("falls back to the extension when the browser reports something else", () => {
    expect(resolveContentType({ name: "archive.zip", type: "application/x-zip-compressed" })).toBe("application/zip");
    expect(resolveContentType({ name: "rows.csv", type: "" })).toBe("text/csv");
    expect(resolveContentType({ name: "report.XLSX", type: "" })).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("rejects a file that is neither an allowed type nor an allowed extension", () => {
    expect(resolveContentType({ name: "payload.exe", type: "application/x-msdownload" })).toBeNull();
    expect(resolveContentType({ name: "noextension", type: "" })).toBeNull();
  });
});

describe("format", () => {
  it("reports recent times in minutes, hours and days", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(relativeTime("2026-09-02T11:58:00Z", now)).toBe("2m");
    expect(relativeTime("2026-09-02T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-08-30T12:00:00Z", now)).toBe("3d");
  });

  it("scales byte counts", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1_048_576)).toBe("3.0 MB");
  });
});
