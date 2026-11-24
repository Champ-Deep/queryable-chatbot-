// Champions Group Agent (edge): OAuth, Agent Card, A2A, MCP, REST API, Lab and audit,
// compared with the golden fixtures captured from the Python agent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createChampions } from "../src/champions/app.js";
import { CLIENT_SECRET, LAB_PASSWORD, PAGES, PUBLIC, basic, fixture, memoryDb } from "./helpers.js";
import { assertSameShape } from "./personal_support.js";

const CLIENT = "personal-agent-demo";
const DEMO_SECRET = "demo-secret-change-me";

function app({ labPassword = LAB_PASSWORD, secret = CLIENT_SECRET, hosted = true } = {}) {
  const champions = createChampions({
    db: memoryDb(),
    pages: PAGES,
    config: { publicUrl: PUBLIC, labPassword, clients: { [CLIENT]: secret }, hosted },
  });
  const call = async (method, path, { headers = {}, body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === "string") init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] ??= "application/json";
      }
    }
    const response = await champions.fetch(new Request(PUBLIC + path, init));
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  const token = async (scope = "catalog:read insights:read audit:read") => {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: secret, scope });
    const r = await call("POST", "/oauth/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    assert.equal(r.status, 200, r.text);
    return { Authorization: `Bearer ${r.json.access_token}` };
  };
  const a2a = async (data, auth) => call("POST", "/a2a", {
    headers: { ...auth, "A2A-Version": "1.0" },
    body: {
      jsonrpc: "2.0", id: "rpc-1", method: "SendMessage",
      params: { message: { messageId: "m-1", role: "ROLE_USER", parts: [{ data }] }, configuration: {} },
    },
  });
  const mcp = async (method, params, auth, id = 1) => call("POST", "/mcp", {
    headers: { ...auth, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: { jsonrpc: "2.0", id, method, params },
  });
  return { champions, call, token, a2a, mcp };
}

const INSIGHTS_REQUEST = {
  schema: "champions.capability_request/v1",
  skill: "get_insights",
  need: "Find mid-size healthcare companies in Europe that are switching HR platforms",
  filters: { industries: ["Healthcare"], regions: ["EMEA"], size_bands: ["Mid-market"], intent_topics: ["HR Platform Replacement"] },
  desired_outputs: ["intent_signals", "technographics"],
  context: { consent_id: "cns-test", purpose: "market_insights", shared: { role: "Head of Sales", industry: "HR Software" } },
};

// ------------------------------------------------------------------ basics

test("health matches the fixture", async () => {
  const r = await app().call("GET", "/health");
  assert.deepEqual([r.status, r.json], [200, fixture("champions_health")]);
});

test("Agent Card has the fixture's shape and advertises the public URL", async () => {
  const r = await app().call("GET", "/.well-known/agent-card.json");
  assert.equal(r.status, 200);
  const expected = fixture("agent_card");
  assertSameShape(r.json, expected);
  assert.equal(r.json.supportedInterfaces[0].url, `${PUBLIC}/a2a`);
  assert.equal(r.json.securitySchemes.bearer.httpAuthSecurityScheme.description,
    `OAuth2 client credentials: POST ${PUBLIC}/oauth/token`);
  assert.deepEqual(r.json.skills.map((s) => s.id), expected.skills.map((s) => s.id));
});

// ------------------------------------------------------------------ OAuth

test("OAuth issues a scoped token like the fixture", async () => {
  const { call } = app();
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: CLIENT_SECRET });
  const r = await call("POST", "/oauth/token", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.json, access_token: "<jwt>" }, fixture("oauth_token"));
  assert.equal(r.json.access_token.split(".").length, 3);
});

test("OAuth refuses wrong secret, wrong grant, unknown scope and the demo secret when hosted", async () => {
  const post = (a, fields) => a.call("POST", "/oauth/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  });
  const a = app();
  const base = { grant_type: "client_credentials", client_id: CLIENT, client_secret: CLIENT_SECRET };
  assert.deepEqual(await post(a, { ...base, client_secret: "nope" }).then((r) => [r.status, r.json]), [401, { error: "invalid_client" }]);
  assert.deepEqual(await post(a, { ...base, grant_type: "password" }).then((r) => [r.status, r.json]), [400, { error: "unsupported_grant_type" }]);
  assert.deepEqual(await post(a, { ...base, scope: "catalog:read admin" }).then((r) => [r.status, r.json]), [400, { error: "invalid_scope: admin" }]);
  const missing = await post(a, { grant_type: "client_credentials" });
  assert.equal(missing.status, 422);
  const demo = app({ secret: DEMO_SECRET });
  const r = await post(demo, { ...base, client_secret: DEMO_SECRET });
  assert.deepEqual([r.status, r.json], [401, { error: "invalid_client: the public demo secret is disabled when hosted" }]);
});

test("protected paths need a valid bearer token", async () => {
  const a = app();
  const r = await a.call("POST", "/a2a", { body: {} });
  const expected = fixture("a2a_no_token");
  assert.deepEqual([r.status, r.json], [expected.status, expected.body]);
  assert.match(r.headers.get("www-authenticate"), /Bearer/);
  for (const path of ["/mcp", "/audit"]) assert.equal((await a.call(path === "/audit" ? "GET" : "POST", path)).status, 401);
  const bad = await a.call("GET", "/audit", { headers: { Authorization: "Bearer not.a.jwt" } });
  assert.equal(bad.status, 401);
  assert.match(bad.json.detail, /^invalid token/);
});

// ------------------------------------------------------------------ A2A

test("A2A get_insights returns a completed task with a catalog_result artifact", async () => {
  const a = app();
  const r = await a.a2a(INSIGHTS_REQUEST, await a.token());
  assert.equal(r.status, 200);
  assert.equal(r.json.jsonrpc, "2.0");
  assert.equal(r.json.id, "rpc-1");
  const task = r.json.result.task;
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(task.artifacts[0].name, "catalog_result");
  const result = task.artifacts[0].parts[0].data;
  assert.equal(result.schema, "champions.catalog_result/v1");
  assert.match(result.query_id, /^q-[0-9a-f]{12}$/);
  assert.equal(result.consent_id, "cns-test");
  assert.ok(result.matching_companies > 0);
  assert.ok(result.insights.length > 0);
  assert.deepEqual(result.personalised_for, ["industry", "role"]);
});

test("A2A feedback is recorded on the caller's own query only", async () => {
  const a = app();
  const auth = await a.token();
  const result = (await a.a2a(INSIGHTS_REQUEST, auth)).json.result.task.artifacts[0].parts[0].data;
  const ratings = result.insights.slice(0, 2).map((i, n) => ({ insight_id: i.id, useful: n === 0 }));
  const ack = await a.a2a({ schema: "champions.feedback/v1", query_id: result.query_id, ratings }, auth);
  const task = ack.json.result.task;
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(task.artifacts[0].parts[0].data,
    { schema: "champions.feedback_ack/v1", query_id: result.query_id, recorded: 2 });
  const unknown = await a.a2a({ schema: "champions.feedback/v1", query_id: "q-unknown", ratings }, auth);
  assert.equal(unknown.json.result.task.status.state, "TASK_STATE_FAILED");
  assert.match(unknown.json.result.task.status.message.parts[0].text, /Unknown query_id q-unknown/);
});

test("A2A rejects bad payloads and missing scopes as failed tasks", async () => {
  const a = app();
  const auth = await a.token();
  const noData = await a.call("POST", "/a2a", {
    headers: auth,
    body: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] } } },
  });
  assert.equal(noData.json.result.task.status.state, "TASK_STATE_FAILED");
  const invalid = await a.a2a({ schema: "champions.capability_request/v1", skill: "dance", need: "x" }, auth);
  assert.match(invalid.json.result.task.status.message.parts[0].text, /^Invalid capability_request: /);
  const narrow = await a.token("catalog:read");
  const denied = await a.a2a(INSIGHTS_REQUEST, narrow);
  assert.equal(denied.json.result.task.status.state, "TASK_STATE_FAILED");
  assert.match(denied.json.result.task.status.message.parts[0].text, /insufficient_scope: needs insights:read/);
  const method = await a.call("POST", "/a2a", { headers: auth, body: { jsonrpc: "2.0", id: 9, method: "Nope", params: {} } });
  assert.equal(method.json.error.code, -32601);
  const garbage = await a.call("POST", "/a2a", { headers: auth, body: "{not json" });
  assert.equal(garbage.json.error.code, -32700);
});

// ------------------------------------------------------------------ MCP

test("MCP initialize and tools/list match the fixtures", async () => {
  const a = app();
  const auth = await a.token();
  assert.deepEqual((await a.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, auth)).json,
    fixture("mcp_initialize"));
  assert.deepEqual((await a.mcp("tools/list", {}, auth, 2)).json, fixture("mcp_tools_list"));
  const note = await a.call("POST", "/mcp", { headers: auth, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.status, 202);
});

test("MCP tools call the REST API and return JSON text content", async () => {
  const a = app();
  const auth = await a.token();
  const call = async (name, args, id = 3) => (await a.mcp("tools/call", { name, arguments: args }, auth, id)).json;

  const cards = await call("list_data_cards", {});
  assertSameShape(cards, fixture("mcp_call_list_data_cards"));
  const fields = await call("get_vaf_fields", { card_id: "intent_signals" });
  assert.deepEqual(JSON.parse(fields.result.content[0].text), JSON.parse(fixture("mcp_call_get_vaf_fields").result.content[0].text));
  assert.deepEqual(await call("get_vaf_fields", { card_id: "nope" }, 4), fixture("mcp_call_bad_card"));

  const found = JSON.parse((await call("find_data_cards", { need: "HR platforms in Europe", regions: ["EMEA"] })).result.content[0].text);
  assert.equal(found.schema, "champions.catalog_result/v1");
  const insights = JSON.parse((await call("get_insights", { need: "growth", industries: ["Healthcare"], role: "Investment Partner" })).result.content[0].text);
  assert.deepEqual(insights.personalised_for, ["role"]);
  const stats = JSON.parse((await call("get_query_stats", {})).result.content[0].text);
  assert.deepEqual(Object.keys(stats), Object.keys(fixture("lab_stats")));
  assert.equal(stats.total, 2);
  assert.deepEqual(stats.by_channel, { mcp: 2 });

  const unknown = await call("nope", {});
  assert.equal(unknown.result.isError, true);
});

test("MCP get_insights needs insights:read; unknown methods are JSON-RPC errors", async () => {
  const a = app();
  const narrow = await a.token("catalog:read");
  const r = (await a.mcp("tools/call", { name: "get_insights", arguments: { need: "x" } }, narrow)).json;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /insufficient_scope: needs insights:read/);
  const m = (await a.mcp("resources/nope", {}, narrow)).json;
  assert.equal(m.error.code, -32601);
  const get = await a.call("GET", "/mcp", { headers: narrow });
  assert.equal(get.status, 405);
});

// ------------------------------------------------------------------ REST API

test("REST API needs the internal key", async () => {
  const a = app();
  const r = await a.call("GET", "/api/v1/cards");
  assert.deepEqual([r.status, r.json], [401, { detail: "missing or invalid X-API-Key" }]);
  const wrong = await a.call("GET", "/api/v1/cards", { headers: { "X-API-Key": "guess" } });
  assert.equal(wrong.status, 401);
});

// ------------------------------------------------------------------ audit

test("audit shows only the caller's own entries and needs audit:read", async () => {
  const a = app();
  const auth = await a.token();
  await a.a2a(INSIGHTS_REQUEST, auth);
  const r = await a.call("GET", "/audit", { headers: auth });
  assert.equal(r.status, 200);
  const events = r.json.entries.map((e) => e.event);
  assert.ok(events.includes("oauth.token_issued"));
  assert.ok(events.includes("a2a.get_insights"));
  assertSameShape(r.json.entries.find((e) => e.event === "a2a.get_insights"),
    fixture("audit_direct").entries.find((e) => e.event === "a2a.get_insights"));
  const narrow = await a.token("catalog:read");
  const denied = await a.call("GET", "/audit", { headers: narrow });
  assert.deepEqual([denied.status, denied.json], [403, { error: "insufficient_scope: needs audit:read" }]);
});

// ------------------------------------------------------------------ Lab

test("Lab needs the password; fails closed without one", async () => {
  const a = app();
  const anon = await a.call("GET", "/lab");
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /^Basic realm="Champions Agent Lab"/);
  assert.equal((await a.call("GET", "/lab", { headers: basic("admin", "wrong") })).status, 401);
  const ok = await a.call("GET", "/lab", { headers: basic("admin", LAB_PASSWORD) });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, PAGES.lab);
  const closed = await app({ labPassword: "" }).call("GET", "/lab/api/stats", { headers: basic("admin", "") });
  assert.equal(closed.status, 403);
});

test("Lab API: stats, recent, exports and clear", async () => {
  const a = app();
  const lab = basic("admin", LAB_PASSWORD);
  await a.a2a(INSIGHTS_REQUEST, await a.token());
  const stats = await a.call("GET", "/lab/api/stats", { headers: lab });
  assertSameShape(stats.json, fixture("lab_stats"), { loose: ["by_source", "by_channel"] });
  assert.equal(stats.json.total, 1);
  assert.deepEqual([stats.json.by_source, stats.json.by_channel], [{ live: 1 }, { a2a: 1 }]);
  const recent = await a.call("GET", "/lab/api/recent?limit=5", { headers: lab });
  assert.equal(recent.json.queries.length, 1);
  assertSameShape(recent.json.queries[0], fixture("lab_recent").queries[0], { loose: ["ratings"] });
  const csv = await a.call("GET", "/lab/api/export.csv", { headers: lab });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /champions_queries\.csv/);
  assert.equal(csv.text.split("\r\n")[0], fixture_csv_header());
  assert.equal((await a.call("GET", "/lab/api/export.xml", { headers: lab })).status, 404);
  assert.equal((await a.call("POST", "/lab/api/clear", { headers: lab })).status, 403);
  const cleared = await a.call("POST", "/lab/api/clear", { headers: { ...lab, "X-Requested-With": "lab" } });
  assert.deepEqual(cleared.json, { cleared: true });
  assert.equal((await a.call("GET", "/lab/api/stats", { headers: lab })).json.total, 0);
});

function fixture_csv_header() {
  return "query_id,at,client,channel,source,skill,intent,need,filters,shared_role,shared_industry,shared_fields,cards,insight_ids,matching,gaps,latency_ms,ratings";
}

test("unknown Champions paths are 404", async () => {
  const r = await app().call("GET", "/api/v1/nope", { headers: { "X-API-Key": "x" } });
  assert.equal(r.status, 401); // the key check runs first, like FastAPI's router dependency
  assert.equal((await app().call("GET", "/health/nope")).status, 404);
});
