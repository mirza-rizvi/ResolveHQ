import type { webhookEndpoints } from "../db/schema";

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;

/**
 * The payload shape is a deliberate privacy decision, written down here because it is
 * easy to widen by accident: **ids, numbers, statuses and names — never message bodies,
 * never email addresses, never subjects of private notes.** A consumer that needs the
 * conversation reads it back through the API with a scoped key, where the workspace's
 * own permissions apply.
 */
export interface WebhookPayload {
  event: string;
  occurredAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

export interface FormattedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Only `generic` is signed; Slack and Telegram authenticate with a secret URL or a bot token. */
  sign: boolean;
}

function ticketLine(payload: WebhookPayload) {
  const data = payload.data as { number?: number; subject?: string; status?: string; priority?: string };
  const reference = data.number ? `#${data.number}` : "A ticket";
  switch (payload.event) {
    case "ticket.created":
      return `${reference} opened: ${data.subject ?? "(no subject)"}`;
    case "ticket.assigned":
      return `${reference} assigned to ${String((payload.data as { assignee?: string }).assignee ?? "nobody")}`;
    case "ticket.status_changed":
      return `${reference} is now ${data.status ?? "updated"}`;
    case "ticket.sla_breached":
      return `${reference} has missed its response target`;
    case "message.received":
      return `${reference} has a new customer reply`;
    case "csat.received":
      return `${reference} was rated ${String((payload.data as { rating?: number }).rating ?? "?")} out of 5`;
    default:
      return `${reference}: ${payload.event}`;
  }
}

/** Short enough to triage from the notification itself, with a link for the rest. */
function humanText(payload: WebhookPayload, appUrl: string | undefined) {
  const ticketId = (payload.data as { ticketId?: string }).ticketId;
  const link = appUrl && ticketId ? `\n${appUrl.replace(/\/+$/, "")}/inbox/${ticketId}` : "";
  return `${ticketLine(payload)}${link}`;
}

export function formatPayload(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  appUrl?: string,
): FormattedRequest | null {
  if (endpoint.kind === "slack")
    return {
      url: endpoint.url,
      body: JSON.stringify({ text: humanText(payload, appUrl) }),
      headers: { "content-type": "application/json" },
      sign: false,
    };

  if (endpoint.kind === "telegram") {
    const token = endpoint.config?.botToken;
    const chatId = endpoint.config?.chatId;
    // Without both, there is nothing to call; the delivery fails with a stated reason.
    if (!token || !chatId) return null;
    return {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      body: JSON.stringify({ chat_id: chatId, text: humanText(payload, appUrl), disable_web_page_preview: true }),
      headers: { "content-type": "application/json" },
      sign: false,
    };
  }

  return {
    url: endpoint.url,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    sign: true,
  };
}
