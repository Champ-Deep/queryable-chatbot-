// Personal Agent turns against a Champions stub that replays the golden fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "../src/personal/agent.js";
import { ChampionsClient, Wire } from "../src/personal/client.js";
import { MemoryConsentStore } from "../src/personal/profile.js";
import { CLIENT_SECRET, PUBLIC, fixture } from "./helpers.js";
import { CONFIG, assertSameShape, replayChampions } from "./personal_support.js";

const QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms";
const PRIVATE_VALUES = ["PeopleFlow", "Q1 quota", "ADP or Oracle", "gdpr_strict", "600", "intent_score\",\"hr_platform\",\"employee_count",
  "private_notes", "budget_monthly_credits", "must_have_fields", "compliance", "Useful:", "Less useful", "reason"];

async function turn(persona, question, fields, opts = {}) {
  const store = new MemoryConsentStore();
  let consent = null;
  if (fields) consent = store.grant(persona, opts.purpose ?? "market_insights", fields);
  const champions = replayChampions(undefined, opts);
  const result = await runTurn(persona, question, store, { champions, config: CONFIG, source: opts.source });
  return { result, champions, consent };
}

test("turn without consent asks first and sends nothing", async () => {
  const { result, champions } = await turn("priya", QUESTION, null);
  assert.equal(result.status, "consent_required");
  assert.equal(champions.calls.length, 0);
  assert.ok(!result.wire.some((e) => e.direction === "out"));
  const expected = fixture("chat_consent_required");
  assertSameShape(result, expected);
  const { wire, ...rest } = result;
  const { wire: ew, ...erest } = expected;
  assert.deepEqual(rest, erest); // previews, defaults, labels: identical; private previews are null
  assert.deepEqual(wire[0].detail, ew[0].detail);
});

test("contact questions need the outreach consent", async () => {
  const store = new MemoryConsentStore();
  store.grant("priya", "market_insights", ["industry"]);
  const champions = replayChampions();
  const result = await runTurn("priya", "Get me the emails of HR decision makers at those healthcare companies", store, { champions, config: CONFIG });
  const { wire, ...rest } = result;
  const { wire: ew, ...erest } = fixture("chat_contacts");
  assert.deepEqual(rest, erest);
  assert.equal(champions.calls.length, 0);
});

test("full turn goes OAuth -> A2A card -> A2A -> MCP and shares only consented fields", async () => {
  const { result, champions } = await turn("priya", QUESTION, ["industry", "role"]);
  assert.equal(result.status, "ok", JSON.stringify(result).slice(0, 500));
  const outs = result.wire.filter((e) => e.direction === "out");
  assert.deepEqual(outs.slice(0, 4).map((e) => e.protocol), ["OAuth2", "A2A card", "A2A", "MCP"]);
  assert.deepEqual(champions.calls.map((c) => `${c.method} ${c.path}`).slice(0, 5),
    ["POST /oauth/token", "GET /.well-known/agent-card.json", "POST /a2a", "POST /mcp", "POST /mcp"]);
  // A2A stays on the configured base even though the card advertises 127.0.0.1:9100.
  assert.ok(champions.calls.every((c) => c.url.startsWith(PUBLIC + "/")));

  const shown = JSON.stringify(outs.map((e) => e.body));
  const raw = champions.calls.slice(1).map((c) => c.bodyText).join("\n");
  assert.ok(shown.includes("HR Software") && shown.includes("Head of Sales"));
  // "Build pipeline" is the goals field, which was not consented this time.
  for (const secret of ["PeopleFlow", "Q1 quota", "gdpr_strict", CLIENT_SECRET, "demo-secret-change-me", "Build pipeline"]) {
    assert.ok(!shown.includes(secret), secret);
    assert.ok(!raw.includes(secret), secret);
  }
  // The real secret goes in the form body (never displayed), nowhere else.
  assert.ok(champions.calls[0].bodyText.includes(`client_secret=${CLIENT_SECRET}`));
  assert.ok(champions.calls.slice(1).every((c) => !c.bodyText.includes(CLIENT_SECRET)));
  assert.equal(result.recommendation.within_budget, true);
  assert.ok(result.recommendation.bundle.length);
  assert.ok(result.catalog.matching_companies > 0);
});

test("private values never appear in any outbound request, even with every non-private field consented", async () => {
  const { result, champions } = await turn("priya", QUESTION, ["industry", "role", "region", "goals", "target_segment"]);
  assert.equal(result.status, "ok");
  const raw = champions.calls.map((c) => JSON.stringify(c.headers) + c.bodyText).join("\n");
  for (const value of PRIVATE_VALUES) assert.ok(!raw.includes(value), value);
  const a2a = champions.calls.find((c) => c.path === "/a2a");
  const shared = a2a.body.params.message.parts[0].data.context.shared;
  assert.deepEqual(Object.keys(shared).sort(),
    ["goals", "industry", "region", "role", "target_segment.industries", "target_segment.regions", "target_segment.size_bands"]);
});

test("wire titles name the JSON-RPC method", async () => {
  const { result } = await turn("priya", QUESTION, ["industry"]);
  const titles = result.wire.filter((e) => e.direction === "out").map((e) => e.title);
  assert.ok(titles.includes("POST /a2a · SendMessage"));
  assert.ok(titles.includes("POST /mcp · initialize"));
  assert.ok(titles.includes("POST /mcp · tools/call get_vaf_fields"));
});

test("client sends the same requests as the Python client (headers and bodies)", async () => {
  const { result, champions, consent } = await turn("priya", QUESTION, ["goals", "industry", "region", "role"]);
  const expected = fixture("chat_ok_priya").wire;
  // Same wire sequence and shapes; same displayed headers and bodies (ids differ).
  assert.deepEqual(result.wire.map((e) => `${e.direction} ${e.protocol} ${e.title}`),
    expected.map((e) => `${e.direction} ${e.protocol} ${e.title.replace("cns-b8c389a0fa4e", consent.consent_id)}`));
  result.wire.forEach((e, i) => assertSameShape(e, expected[i], {
    path: `wire[${i}]`, nullable: ["ms"], loose: ["detail", "body"],
  }));
  const outs = result.wire.filter((e) => e.direction === "out");
  const eouts = expected.filter((e) => e.direction === "out");
  outs.forEach((e, i) => assert.deepEqual(e.headers, eouts[i].headers, e.title));

  const strip = (b) => {
    if (!b?.params?.message) return b;
    const c = structuredClone(b);
    delete c.id;
    delete c.params.message.messageId;
    if (c.params.message.parts[0].data.context) c.params.message.parts[0].data.context.consent_id = "x";
    return c;
  };
  outs.forEach((e, i) => assert.deepEqual(strip(e.body), strip(eouts[i].body), e.title));
  // Key order of the A2A envelope matches the a2a-sdk serialisation.
  assert.deepEqual(Object.keys(outs[2].body), ["method", "params", "id", "jsonrpc"]);
  assert.deepEqual(Object.keys(outs[2].body.params), ["message", "configuration"]);

  // Raw requests: OAuth form post, bearer everywhere else, protocol headers.
  const [token, card, a2a, init, call] = champions.calls;
  assert.equal(token.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(token.bodyText, `grant_type=client_credentials&client_id=personal-agent-demo&client_secret=${CLIENT_SECRET}&scope=catalog%3Aread+insights%3Aread+audit%3Aread`);
  for (const c of [card, a2a, init, call]) assert.equal(c.headers.authorization, "Bearer eyJhbGciOiJIUzI1NiJ9.stub.signature");
  assert.equal(a2a.headers["a2a-version"], "1.0");
  assert.equal(a2a.headers["content-type"], "application/json");
  assert.equal(init.headers["mcp-protocol-version"], "2025-06-18");
  assert.equal(init.headers.accept, "application/json, text/event-stream");
  assert.equal(call.body.params.name, "get_vaf_fields");

  // Redaction: token truncated in the wire, client secret masked.
  assert.equal(result.wire[2].body.client_secret, "***");
  assert.equal(result.wire[3].body.access_token, "eyJhbGciOiJI...(redacted)");
});

test("turn output equals the Python result for the same catalog", async () => {
  const { result, consent } = await turn("priya", QUESTION, ["goals", "industry", "region", "role"]);
  const expected = fixture("chat_ok_priya");
  assertSameShape(result, expected, { loose: ["detail", "body"] });
  for (const k of ["answer", "insights", "follow_ups", "skill", "recommendation"]) assert.deepEqual(result[k], expected[k], k);
  assert.deepEqual(result.catalog, expected.catalog);
  assert.deepEqual(result.consent, consent);
  // Feedback carries ids and yes/no only.
  const fb = result.wire.filter((e) => e.direction === "out" && JSON.stringify(e.body).includes("champions.feedback/v1"));
  assert.equal(fb.length, 1);
  const sent = JSON.stringify(fb[0].body);
  for (const p of ["reason", "notes", "Q1 quota", "ADP or Oracle"]) assert.ok(!sent.includes(p), p);
});

test("capability question lists the catalog instead of a shopping list", async () => {
  const { result } = await turn("aiko", "What data can Champions provide?", ["industry"], { purpose: "data_discovery" });
  const expected = fixture("chat_ok_capabilities");
  assert.equal(result.status, "ok");
  assert.ok(result.answer.startsWith("Champions offers 6 data cards"));
  assert.ok(result.answer.includes("Best fits for your profile"));
  assert.ok(!result.answer.includes("Buy "));
  assert.equal(result.answer, expected.answer);
  assert.deepEqual(result.recommendation, expected.recommendation);
  assert.deepEqual(result.insights, []);
  assert.ok(!result.wire.some((e) => e.protocol === "Judge"));
  assertSameShape(result, expected, { loose: ["detail", "body"] });
});

test("simulator traffic is tagged source=simulator", async () => {
  const { champions } = await turn("priya", QUESTION, ["industry"], { source: "simulator" });
  const a2a = champions.calls.find((c) => c.path === "/a2a");
  assert.equal(a2a.body.params.message.parts[0].data.source, "simulator");
});

test("Champions failures become a status=error turn with the reason on the wire", async () => {
  const { result } = await turn("priya", QUESTION, ["industry"], { failOn: (k) => k.startsWith("POST /oauth/token") });
  assert.equal(result.status, "error");
  assert.match(result.error, /^Token request refused \(500\)/);
  assert.equal(result.wire.at(-1).protocol, "Error");
});

test("feedback failure is reported but the turn still answers", async () => {
  const { result } = await turn("priya", QUESTION, ["industry"], { failOn: (k) => k.includes("champions.feedback/v1") });
  assert.equal(result.status, "ok");
  assert.ok(result.wire.some((e) => e.protocol === "Error" && e.title.startsWith("Feedback not delivered")));
});

test("contacts gap is explained in the answer", async () => {
  const champions = replayChampions();
  // Same catalog, with the gap Champions reports for contact requests.
  const wrapped = async (request) => {
    const response = await champions(request.clone());
    if (!request.url.endsWith("/a2a")) return response;
    const body = await response.json();
    const data = body.result.task.artifacts[0].parts[0].data;
    if (data.schema === "champions.catalog_result/v1") data.gaps = ["contacts_not_available"];
    return Response.json(body);
  };
  const store = new MemoryConsentStore();
  store.grant("priya", "outreach", ["industry"]);
  const result = await runTurn("priya", "Get me the emails of HR decision makers at those healthcare companies", store,
    { champions: wrapped, config: CONFIG });
  assert.equal(result.status, "ok");
  assert.match(result.answer, /doesn't hand out contacts over this channel/);
  assert.deepEqual(result.catalog.gaps, ["contacts_not_available"]);
});

test("audit uses a fresh token and returns Champions' entries", async () => {
  const champions = replayChampions();
  const entries = await new ChampionsClient(new Wire(), champions, CONFIG).audit();
  assert.deepEqual(entries, fixture("audit_direct").entries);
  assert.deepEqual(champions.calls.map((c) => `${c.method} ${c.path}`), ["POST /oauth/token", "GET /audit"]);
  assert.equal(champions.calls[1].headers.authorization, "Bearer eyJhbGciOiJIUzI1NiJ9.stub.signature");
});

test("pinnedPath ignores the card's host", () => {
  assert.equal(ChampionsClient.pinnedPath(fixture("agent_card")), "/a2a");
  assert.equal(ChampionsClient.pinnedPath({}), "/a2a");
});
