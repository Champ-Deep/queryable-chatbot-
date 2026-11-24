// Smoke test against a running deployment (wrangler dev or the live Worker).
//   node scripts/smoke.mjs <base-url> <lab-password>
// Checks: health, Agent Card, A2A guard, a consented chat turn (OAuth, Card, A2A, MCP),
// the Lab's login, and a simulation filling the Lab. Exits 1 on the first failure.
const [base = "http://127.0.0.1:8787", labPassword] = process.argv.slice(2);
if (!labPassword) {
  console.error("usage: node scripts/smoke.mjs <base-url> <lab-password>");
  process.exit(2);
}
const lab = { Authorization: "Basic " + btoa(`admin:${labPassword}`) };
let failed = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`PASS ${name}${note ? ` - ${note}` : ""} (${Date.now() - started} ms)`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

async function call(method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(base + path, init);
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, json, text, headers: r.headers };
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

await check("Champions /health", async () => {
  const r = await call("GET", "/health");
  expect(r.status === 200 && r.json?.status === "ok", `${r.status} ${r.text.slice(0, 120)}`);
});
await check("Personal /api/health sees Champions", async () => {
  const r = await call("GET", "/api/health");
  expect(r.json?.champions?.status === "ok", r.text.slice(0, 200));
});
await check("demo page", async () => {
  const r = await call("GET", "/");
  expect(r.status === 200 && r.text.includes("<html"), `${r.status}`);
});
await check("Agent Card advertises this origin", async () => {
  const r = await call("GET", "/.well-known/agent-card.json");
  expect(r.json?.supportedInterfaces?.[0]?.url === `${new URL(base).origin}/a2a`, JSON.stringify(r.json?.supportedInterfaces));
});
await check("A2A refuses calls without a token", async () => {
  const r = await call("POST", "/a2a", { body: {} });
  expect(r.status === 401, `${r.status}`);
});
await check("consented chat turn: OAuth -> Card -> A2A -> MCP", async () => {
  await call("POST", "/api/consent", { body: { persona: "priya", purpose: "market_insights", fields: ["role", "industry", "region", "goals"] } });
  const r = await call("POST", "/api/chat", {
    body: { persona: "priya", message: "Find mid-size healthcare companies in Europe that are switching HR platforms" },
  });
  expect(r.json?.status === "ok", r.text.slice(0, 300));
  const steps = r.json.wire.filter((e) => e.direction === "out").map((e) => e.title.split(" · ")[0]);
  for (const step of ["POST /oauth/token", "GET /.well-known/agent-card.json", "POST /a2a", "POST /mcp"]) {
    expect(steps.includes(step), `missing ${step}`);
  }
  return `${r.json.insights.length} insights, ${r.json.wire.length} wire events`;
});
await check("Lab asks for a login", async () => {
  const r = await call("GET", "/lab");
  expect(r.status === 401, `${r.status}`);
});
await check("Lab opens with the password", async () => {
  const r = await call("GET", "/lab", { headers: lab });
  expect(r.status === 200 && r.text.includes("Champions Agent Lab"), `${r.status}`);
});
await check("simulation fills the Lab", async () => {
  const sim = await call("POST", "/api/simulate");
  expect(sim.status === 200, `${sim.status} ${sim.text.slice(0, 200)}`);
  const stats = await call("GET", "/lab/api/stats", { headers: lab });
  expect(stats.json?.total >= sim.json.conversations, JSON.stringify(stats.json).slice(0, 200));
  return `${sim.json.conversations} conversations, ${sim.json.useful_pct}% useful, Lab total ${stats.json.total}`;
});

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
