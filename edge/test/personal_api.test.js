// Personal Agent HTTP API: routes, status codes, validation errors and response
// shapes compared with the golden fixtures captured from the Python agent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createPersonal } from "../src/personal/app.js";
import { markdown } from "../src/personal/simulator.js";
import { SCENARIOS } from "../src/personal/scenarios.js";
import { PAGES, PUBLIC, fixture, memoryDb } from "./helpers.js";
import { CONFIG, assertSameShape, replayChampions } from "./personal_support.js";

const QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms";

function app(champions = replayChampions(), db = memoryDb()) {
  const personal = createPersonal({ db, pages: PAGES, champions, config: CONFIG });
  const call = async (method, path, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const response = await personal.fetch(new Request(PUBLIC + path, init));
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  return { personal, call, champions, db };
}

test("GET / serves the demo page", async () => {
  const r = await app().call("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.text, PAGES.index);
});

test("unknown paths are 404 Not Found; wrong method is 405", async () => {
  const { call } = app();
  const r = await call("GET", "/api/nope");
  assert.deepEqual([r.status, r.json], [404, { detail: "Not Found" }]);
  assert.equal((await call("POST", "/api/personas", {})).status, 405);
});

test("health includes Champions /health; unavailable when it fails", async () => {
  const r = await app().call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, fixture("personal_health"));
  const down = await app(async () => { throw new Error("down"); }).call("GET", "/api/health");
  assert.deepEqual(down.json, { status: "ok", agent: "personal", champions: { status: "unavailable" } });
});

test("personas and scenarios match the fixtures", async () => {
  const { call } = app();
  assert.deepEqual((await call("GET", "/api/personas")).json, fixture("personas"));
  assert.deepEqual((await call("GET", "/api/scenarios")).json, fixture("scenarios"));
});

test("profile has the fixture's shape; unknown persona is 404", async () => {
  const { call } = app();
  const r = await call("GET", "/api/profile/priya");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, fixture("profile_priya"));
  const missing = await call("GET", "/api/profile/zed");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { detail: "unknown persona zed" });
});

test("profile marks private fields and never offers them for consent", async () => {
  const { call } = app();
  const { fields } = (await call("GET", "/api/profile/priya")).json;
  const priv = fields.filter((f) => f.class === "private").map((f) => f.name);
  assert.deepEqual(priv, ["budget_monthly_credits", "must_have_fields", "compliance", "private_notes"]);
  // The consent prompt (what could be sent) shows no private values.
  const chat = (await call("POST", "/api/chat", { persona: "priya", message: QUESTION })).json;
  for (const f of chat.fields.filter((x) => x.class === "private")) assert.equal(f.preview, null);
});

test("consent grant, listing and revoke", async () => {
  const { call } = app();
  const granted = await call("POST", "/api/consent", { persona: "priya", purpose: "market_insights", fields: ["role", "industry", "region", "goals"] });
  assert.equal(granted.status, 200);
  assertSameShape(granted.json, fixture("consent_grant"));
  assert.deepEqual(granted.json.fields, fixture("consent_grant").fields);

  const profile = (await call("GET", "/api/profile/priya")).json;
  assert.deepEqual(profile.consents, [granted.json]);
  assertSameShape(profile.consents[0], fixture("consent_grant"));

  const revoked = await call("DELETE", "/api/consent/priya/market_insights");
  assert.deepEqual(revoked.json, fixture("revoke"));
  assert.deepEqual((await call("DELETE", "/api/consent/priya/market_insights")).json, { revoked: false });
  assert.deepEqual((await call("GET", "/api/profile/priya")).json.consents, []);
  assert.equal((await call("DELETE", "/api/consent/zed/market_insights")).status, 404);
});

test("consent errors: private fields 400, unknown purpose 400, unknown persona 404, bad body 422", async () => {
  const { call } = app();
  const priv = await call("POST", "/api/consent", { persona: "priya", purpose: "market_insights", fields: ["industry", "private_notes"] });
  assert.equal(priv.status, 400);
  assert.deepEqual(priv.json, { detail: "private fields can never be shared: private_notes" });
  const purpose = await call("POST", "/api/consent", { persona: "priya", purpose: "spam", fields: [] });
  assert.deepEqual([purpose.status, purpose.json], [400, { detail: "unknown purpose spam" }]);
  const who = await call("POST", "/api/consent", { persona: "zed", purpose: "outreach", fields: [] });
  assert.deepEqual([who.status, who.json], [404, { detail: "unknown persona zed" }]);
  const missing = await call("POST", "/api/consent", { persona: "priya" });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.json.detail.map((e) => [e.type, e.loc]), [["missing", ["body", "purpose"]], ["missing", ["body", "fields"]]]);
  const wrong = await call("POST", "/api/consent", { persona: "priya", purpose: "outreach", fields: "industry" });
  assert.deepEqual(wrong.json.detail.map((e) => e.type), ["list_type"]);
  const notJson = await call("POST", "/api/consent", "{nope");
  assert.equal(notJson.status, 422);
  assert.equal(notJson.json.detail[0].type, "json_invalid");
});

test("consents persist in SQLite across app instances on the same db", async () => {
  const db = memoryDb();
  await app(replayChampions(), db).call("POST", "/api/consent", { persona: "priya", purpose: "outreach", fields: ["industry"] });
  const again = await app(replayChampions(), db).call("GET", "/api/profile/priya");
  assert.equal(again.json.consents.length, 1);
});

test("chat: validation, consent required, then ok with the fixture shapes", async () => {
  const { call, champions } = app();
  const empty = await call("POST", "/api/chat", { persona: "priya", message: "   " });
  assert.deepEqual([empty.status, empty.json], [400, { detail: "empty message" }]);
  const who = await call("POST", "/api/chat", { persona: "zed", message: "hi" });
  assert.deepEqual([who.status, who.json], [404, { detail: "unknown persona zed" }]);
  const missing = await call("POST", "/api/chat", { persona: "priya" });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.json.detail[0].loc, ["body", "message"]);

  const first = await call("POST", "/api/chat", { persona: "priya", message: QUESTION });
  assert.equal(first.status, 200);
  assertSameShape(first.json, fixture("chat_consent_required"));
  assert.equal(champions.calls.length, 0);

  await call("POST", "/api/consent", { persona: "priya", purpose: first.json.purpose, fields: ["industry", "role", "region", "goals"] });
  const ok = await call("POST", "/api/chat", { persona: "priya", message: QUESTION });
  assert.equal(ok.status, 200);
  assertSameShape(ok.json, fixture("chat_ok_priya"), { loose: ["detail", "body"] });
  assert.equal(ok.json.answer, fixture("chat_ok_priya").answer);

  const caps = await call("POST", "/api/consent", { persona: "aiko", purpose: "data_discovery", fields: ["industry"] });
  assert.equal(caps.status, 200);
  const cap = await call("POST", "/api/chat", { persona: "aiko", message: "What data can Champions provide?" });
  assertSameShape(cap.json, fixture("chat_ok_capabilities"), { loose: ["detail", "body"] });

  const contacts = await call("POST", "/api/chat", { persona: "priya", message: "Get me the emails of HR decision makers at those healthcare companies" });
  assertSameShape(contacts.json, fixture("chat_contacts"));
});

test("Champions audit via the Personal Agent; 502 when Champions refuses the token", async () => {
  const r = await app().call("GET", "/api/champions/audit");
  assert.equal(r.status, 200);
  assertSameShape(r.json, fixture("champions_audit_via_personal"), { loose: ["entries"] });
  assert.ok(Array.isArray(r.json.entries) && r.json.entries.length);
  const refused = await app(replayChampions(undefined, { failOn: (k) => k.startsWith("POST /oauth") })).call("GET", "/api/champions/audit");
  assert.equal(refused.status, 502);
  assert.match(refused.json.detail, /^Champions unavailable: Token request refused \(500\)/);
});

test("simulate runs every persona and returns the fixture's report shape", async () => {
  const { call, champions } = app();
  const r = await call("POST", "/api/simulate");
  assert.equal(r.status, 200);
  const expected = fixture("simulate");
  assertSameShape(r.json, expected);
  const total = Object.values(SCENARIOS).reduce((s, qs) => s + qs.length, 0);
  assert.equal(r.json.conversations, total);
  assert.equal(r.json.rows.length, total);
  assert.equal(r.json.by_persona.length, Object.keys(SCENARIOS).length);
  assert.ok(r.json.useful_pct > 0 && r.json.answered_pct > 0);
  // Every capability request the simulator sent is tagged as simulator traffic.
  const a2a = champions.calls.filter((c) => c.path === "/a2a" && c.body.params.message.parts[0].data.skill);
  assert.ok(a2a.length >= total);
  assert.ok(a2a.every((c) => c.body.params.message.parts[0].data.source === "simulator"));
  // The simulator's auto-consent never includes private fields.
  for (const c of a2a) {
    const shared = Object.keys(c.body.params.message.parts[0].data.context.shared);
    assert.ok(shared.every((k) => ["industry", "role", "region", "goals"].includes(k) || k.startsWith("target_segment.")), shared.join());
  }
  assert.match(markdown(r.json), /^# Agent-to-agent simulation/);
  // The simulator's consents are its own: the user's ledger stays empty.
  assert.deepEqual((await call("GET", "/api/profile/priya")).json.consents, []);
});

test("a second simulation while one runs is refused with 409", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const inner = replayChampions();
  const slow = async (req) => {
    await gate;
    return inner(req);
  };
  const { call } = app(slow);
  const first = call("POST", "/api/simulate");
  await new Promise((r) => setTimeout(r, 10));
  const second = await call("POST", "/api/simulate");
  assert.deepEqual([second.status, second.json], [409, { detail: "a simulation is already running" }]);
  release();
  assert.equal((await first).status, 200);
});
