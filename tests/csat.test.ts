import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processOutboundMail } from "resolve-server/mail/queue";
import { collectCustomerExport, processCustomerErasure, requestCustomerErasure } from "resolve-server/privacy/service";
import { csatToken, verifyCsatToken } from "resolve-server/csat/token";
import type { AppBindings } from "resolve-server/types";
import { request, signup, type TestSession } from "./helpers";

/** The Worker needs a public address before it will append a rating link at all. */
function withAppUrl(overrides: Partial<AppBindings> = {}): AppBindings {
  return { ...(env as unknown as AppBindings), APP_URL: "https://support.example.test", ...overrides };
}

async function enableCsat(session: TestSession) {
  const response = await request(
    "/satisfaction",
    { method: "PUT", body: JSON.stringify({ enabled: true, prompt: "How did we do?" }) },
    session,
  );
  expect(response.status).toBe(200);
}

async function customerFor(session: TestSession, email: string) {
  const response = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: "Casey Customer", email }) },
    session,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { customer: { id: string } }).customer.id;
}

/** Opens a ticket, resolves it, replies, and delivers the reply. */
async function resolvedTicketWithReply(session: TestSession, suffix: string, mailEnv = withAppUrl()) {
  await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
    .bind(`help-${suffix}@example.test`, session.organizationId)
    .run();
  const customerId = await customerFor(session, `casey-${suffix}@example.test`);
  const created = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId, subject: "Broken export", message: "Looking into it." }) },
    session,
  );
  expect(created.status).toBe(201);
  const ticketId = ((await created.json()) as { ticket: { id: string } }).ticket.id;

  await request(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, session);
  const reply = await request(
    `/tickets/${ticketId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body: "All fixed — thanks for your patience.",
        bodyHtml: "<p>All fixed — thanks for your patience.</p>",
        kind: "message",
      }),
    },
    session,
  );
  expect(reply.status).toBe(201);

  const job = await env.DB.prepare(
    "SELECT id FROM outbound_mail_jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(session.organizationId)
    .first<{ id: string }>();
  await processOutboundMail(mailEnv, { jobId: job!.id });
  return { ticketId, customerId };
}

function lastCapture(organizationId: string) {
  return env.DB.prepare(
    "SELECT text, html FROM mail_captures WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(organizationId)
    .first<{ text: string | null; html: string | null }>();
}

function surveyRow(ticketId: string) {
  return env.DB.prepare(
    "SELECT rating, comment, sent_at AS sentAt, responded_at AS respondedAt, consumed_at AS consumedAt FROM csat_responses WHERE ticket_id = ?",
  )
    .bind(ticketId)
    .first<{
      rating: number | null;
      comment: string | null;
      sentAt: number;
      respondedAt: number | null;
      consumedAt: number | null;
    }>();
}

describe("CSAT token", () => {
  it("rejects a signature issued for a different rating", async () => {
    const token = await csatToken(env as AppBindings, "tkt_tamper", 1);
    const [ticketId, , signature] = token.split(".");
    const forged = `${ticketId}.5.${signature}`;
    expect(await verifyCsatToken(env as AppBindings, forged)).toBeNull();
    expect(await verifyCsatToken(env as AppBindings, token)).toEqual({ ticketId: "tkt_tamper", rating: 1 });
  });

  it("rejects forged, truncated and out-of-range tokens", async () => {
    const valid = await csatToken(env as AppBindings, "tkt_forge", 3);
    expect(await verifyCsatToken(env as AppBindings, `${valid.slice(0, -4)}aaaa`)).toBeNull();
    expect(await verifyCsatToken(env as AppBindings, "tkt_forge.3")).toBeNull();
    expect(await verifyCsatToken(env as AppBindings, "nonsense")).toBeNull();
    // 4 is not one of the three offered ratings.
    const [ticketId, , signature] = valid.split(".");
    expect(await verifyCsatToken(env as AppBindings, `${ticketId}.4.${signature}`)).toBeNull();
  });
});

describe("CSAT survey delivery", () => {
  it("appends three rating links to both the text and HTML parts of a resolving reply", async () => {
    const workspace = await signup("csat-send");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "send");

    const capture = await lastCapture(workspace.organizationId);
    expect(capture?.text).toContain("How did we do?");
    for (const rating of [1, 3, 5]) {
      const token = await csatToken(env as AppBindings, ticketId, rating as 1 | 3 | 5);
      expect(capture?.text).toContain(`https://support.example.test/rate/${token}`);
      expect(capture?.html).toContain(`https://support.example.test/rate/${token}`);
    }
    // No tracking pixel, no external images.
    expect(capture?.html).not.toContain("<img");
    expect(await surveyRow(ticketId)).not.toBeNull();
  });

  it("still records the survey when the reply is plain text only", async () => {
    const workspace = await signup("csat-textonly");
    await enableCsat(workspace);
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind("help-textonly@example.test", workspace.organizationId)
      .run();
    const customerId = await customerFor(workspace, "casey-textonly@example.test");
    const created = await request(
      "/tickets",
      { method: "POST", body: JSON.stringify({ customerId, subject: "Plain", message: "Looking into it." }) },
      workspace,
    );
    const ticketId = ((await created.json()) as { ticket: { id: string } }).ticket.id;
    await request(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, workspace);
    await request(
      `/tickets/${ticketId}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Done.", kind: "message" }) },
      workspace,
    );
    const job = await env.DB.prepare(
      "SELECT id FROM outbound_mail_jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(workspace.organizationId)
      .first<{ id: string }>();
    await processOutboundMail(withAppUrl(), { jobId: job!.id });

    const capture = await lastCapture(workspace.organizationId);
    expect(capture?.text).toContain("/rate/");
    // No HTML part exists, so none is invented purely to carry the survey.
    expect(capture?.html).toBeNull();
    expect(await surveyRow(ticketId)).not.toBeNull();
  });

  it("appends nothing and creates no row when APP_URL is unset", async () => {
    const workspace = await signup("csat-noappurl");
    await enableCsat(workspace);
    const bare = { ...(env as unknown as AppBindings) };
    delete (bare as { APP_URL?: string }).APP_URL;
    const { ticketId } = await resolvedTicketWithReply(workspace, "noappurl", bare);

    const capture = await lastCapture(workspace.organizationId);
    expect(capture?.text).not.toContain("/rate/");
    expect(await surveyRow(ticketId)).toBeNull();
  });

  it("appends nothing while satisfaction ratings are switched off", async () => {
    const workspace = await signup("csat-off");
    const { ticketId } = await resolvedTicketWithReply(workspace, "off");
    expect(await surveyRow(ticketId)).toBeNull();
  });

  it("does not send a second survey when the same ticket is resolved again", async () => {
    const workspace = await signup("csat-once");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "once");
    const first = await surveyRow(ticketId);
    expect(first).not.toBeNull();

    await request(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }, workspace);
    await request(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, workspace);
    await request(
      `/tickets/${ticketId}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Resolved again.", kind: "message" }) },
      workspace,
    );
    const job = await env.DB.prepare(
      "SELECT id FROM outbound_mail_jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(workspace.organizationId)
      .first<{ id: string }>();
    await processOutboundMail(withAppUrl(), { jobId: job!.id });

    const rows = await env.DB.prepare("SELECT count(*) AS n FROM csat_responses WHERE ticket_id = ?")
      .bind(ticketId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const capture = await lastCapture(workspace.organizationId);
    expect(capture?.text).not.toContain("/rate/");
  });
});

describe("CSAT rating endpoint", () => {
  it("records a rating from the link, and is idempotent for a repeated click", async () => {
    const workspace = await signup("csat-record");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "record");
    const token = await csatToken(env as AppBindings, ticketId, 5);

    const first = await request(`/csat/${token}`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "recorded", rating: 5 });

    const again = await request(`/csat/${token}`, { method: "POST" });
    const body = (await again.json()) as { status: string; rating: number };
    expect(body.status).toBe("already_rated");
    expect(body.rating).toBe(5);

    const row = await surveyRow(ticketId);
    expect(row?.rating).toBe(5);
    expect(row?.consumedAt).not.toBeNull();
  });

  it("lets the first rating win and confirms the score that was actually recorded", async () => {
    const workspace = await signup("csat-firstwins");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "firstwins");

    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 1)}`, { method: "POST" });
    const second = await request(`/csat/${await csatToken(env as AppBindings, ticketId, 5)}`, { method: "POST" });
    const body = (await second.json()) as { status: string; rating: number };
    expect(body.status).toBe("already_rated");
    // Confirms the recorded score rather than silently accepting the new one.
    expect(body.rating).toBe(1);
    expect((await surveyRow(ticketId))?.rating).toBe(1);
  });

  it("answers neutrally for a forged signature, an unknown ticket and a deleted ticket", async () => {
    const workspace = await signup("csat-neutral");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "neutral");
    const valid = await csatToken(env as AppBindings, ticketId, 3);

    const forged = await request(`/csat/${valid.slice(0, -4)}zzzz`, { method: "POST" });
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual({ status: "unavailable" });

    const unknown = await request(`/csat/${await csatToken(env as AppBindings, "tkt_missing", 3)}`, {
      method: "POST",
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ status: "unavailable" });

    await env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(ticketId).run();
    const deleted = await request(`/csat/${valid}`, { method: "POST" });
    // Never a 500 to a customer who clicked a link in an email.
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: "unavailable" });
  });

  it("attaches a comment only for a token whose rating was recorded", async () => {
    const workspace = await signup("csat-comment");
    await enableCsat(workspace);
    const { ticketId } = await resolvedTicketWithReply(workspace, "comment");
    const good = await csatToken(env as AppBindings, ticketId, 5);
    const bad = await csatToken(env as AppBindings, ticketId, 1);

    // No rating yet, so there is nothing to attach a comment to.
    const early = await request(`/csat/${good}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment: "Too soon" }),
    });
    expect(await early.json()).toEqual({ status: "unavailable" });

    await request(`/csat/${good}`, { method: "POST" });
    const attached = await request(`/csat/${good}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment: "Fast and clear, thank you." }),
    });
    expect(await attached.json()).toEqual({ status: "recorded" });
    expect((await surveyRow(ticketId))?.comment).toBe("Fast and clear, thank you.");

    // A token signed for a different rating cannot overwrite the comment.
    const wrongRating = await request(`/csat/${bad}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment: "Not me" }),
    });
    expect(await wrongRating.json()).toEqual({ status: "unavailable" });
    expect((await surveyRow(ticketId))?.comment).toBe("Fast and clear, thank you.");
  });
});

describe("CSAT privacy and reporting", () => {
  it("includes the rating in the customer export", async () => {
    const workspace = await signup("csat-export");
    await enableCsat(workspace);
    const { ticketId, customerId } = await resolvedTicketWithReply(workspace, "export");
    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 5)}`, { method: "POST" });
    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 5)}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment: "Great support." }),
    });

    const payload = await collectCustomerExport(env.DB, workspace.organizationId, customerId);
    const ticket = payload?.tickets.find((entry) => entry.id === ticketId);
    expect(ticket?.satisfactionRating?.rating).toBe(5);
    expect(ticket?.satisfactionRating?.comment).toBe("Great support.");
  });

  it("removes CSAT rows when the customer is erased", async () => {
    const workspace = await signup("csat-erasure");
    await enableCsat(workspace);
    const { ticketId, customerId } = await resolvedTicketWithReply(workspace, "erasure");
    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 3)}`, { method: "POST" });
    expect(await surveyRow(ticketId)).not.toBeNull();

    await requestCustomerErasure(env as AppBindings, workspace.organizationId, customerId);
    for (let pass = 0; pass < 5; pass += 1)
      await processCustomerErasure(env as AppBindings, workspace.organizationId, customerId);

    const remaining = await env.DB.prepare(
      "SELECT count(*) AS n FROM csat_responses WHERE organization_id = ?",
    )
      .bind(workspace.organizationId)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("reports the average with its sample size, and never one without the other", async () => {
    const workspace = await signup("csat-reports");
    await enableCsat(workspace);
    const before = (await (await request("/reports/summary", {}, workspace)).json()) as {
      satisfaction: { responses: number; averageRating: number | null; surveysSent: number };
    };
    expect(before.satisfaction.responses).toBe(0);
    expect(before.satisfaction.averageRating).toBeNull();

    const { ticketId } = await resolvedTicketWithReply(workspace, "reports");
    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 5)}`, { method: "POST" });

    const after = (await (await request("/reports/summary", {}, workspace)).json()) as {
      satisfaction: { responses: number; averageRating: number | null; surveysSent: number };
    };
    expect(after.satisfaction.surveysSent).toBe(1);
    expect(after.satisfaction.responses).toBe(1);
    expect(after.satisfaction.averageRating).toBe(5);
  });

  it("keeps satisfaction settings and answers scoped to one organization", async () => {
    const alpha = await signup("csat-tenant-alpha");
    const beta = await signup("csat-tenant-beta");
    await enableCsat(alpha);
    const { ticketId } = await resolvedTicketWithReply(alpha, "tenant-alpha");

    const betaView = (await (await request("/satisfaction", {}, beta)).json()) as {
      enabled: boolean;
      recent: unknown[];
    };
    expect(betaView.enabled).toBe(false);
    expect(betaView.recent).toHaveLength(0);

    await request(`/csat/${await csatToken(env as AppBindings, ticketId, 5)}`, { method: "POST" });
    const betaReports = (await (await request("/reports/summary", {}, beta)).json()) as {
      satisfaction: { responses: number };
    };
    expect(betaReports.satisfaction.responses).toBe(0);
  });

  it("refuses satisfaction configuration changes from a non-admin", async () => {
    const workspace = await signup("csat-role");
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    const response = await request(
      "/satisfaction",
      { method: "PUT", body: JSON.stringify({ enabled: true, prompt: "How did we do?" }) },
      workspace,
    );
    expect(response.status).toBe(403);
  });
});
