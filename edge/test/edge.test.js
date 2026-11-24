// End to end: both agents wired like the Durable Object does it (real Champions, no stubs).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgents } from "../src/agents.js";
import { CLIENT_SECRET, LAB_PASSWORD, PAGES, PUBLIC, basic, fixture, memoryDb } from "./helpers.js";
import { assertSameShape } from "./personal_support.js";

const QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms";

function agents(clientSecret = CLIENT_SECRET) {
  const a = createAgents({ db: memoryDb(), pages: PAGES, publicUrl: PUBLIC, labPassword: LAB_PASSWORD, clientSecret });
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const response = await a.fetch(new Request(PUBLIC + path, init));
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  };
  return { a, call };
}

test("routes: demo page, Lab and Champions endpoints on one origin", async () => {
  const { call } = agents();
  assert.equal((await call("GET", "/")).text, PAGES.index);
  assert.equal((await call("GET", "/lab")).status, 401);
  assert.deepEqual((await call("GET", "/health")).json, fixture("champions_health"));
  assert.deepEqual((await call("GET", "/api/health")).json, fixture("personal_health"));
});

test("a consented chat turn goes OAuth -> Agent Card -> A2A -> MCP -> feedback and lands in the Lab", async () => {
  const { call } = agents();
  await call("POST", "/api/consent", { persona: "priya", purpose: "market_insights", fields: ["role", "industry", "region", "goals"] });
  const r = await call("POST", "/api/chat", { persona: "priya", message: QUESTION });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "ok");
  assertSameShape(r.json, fixture("chat_ok_priya"), { loose: ["wire", "catalog", "insights", "recommendation", "follow_ups", "answer"] });
  assert.ok(r.json.insights.length > 0);
  const titles = r.json.wire.filter((e) => e.direction === "out").map((e) => e.title);
  assert.equal(titles[0], "POST /oauth/token");
  assert.ok(titles.includes("POST /a2a · SendMessage"));
  assert.ok(titles.some((t) => t.startsWith("POST /mcp · tools/call get_vaf_fields")));
  for (const e of r.json.wire.filter((x) => x.direction === "in")) assert.ok(e.status < 400, `${e.title} ${JSON.stringify(e.body)}`);
  // Private fields never go on the wire.
  const sent = JSON.stringify(r.json.wire.filter((e) => e.direction === "out").map((e) => e.body));
  for (const word of ["budget_monthly_credits", "private_notes", "must_have_fields", "compliance"]) assert.ok(!sent.includes(word), word);

  const stats = (await call("GET", "/lab/api/stats", undefined, basic("admin", LAB_PASSWORD))).json;
  assert.equal(stats.total, 1);
  assert.ok(stats.rated > 0, "feedback ratings reached Champions");
  assert.deepEqual(stats.by_role.map((x) => x.role), ["Head of Sales"]);

  const audit = await call("GET", "/api/champions/audit");
  assert.equal(audit.status, 200);
  assert.ok(JSON.stringify(audit.json).includes("a2a.get_insights"));
});

test("the simulation runs every persona against the real Champions agent", async () => {
  const { call } = agents();
  const r = await call("POST", "/api/simulate");
  assert.equal(r.status, 200, r.text);
  assertSameShape(r.json, fixture("simulate"), { loose: ["by_persona", "gaps", "by_intent", "report", "markdown"] });
  assert.equal(r.json.conversations, fixture("simulate").conversations);
  assert.ok(r.json.useful_pct > 0 && r.json.useful_pct < 100);
  const stats = (await call("GET", "/lab/api/stats", undefined, basic("admin", LAB_PASSWORD))).json;
  assert.equal(stats.total, r.json.conversations);
  assert.ok(stats.gaps.length > 0);
});

test("the published demo secret is refused when hosted, and chat says so", async () => {
  const { call } = agents("demo-secret-change-me");
  await call("POST", "/api/consent", { persona: "priya", purpose: "market_insights", fields: ["role"] });
  const r = await call("POST", "/api/chat", { persona: "priya", message: QUESTION });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "error");
  assert.match(r.json.error, /public demo secret is disabled when hosted/);
});
