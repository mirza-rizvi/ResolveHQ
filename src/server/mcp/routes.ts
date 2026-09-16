import { Hono } from "hono";
import { requireApiKey } from "../auth/api-key";
import { HttpError } from "../http/errors";
import type { HonoEnv } from "../types";
import { MCP_TOOLS } from "./tools";

/**
 * Hand-rolled JSON-RPC rather than @modelcontextprotocol/sdk: the Worker bundle has a
 * 3 MB compressed ceiling, and the protocol surface that matters here is four methods.
 */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export const mcpRoutes = new Hono<HonoEnv>();

/**
 * Authenticated by a WS5 key carrying `mcp:read` — the same middleware the versioned
 * API uses, including the live-role recheck. A second authentication path is a second
 * thing to get wrong.
 *
 * The workspace always comes from the key. No tool accepts an organization id.
 */
mcpRoutes.post("/", requireApiKey, async (context) => {
  const apiKey = context.get("apiKey");
  const tenant = context.get("tenant");
  if (!apiKey) throw new HttpError(401, "invalid_api_key", "The API key is missing, invalid, revoked, or expired.");

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = await context.req.json();
  } catch {
    // A parse failure is a JSON-RPC error envelope, not an HTTP 500.
    return context.json(failure(null, PARSE_ERROR, "The request body is not valid JSON."));
  }

  // Batches are part of JSON-RPC; a client that sends one gets one back.
  if (Array.isArray(payload)) {
    const responses = [];
    for (const entry of payload) {
      const response = await dispatch(entry, {
        env: context.env,
        organizationId: tenant.organizationId,
        inboxIds: apiKey.inboxIds,
      });
      if (response) responses.push(response);
    }
    return responses.length ? context.json(responses) : new Response(null, { status: 202 });
  }

  const response = await dispatch(payload, {
    env: context.env,
    organizationId: tenant.organizationId,
    inboxIds: apiKey.inboxIds,
  });
  // A notification expects no body.
  return response ? context.json(response) : new Response(null, { status: 202 });
});

async function dispatch(
  message: JsonRpcRequest,
  toolContext: Parameters<(typeof MCP_TOOLS)[number]["run"]>[0],
) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return failure(message?.id ?? null, INVALID_REQUEST, "Expected a JSON-RPC 2.0 request.");

  const id = message.id ?? null;
  // Notifications carry no id and must not be answered.
  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      const requested = String((message.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "");
      return result(id, {
        // Echo the client's version when it is one we speak, so an older client is not
        // forced to downgrade the whole conversation.
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "resolvehq", version: "1", title: "ResolveHQ" },
        instructions:
          "Read-only access to this ResolveHQ workspace. Tools can search and read tickets, customers, queues and knowledge-base articles. There is no way to reply, assign, or change a ticket from here.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : result(id, {});
    case "tools/list":
      return result(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      // A write tool's name is simply unknown. Nothing hints that one might exist later.
      if (!tool) return failure(id, METHOD_NOT_FOUND, `Unknown tool: ${name || "(none)"}`);
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const value = await tool.run(toolContext, args);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch {
        // A tool failure is reported to the model, not raised as a transport error.
        return result(id, {
          content: [{ type: "text", text: `The ${name} tool could not complete.` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      if (message.method.startsWith("notifications/")) return null;
      if (message.method === "resources/list" || message.method === "prompts/list")
        return failure(id, METHOD_NOT_FOUND, `This server exposes tools only: ${message.method} is not supported.`);
      return failure(id, METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
  }
}

export { INVALID_PARAMS, INTERNAL_ERROR };
