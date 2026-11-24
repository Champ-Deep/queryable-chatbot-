// Test support for the Personal Agent: a Champions stub that replays the
// golden fixtures' wire responses, and a recursive "same JSON shape" check.
import assert from "node:assert/strict";

import { CLIENT_SECRET, PUBLIC, fixture } from "./helpers.js";

export const CONFIG = { championsBase: PUBLIC, clientId: "personal-agent-demo", clientSecret: CLIENT_SECRET };

/** Routing key for a Champions request: method, path, JSON-RPC method, payload kind. */
function key(method, path, body) {
  let k = `${method} ${path}`;
  if (body && typeof body === "object" && body.method) {
    k += ` ${body.method}`;
    if (body.method === "tools/call") k += ` ${body.params.name} ${JSON.stringify(body.params.arguments)}`;
    if (body.method === "SendMessage") {
      const data = body.params.message.parts[0].data;
      k += ` ${data.schema}${data.skill ? " " + data.skill : ""}`;
    }
  }
  return k;
}

/**
 * Stub `champions(request)` built from the "in" bodies of chat fixtures.
 * Records every request it receives ({method, url, headers, bodyText, body}).
 */
export function replayChampions(names = ["chat_ok_priya", "chat_ok_capabilities"], { failOn } = {}) {
  const responses = new Map();
  for (const name of names) {
    const wire = fixture(name).wire;
    for (let i = 0; i < wire.length - 1; i++) {
      const out = wire[i], back = wire[i + 1];
      if (out.direction !== "out" || back.direction !== "in") continue;
      const [method, path] = out.title.split(" ");
      const k = key(method, path, out.body);
      if (!responses.has(k)) responses.set(k, back);
    }
  }
  const calls = [];
  async function champions(request) {
    const url = new URL(request.url);
    const bodyText = await request.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    const headers = Object.fromEntries(request.headers);
    calls.push({ method: request.method, url: request.url, path: url.pathname, headers, bodyText, body });
    const k = key(request.method, url.pathname, body);
    if (failOn && failOn(k)) return Response.json({ detail: "stub failure" }, { status: 500 });
    if (url.pathname === "/health") return Response.json(fixture("champions_health"));
    if (url.pathname === "/audit") return Response.json(fixture("audit_direct"));
    const back = responses.get(k);
    if (!back) return Response.json({ detail: `stub has no response for ${k}` }, { status: 404 });
    let payload = structuredClone(back.body);
    if (payload && payload.access_token) payload.access_token = "eyJhbGciOiJIUzI1NiJ9.stub.signature";
    // Echo JSON-RPC ids like a real server.
    if (payload && body && body.id !== undefined && payload.jsonrpc) payload.id = body.id;
    return Response.json(payload, { status: back.status });
  }
  champions.calls = calls;
  return champions;
}

function kind(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Asserts `actual` has the same JSON structure as `expected`: same keys at every
 * level, same value types (numbers are numbers, etc.). Arrays: each actual item is
 * compared with the expected item at the same index (or the last one); empty
 * arrays on either side are accepted. `nullable` lists key names whose value may
 * be null on one side only.
 */
export function assertSameShape(actual, expected, { path = "$", nullable = [], loose = [] } = {}) {
  const ka = kind(actual), ke = kind(expected);
  const last = path.split(".").pop().replace(/\[\d+\]$/, "");
  if (loose.includes(last)) return;
  if (ka !== ke) {
    if ((ka === "null" || ke === "null") && nullable.includes(last)) return;
    assert.fail(`${path}: type ${ka} != expected ${ke}`);
  }
  if (ka === "array") {
    if (!actual.length || !expected.length) return;
    actual.forEach((item, i) =>
      assertSameShape(item, expected[Math.min(i, expected.length - 1)], { path: `${path}[${i}]`, nullable, loose }));
  } else if (ka === "object") {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys differ`);
    for (const k of Object.keys(expected)) assertSameShape(actual[k], expected[k], { path: `${path}.${k}`, nullable, loose });
  }
}
