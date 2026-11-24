// The Personal Agent's connection to the Champions Group Agent.
// Port of personal/champions_client.py.
//
// OAuth2 client credentials -> Agent Card discovery -> A2A SendMessage -> MCP
// tools/call. Every exchange is recorded for the demo's "agent wire" panel, with
// secrets and tokens redacted. Requests go to `champions(request)`, which on the
// edge is the Champions handler called in-process (no network subrequest); the
// requests carry the same paths, headers and bodies the Python client sent.
import { catalogResult, feedback as feedbackPayload } from "./schemas.js";

export const SCOPES = "catalog:read insights:read audit:read";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const A2A_VERSION = "1.0";
const CARD_PATH = "/.well-known/agent-card.json";

export class ChampionsError extends Error {}

function protocol(path) {
  if (path.startsWith("/oauth")) return "OAuth2";
  if (path.startsWith("/.well-known")) return "A2A card";
  if (path.startsWith("/a2a")) return "A2A";
  if (path.startsWith("/mcp")) return "MCP";
  return "HTTP";
}

const SHOWN_HEADERS = ["authorization", "content-type", "a2a-version", "mcp-protocol-version", "accept"];

function redactHeaders(headers) {
  const shown = {};
  for (const key of SHOWN_HEADERS) {
    if (!headers.has(key)) continue;
    let value = headers.get(key);
    if (key === "authorization") value = value.slice(0, 19) + "...(redacted)";
    shown[key] = value;
  }
  return shown;
}

/** Body for the wire panel: form pairs (raw, secret masked), JSON, or text. */
function wireBody(text, contentType) {
  if (!text) return null;
  if ((contentType ?? "").includes("x-www-form-urlencoded")) {
    // Like Python: split without decoding, so the scope shows as "catalog%3Aread+...".
    const pairs = {};
    for (const item of text.split("&")) {
      const i = item.indexOf("=");
      if (i >= 0) pairs[item.slice(0, i)] = item.slice(i + 1);
    }
    if ("client_secret" in pairs) pairs.client_secret = "***";
    return pairs;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Ordered record of everything the Personal Agent did for one question. */
export class Wire {
  constructor() {
    this.events = [];
  }

  local(kind, title, detail = null) {
    this.events.push({ t: Date.now() / 1000, direction: "local", protocol: kind, title, detail });
  }

  onRequest(request, bodyText) {
    const path = new URL(request.url).pathname;
    const body = wireBody(bodyText, request.headers.get("content-type"));
    let title = `${request.method} ${path}`;
    if (isDict(body) && "method" in body) {
      // JSON-RPC (A2A and MCP): name the method, and the tool for tools/call.
      title += ` · ${body.method}`;
      if (body.method === "tools/call") title += ` ${body.params?.name ?? ""}`;
    }
    this.events.push({
      t: Date.now() / 1000, direction: "out", protocol: protocol(path), title,
      headers: redactHeaders(request.headers), body,
    });
  }

  onResponse(path, response, bodyText, started) {
    let body = wireBody(bodyText, response.headers.get("content-type"));
    if (isDict(body) && "access_token" in body) {
      body = { ...body, access_token: String(body.access_token).slice(0, 12) + "...(redacted)" };
    }
    this.events.push({
      t: Date.now() / 1000, direction: "in", protocol: protocol(path),
      title: `${response.status} ${path}`,
      status: response.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
      body,
    });
  }
}

/** JSON from a JSON or SSE ("data: {...}") MCP response; null if unparseable. */
function parseJsonOrSse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    try {
      return data.length ? JSON.parse(data[data.length - 1]) : null;
    } catch {
      return null;
    }
  }
}

export class ChampionsClient {
  /**
   * @param wire Wire recorder
   * @param champions async (Request) => Response
   * @param config {championsBase, clientId, clientSecret}
   */
  constructor(wire, champions, config) {
    this.wire = wire;
    this.champions = champions;
    this.baseUrl = String(config.championsBase).replace(/\/+$/, "");
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.token = null;
  }

  /** One recorded exchange. Returns {status, text, headers}. */
  async http(method, path, { headers = {}, body = null } = {}) {
    const request = new Request(this.baseUrl + path, {
      method,
      headers: { Accept: "*/*", ...headers },
      body,
    });
    this.wire.onRequest(request, body);
    const started = performance.now();
    let response;
    try {
      response = await this.champions(request);
    } catch (error) {
      throw new ChampionsError(`Champions unavailable: ${error?.message ?? error}`);
    }
    const text = await response.text();
    this.wire.onResponse(path, response, text, started);
    return { status: response.status, text, headers: response.headers };
  }

  async bearer() {
    if (this.token === null) {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPES,
      });
      const response = await this.http("POST", "/oauth/token", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (response.status !== 200) {
        throw new ChampionsError(`Token request refused (${response.status}): ${response.text}`);
      }
      this.token = JSON.parse(response.text).access_token;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  /** A2A SendMessage with one DataPart; returns the CatalogResult artifact. */
  async ask(capabilityRequest) {
    const task = await this.send(capabilityRequest);
    try {
      return catalogResult(task.artifacts?.[0]?.parts?.[0]?.data);
    } catch (error) {
      throw new ChampionsError(`Champions returned an unexpected result: ${error.message}`);
    }
  }

  /** A2A SendMessage with champions.feedback/v1: insight ids and useful yes/no, nothing else. */
  async feedback(queryId, ratings) {
    const task = await this.send(feedbackPayload(queryId, ratings));
    return task.artifacts?.[0]?.parts?.[0]?.data;
  }

  /**
   * The A2A path from the Agent Card, pinned to the configured base URL.
   * Hosted, the card advertises the public URL; the Personal Agent keeps its
   * traffic where it was configured to reach Champions (same path).
   */
  static pinnedPath(card) {
    const interfaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : [];
    const chosen = interfaces.find((i) => i.protocolBinding === "JSONRPC") ?? interfaces[0];
    if (!chosen?.url) return "/a2a";
    try {
      return new URL(chosen.url).pathname;
    } catch {
      return "/a2a";
    }
  }

  async send(payload) {
    const auth = await this.bearer();
    const cardResponse = await this.http("GET", CARD_PATH, { headers: auth });
    if (cardResponse.status !== 200) throw new ChampionsError(`Agent Card unavailable (${cardResponse.status})`);
    let card;
    try {
      card = JSON.parse(cardResponse.text);
    } catch {
      throw new ChampionsError("Agent Card is not JSON");
    }
    // Same JSON-RPC body the a2a-sdk (non-streaming JSON-RPC transport) sends.
    const rpc = {
      method: "SendMessage",
      params: {
        message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ data: payload }] },
        configuration: {},
      },
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
    };
    const response = await this.http("POST", ChampionsClient.pinnedPath(card), {
      headers: { ...auth, "Content-Type": "application/json", "A2A-Version": A2A_VERSION },
      body: JSON.stringify(rpc),
    });
    let data = null;
    try {
      data = JSON.parse(response.text);
    } catch {
      /* handled below */
    }
    if (response.status !== 200) {
      throw new ChampionsError(`A2A request failed (${response.status}): ${data?.detail ?? data?.error?.message ?? response.text}`);
    }
    if (data?.error) throw new ChampionsError(`A2A error ${data.error.code}: ${data.error.message}`);
    const task = data?.result?.task;
    if (!task) throw new ChampionsError("Champions returned no task");
    const state = task.status?.state;
    if (state !== "TASK_STATE_COMPLETED") {
      const parts = task.status?.message?.parts ?? [];
      const reason = parts.map((p) => p.text ?? "").join(" ").trim() || state;
      throw new ChampionsError(`Champions task ${state}: ${reason}`);
    }
    return task;
  }

  /** MCP tools/call over Streamable HTTP (stateless JSON mode): initialize, then the call. */
  async mcpTool(name, args) {
    const headers = {
      ...(await this.bearer()),
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Content-Type": "application/json",
    };
    const init = await this.http("POST", "/mcp", {
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "personal-agent", version: "1.0" } },
      }),
    });
    if (init.status !== 200) throw new ChampionsError(`MCP initialize failed (${init.status})`);
    const response = await this.http("POST", "/mcp", {
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    });
    const data = parseJsonOrSse(response.text);
    if (data?.error) throw new ChampionsError(`MCP error ${data.error.code}: ${data.error.message}`);
    const result = data?.result ?? {};
    if (result.isError) throw new ChampionsError(result.content?.[0]?.text ?? "MCP tool error");
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      throw new ChampionsError(`MCP ${name} returned no JSON content (${response.status})`);
    }
  }

  /** What Champions recorded about this client (its own audit view). */
  async audit() {
    const response = await this.http("GET", "/audit", { headers: await this.bearer() });
    try {
      return JSON.parse(response.text).entries ?? [];
    } catch {
      return [];
    }
  }
}
