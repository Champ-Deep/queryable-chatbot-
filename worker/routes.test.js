import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAMPIONS_PORT, PERSONAL_PORT, portFor } from "./routes.js";

test("Champions Group Agent paths go to :9100", () => {
  for (const path of [
    "/lab", "/lab/api/stats", "/lab/api/export.csv",
    "/.well-known/agent-card.json", "/a2a", "/mcp", "/oauth/token",
    "/api/v1/cards", "/audit", "/health",
  ]) {
    assert.equal(portFor(path), CHAMPIONS_PORT, path);
  }
});

test("Personal Agent paths, including its own /api, go to :9200", () => {
  for (const path of [
    "/", "/api/health", "/api/personas", "/api/chat", "/api/simulate",
    "/api/champions/audit", "/api/v1x", "/laboratory", "/favicon.ico",
  ]) {
    assert.equal(portFor(path), PERSONAL_PORT, path);
  }
});
