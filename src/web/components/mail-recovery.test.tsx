import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MailRecovery } from "./mail-recovery";
import { api } from "../lib/api";
vi.mock("../lib/api", () => ({ api: vi.fn(), errorMessage: (_error: unknown, fallback: string) => fallback }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const uncertain = {
  id: "job",
  kind: "outbound-mail",
  reason: "delivery_uncertain",
  generation: 2,
  updatedAt: 1,
  firstAttemptAt: null,
  requiresDuplicateAck: 1,
};
describe("stopped mail recovery", () => {
  it("requires acknowledgment even for legacy jobs with unknown attempt dates", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ jobs: [uncertain] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [] });
    render(<MailRecovery />);
    const retry = await screen.findByRole("button", { name: "Retry email" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(retry);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/mail-recovery/job/retry", {
        method: "POST",
        body: JSON.stringify({ kind: "outbound-mail", generation: 2, acknowledgeDuplicateRisk: true }),
      }),
    );
    expect(await screen.findByText("No stopped mail.")).toBeTruthy();
  });
  it("blocks complaint retries and exposes recoverable load errors", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ jobs: [{ ...uncertain, reason: "email.complained" }] })
      .mockRejectedValueOnce(new Error("offline"));
    render(<MailRecovery />);
    expect(((await screen.findByRole("button", { name: "Retry email" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh stopped mail" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
