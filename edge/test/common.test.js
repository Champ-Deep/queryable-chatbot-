import assert from "node:assert/strict";
import { test } from "node:test";

import { Router, safeEqual, HttpError } from "../src/common/http.js";
import { sign, verify, JwtError } from "../src/common/jwt.js";
import { Rng } from "../src/common/rng.js";
import { memoryDb } from "./helpers.js";

test("jwt round-trips and rejects tampering, expiry, audience", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await sign({ sub: "a", aud: "x", iss: "i", exp: now + 60 }, "k");
  assert.equal((await verify(t, "k", { audience: "x", issuer: "i" })).sub, "a");
  await assert.rejects(verify(t, "other", {}), JwtError);
  await assert.rejects(verify(t, "k", { audience: "y" }), /Audience/);
  const old = await sign({ exp: now - 1 }, "k");
  await assert.rejects(verify(old, "k", {}), /token expired/);
});

test("rng is deterministic per seed", () => {
  const a = new Rng(7), b = new Rng(7);
  assert.deepEqual([a.random(), a.randint(1, 6), a.choice("xyz")], [b.random(), b.randint(1, 6), b.choice("xyz")]);
});

test("router matches params, methods and HttpError", async () => {
  const r = new Router().get("/a/{id}", (_q, p) => ({ id: p.id })).post("/e", () => { throw new HttpError(403, "no"); });
  assert.deepEqual(await (await r.handle(new Request("http://h/a/x%20y"))).json(), { id: "x y" });
  assert.equal((await r.handle(new Request("http://h/a/1", { method: "POST" }))).status, 405);
  const e = await r.handle(new Request("http://h/e", { method: "POST" }));
  assert.equal(e.status, 403);
  assert.deepEqual(await e.json(), { detail: "no" });
  assert.equal(await r.handle(new Request("http://h/none")), null);
  assert.ok(safeEqual("ab", "ab") && !safeEqual("ab", "abc"));
});

test("memory db mirrors the DO sql interface", () => {
  const db = memoryDb();
  db.run("CREATE TABLE t (a INTEGER, b TEXT)");
  db.run("INSERT INTO t VALUES (?, ?)", 1, "x");
  assert.deepEqual(db.all("SELECT * FROM t"), [{ a: 1, b: "x" }]);
  assert.deepEqual(db.one("SELECT b FROM t WHERE a = ?", 1), { b: "x" });
});
