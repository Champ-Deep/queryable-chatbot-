// Personal Agent units: planner, consent, evaluator, judge (ports of tests/test_personal*.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate } from "../src/personal/evaluator.js";
import { judge } from "../src/personal/judge.js";
import { plan } from "../src/personal/planner.js";
import { ConsentError, ConsentStore, MemoryConsentStore, PERSONAS, getProfile, sharedContext } from "../src/personal/profile.js";
import { SCENARIOS } from "../src/personal/scenarios.js";
import { fixture, memoryDb } from "./helpers.js";

const QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms";

// ------------------------------------------------------------------ planner

test("planner reads segment and intent from the question", () => {
  const [request, purpose] = plan(QUESTION, getProfile("priya"), []);
  assert.equal(request.skill, "get_insights");
  assert.deepEqual(request.filters.industries, ["Healthcare"]);
  assert.deepEqual(request.filters.regions, ["EMEA"]);
  assert.deepEqual(request.filters.size_bands, ["Mid-market"]);
  assert.deepEqual(request.filters.intent_topics, ["HR Platform Replacement"]);
  assert.equal(purpose, "market_insights");
});

test("planner output matches the Python Plan event", () => {
  const [request] = plan(QUESTION, getProfile("priya"), ["goals", "industry", "region", "role"]);
  const { context, ...planned } = request;
  assert.equal(context, null);
  assert.deepEqual(planned, fixture("chat_ok_priya").wire[1].detail);
  assert.deepEqual(Object.keys(planned), Object.keys(fixture("chat_ok_priya").wire[1].detail));
});

test("planner uses stored segment only with consent", () => {
  const profile = getProfile("priya");
  const [without] = plan("Show me the market", profile, ["industry"]);
  const [withConsent] = plan("Show me the market", profile, ["target_segment"]);
  assert.deepEqual(without.filters.industries, []);
  assert.deepEqual(withConsent.filters.industries, ["Healthcare"]);
});

test("contact requests are outreach purpose", () => {
  const [, purpose] = plan("Give me HR decision makers' emails at UK banks", getProfile("marcus"), []);
  assert.equal(purpose, "outreach");
});

test("capability questions are describe_capabilities / data_discovery", () => {
  const [request, purpose] = plan("What data can Champions provide?", getProfile("aiko"), ["target_segment"]);
  assert.equal(request.skill, "describe_capabilities");
  assert.equal(purpose, "data_discovery");
  assert.deepEqual(request.filters.industries, []); // stored segment not used for the catalog
});

test("hospitals is not Italy and hiring people is not contacts", () => {
  const [request] = plan("Which cloud do North American banks and hospitals use?", getProfile("noor"), []);
  assert.deepEqual(request.filters.countries, []);
  const [, purpose] = plan("Which companies are hiring HR systems people?", getProfile("priya"), []);
  assert.notEqual(purpose, "outreach");
});

// ------------------------------------------------------------------ consent

for (const [label, make] of [["sqlite", () => new ConsentStore(memoryDb())], ["memory", () => new MemoryConsentStore()]]) {
  test(`${label} store: private and unknown fields can never be consented`, () => {
    assert.throws(() => make().grant("priya", "market_insights", ["industry", "budget_monthly_credits"]), ConsentError);
    assert.throws(() => make().grant("priya", "market_insights", ["shoe_size"]), /private fields can never be shared: shoe_size/);
    assert.throws(() => make().grant("priya", "spam", ["industry"]), /unknown purpose spam/);
  });

  test(`${label} store: grant, one active per purpose, revoke`, () => {
    const store = make();
    const first = store.grant("priya", "market_insights", ["role", "industry", "role"]);
    assert.match(first.consent_id, /^cns-[0-9a-f]{12}$/);
    assert.deepEqual(first.fields, ["industry", "role"]);
    assert.match(first.granted_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    const second = store.grant("priya", "market_insights", ["goals"]);
    assert.deepEqual(store.active("priya", "market_insights"), second);
    store.grant("priya", "outreach", ["industry"]);
    store.grant("marcus", "outreach", ["industry"]);
    assert.deepEqual(store.allFor("priya").map((c) => c.purpose), ["market_insights", "outreach"]);
    assert.equal(store.revoke("priya", "market_insights"), true);
    assert.equal(store.revoke("priya", "market_insights"), false);
    assert.equal(store.active("priya", "market_insights"), null);
  });
}

test("sqlite consents persist across store instances on the same db", () => {
  const db = memoryDb();
  const rec = new ConsentStore(db).grant("priya", "market_insights", ["industry"]);
  assert.deepEqual(new ConsentStore(db).active("priya", "market_insights"), rec);
});

test("shared context contains only consented fields", () => {
  const consent = new MemoryConsentStore().grant("priya", "market_insights", ["industry", "role"]);
  assert.deepEqual(sharedContext(getProfile("priya"), consent), { industry: "HR Software", role: "Head of Sales" });
  const seg = new MemoryConsentStore().grant("priya", "market_insights", ["target_segment"]);
  assert.deepEqual(sharedContext(getProfile("priya"), seg), {
    "target_segment.industries": ["Healthcare"],
    "target_segment.regions": ["EMEA"],
    "target_segment.size_bands": ["Mid-market"],
  });
});

test("there are at least ten personas, each with questions", () => {
  assert.ok(Object.keys(PERSONAS).length >= 10);
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(PERSONAS).sort());
  assert.ok(Object.values(SCENARIOS).every((qs) => qs.length >= 4));
  assert.deepEqual(SCENARIOS, fixture("scenarios"));
  assert.deepEqual(getProfile("priya"), fixture("profile_priya").profile);
});

// ---------------------------------------------------------------- evaluator

const catalog = (matches, companies = 400) => ({ matches, matching_companies: companies, insights: [], gaps: [], method: "test" });
const m = (card_id, relevance, refresh, credits, personal = false, fields = []) => ({
  card_id, name: card_id[0].toUpperCase() + card_id.slice(1), relevance, why: "test",
  matched_fields: fields, coverage_pct: 80, refresh, credits_per_1k_records: credits, contains_personal_data: personal,
});

test("evaluator keeps bundle within private budget", () => {
  const rec = evaluate(catalog([
    m("intent_signals", 0.95, "daily", 120, false, ["intent_score"]),
    m("technographics", 0.9, "weekly", 75, false, ["hr_platform"]),
    m("firmographics", 0.95, "monthly", 40, false, ["employee_count"]),
  ]), getProfile("priya"));
  assert.ok(rec.bundle_monthly_credits <= 600);
  assert.equal(rec.within_budget, true);
  assert.ok(rec.bundle.includes("intent_signals"));
  assert.equal(rec.schema, "champions.recommendation/v1");
});

test("GDPR-strict user is steered away from personal data", () => {
  const rec = evaluate(catalog([m("contacts", 1.0, "weekly", 10, true)]), getProfile("priya"));
  assert.equal(rec.options[0].verdict, "not_recommended");
  assert.ok(rec.options[0].reasons.some((r) => r.includes("DPA")));
});

test("budget wording when the bundle uses all of it", () => {
  const rec = evaluate(catalog([m("technographics", 0.9, "weekly", 75)]), getProfile("marcus"));
  assert.match(rec.summary, /uses your full 300-credit budget/);
});

test("evaluator reproduces the Python recommendation for the fixture catalog", () => {
  const f = fixture("chat_ok_priya");
  const vaf = { intent_signals: ["intent_topic", "intent_score", "surge_start", "hiring_signal", "competitor_research"] };
  // Other cards: the fixture's found_in lists the must-haves they cover.
  const found = f.wire.find((e) => e.protocol === "Evaluate").detail.found_in;
  for (const [cid, names] of Object.entries(found)) vaf[cid] ??= names;
  assert.deepEqual(evaluate(f.catalog, getProfile("priya"), vaf), f.recommendation);
});

// -------------------------------------------------------------------- judge

const ins = (id, value = 10, detail = "", themes = ["accounts"]) => ({ id, label: id, value, detail, themes, score: 0 });

test("private notes make an insight useful", () => {
  const [j] = judge([ins("legacy_platform_switchers", 10, "ADP (6), Oracle HCM (4)", ["displacement"])], getProfile("priya"), QUESTION);
  assert.equal(j.useful, true);
  assert.match(j.reason, /notes/);
});

test("must-have fields make an insight useful", () => {
  const [j] = judge([ins("crm_mix", 10, "", ["tech", "crm"])], getProfile("marcus"), "UK fintech payroll");
  assert.equal(j.useful, true);
  assert.match(j.reason, /crm/);
});

test("empty findings are not useful", () => {
  for (const v of [0, "0", "0.0%", "", "0 companies"]) {
    const [j] = judge([ins("hot_accounts", v)], getProfile("priya"), QUESTION);
    assert.equal(j.useful, false, String(v));
    assert.equal(j.reason, "Less useful: nothing found for this segment");
  }
});

test("'no outreach' notes count against account lists", () => {
  const [j] = judge([ins("hot_accounts", 5, "", ["accounts"])], getProfile("aiko"), "anything");
  assert.equal(j.useful, false);
  assert.match(j.reason, /no outreach is planned/);
});

test("judge reproduces the Python ratings and reasons for the fixture insights", () => {
  const f = fixture("chat_ok_priya");
  const judged = judge(f.catalog.insights, getProfile("priya"), QUESTION);
  const expected = Object.fromEntries(f.insights.map((i) => [i.id, { useful: i.useful, reason: i.reason }]));
  for (const j of judged) assert.deepEqual({ useful: j.useful, reason: j.reason }, expected[j.insight_id], j.insight_id);
});
