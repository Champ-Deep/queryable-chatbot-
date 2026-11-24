// MCP server (Streamable HTTP, stateless, JSON responses) that wraps the Champions REST API.
// Port of the MCP half of champions/app.py: it holds the internal API key and knows the
// endpoints; an MCP client only presents its own OAuth token and calls tools by name.
import { AuthError, requireScope } from "./auth.js";
import { unknownCard } from "./api.js";
import { BY_ID } from "./catalog.js";
import { TOOLS } from "./mcp_tools.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Champions Group data catalog: data cards, VAF field definitions, personalised aggregate " +
  "insights and query statistics. All tools are read-only. Pass role and goals to get_insights for insights " +
  "ranked for that person.";
const SEGMENT = ["industries", "regions", "countries", "size_bands", "intent_topics"];

class ToolError extends Error {}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (value) => ({ type: "text", text: JSON.stringify(value, null, 2) });

function strList(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ToolError(`${key} must be a list of strings`);
  return v;
}

function str(args, key, required = false) {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`${key}: Field required`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`${key}: Input should be a valid string`);
  return v;
}

function capabilityBody(skill, args, shared) {
  const body = {
    skill, need: str(args, "need", skill === "find_data_cards"),
    filters: Object.fromEntries(SEGMENT.map((k) => [k, strList(args, k)])),
  };
  if (shared && Object.keys(shared).length) {
    body.context = { consent_id: "mcp-caller-declared", purpose: "market_insights", shared };
  }
  return body;
}

/**
 * @param api    REST API handler ({fetch}) called in-process with the internal key
 * @param apiKey the internal key
 * @param audit  (claims, event, fields) => void
 */
export function createMcp({ api, apiKey, audit, publicUrl }) {
  async function call(claims, method, path, body) {
    const request = new Request(`${publicUrl}/api/v1${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey, "X-Champions-Channel": "mcp", "X-On-Behalf-Of": claims.sub ?? "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const response = await api(request);
    const data = await response.json().catch(() => null);
    if (response.status !== 200) {
      const detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail ?? data);
      throw new ToolError(`Champions API ${response.status}: ${detail}`);
    }
    return data;
  }

  const tools = {
    async list_data_cards(claims) {
      audit(claims, "mcp.list_data_cards", {});
      const cards = await call(claims, "GET", "/cards");
      return { content: cards.map(text), structuredContent: { result: cards }, isError: false };
    },
    async get_vaf_fields(claims, args) {
      const cardId = str(args, "card_id", true);
      if (!Object.hasOwn(BY_ID, cardId)) throw new ToolError(unknownCard(cardId));
      const result = await call(claims, "GET", `/cards/${encodeURIComponent(cardId)}/fields`);
      audit(claims, "mcp.get_vaf_fields", { card_id: cardId });
      return result;
    },
    async find_data_cards(claims, args) {
      const result = await call(claims, "POST", "/search", capabilityBody("find_data_cards", args));
      audit(claims, "mcp.find_data_cards", { query_id: result.query_id });
      return result;
    },
    async get_insights(claims, args) {
      try {
        requireScope(claims, "insights:read");
      } catch (err) {
        if (err instanceof AuthError) throw new ToolError(err.message);
        throw err;
      }
      const shared = {};
      const role = str(args, "role"), industry = str(args, "industry"), goals = strList(args, "goals");
      if (role) shared.role = role;
      if (goals.length) shared.goals = goals;
      if (industry) shared.industry = industry;
      const result = await call(claims, "POST", "/insights", capabilityBody("get_insights", args, shared));
      audit(claims, "mcp.get_insights", { matching_companies: result.matching_companies, query_id: result.query_id });
      return result;
    },
    async get_query_stats(claims) {
      audit(claims, "mcp.get_query_stats", {});
      // Partners only ever see their own queries; the API scopes it to X-On-Behalf-Of.
      return call(claims, "GET", "/query-stats");
    },
  };

  async function toolsCall(id, params, claims) {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (!Object.hasOwn(tools, name)) {
      return rpcResult(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    }
    try {
      const out = await tools[name](claims, args);
      return rpcResult(id, out.content && "isError" in out ? out : { content: [text(out)], isError: false });
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      return rpcResult(id, { content: [{ type: "text", text: `Error executing tool ${name}: ${err.message}` }], isError: true });
    }
  }

  /** One JSON-RPC message -> response object, or null for a notification. */
  return async function handle(body, claims) {
    if (body === null || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(body?.id, -32600, "Invalid Request");
    }
    const { id, method, params } = body;
    if (id === undefined) return null; // notification (e.g. notifications/initialized)
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          capabilities: {
            prompts: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            tools: { listChanged: false },
          },
          instructions: INSTRUCTIONS,
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          serverInfo: { name: "champions-catalog", version: "" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return toolsCall(id, params, claims);
      default:
        return rpcError(id, -32601, "Method not found");
    }
  };
}
