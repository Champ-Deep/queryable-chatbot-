# Edge edition: both agents on the Cloudflare Workers Free plan

Date: 2026-11-24 · Status: approved (approach), in progress

## Why

The Python agents need Cloudflare Containers, which need Workers Paid. The account that hosts the demo is on the Free plan. The edge edition ports both agents to JavaScript so the whole demo runs on Workers Free. The Python implementation stays the reference (local runs, Docker, Containers on Paid).

## Platform facts that shape the design

| Limit (Free plan) | Value | Consequence |
|---|---|---|
| Worker CPU per request | 10 ms | The Worker only routes. All work happens in a Durable Object |
| Durable Object CPU per request | 30 s | Agent turns and the 41-conversation simulation run inside the DO |
| Durable Objects on Free | SQLite backend only | Query log, consents and audit live in DO SQLite (persistent) |
| Subrequests | 50 per request | The agents call each other **in-process** (no network subrequests) |

## Architecture

```
Browser / partner agent ──https──▶ Worker (edge/src/index.js)
                                      │  everything is forwarded to one instance
                                      ▼
                     Durable Object "ChampionsEdge" (getByName("main"))
                     ├── Champions Group Agent  (champions/*)  ← /lab, /.well-known, /a2a, /mcp, /oauth, /api/v1, /audit, /health
                     ├── Personal Agent         (personal/*)   ← /, /api/*
                     └── SQLite: query_log, consents, audit
```

- **One Durable Object instance** holds the generated synthetic data in memory (built once per DO start from a seeded PRNG) and all persistent state in its SQLite storage.
- **In-process HTTP:** the Personal Agent's Champions client calls the Champions handler as `handler(new Request(url, init)) → Response`. The requests are real `Request` objects with the same paths, headers and JSON bodies as over the network, so the Agent wire panel shows the same OAuth → Agent Card → A2A → MCP sequence. External agents use the same endpoints over HTTPS.
- **Pages:** the existing `personal/static/index.html` and `champions/static/lab.html` are imported as text modules (single source of truth; no copies). `/lab` and `/lab/api/*` require HTTP Basic login (user `admin`, Worker secret `LAB_PASSWORD`). Without the secret the Lab fails closed.

## Contracts to preserve (golden fixtures)

The JS port must keep the public contracts of the Python version, captured as JSON fixtures from the running Python agents (`edge/test/fixtures/`):

- Personal API used by the demo page: `GET /api/health`, `/api/personas`, `/api/scenarios`, `/api/profile/{persona}`; `POST /api/consent`; `DELETE /api/consent/{persona}/{purpose}`; `POST /api/chat`; `POST /api/simulate`; `GET /api/champions/audit`.
- Champions: `POST /oauth/token` (client credentials, scoped HS256 JWT, 5 min), `GET /.well-known/agent-card.json`, `POST /a2a` (JSON-RPC `SendMessage`, A2A 1.0 JSON shapes, data parts `champions.capability_request/v1` and `champions.feedback/v1`), `POST /mcp` (JSON-RPC `initialize`, `tools/list`, `tools/call` for the five tools), `/api/v1/*` (internal key), `GET /audit`, `GET /health`.
- Lab API used by the Lab page: `/lab/api/stats`, `/lab/api/recent`, `/lab/api/export.{csv,jsonl}`, `POST /lab/api/clear` (needs `X-Requested-With: lab`).

Behaviour that must hold, mirroring the Python tests:

- Consent before anything is sent, and only consented shareable fields go on the wire. Private fields (budget, notes, must-have fields, policy) never appear in any outbound request.
- OAuth scopes are enforced on A2A skills, MCP tools and `/audit`. The Agent Card is the only unauthenticated A2A surface. The REST API needs the internal key, and MCP tools call it with that key.
- Personalised insight ranking with `why_for_you` built only from shared fields. The usefulness judgement is private, and only `{insight_id, useful}` goes back over A2A.
- The query log records intent, gaps, latency and ratings. Partners only see their own query stats.
- When hosted, the published demo client secret is refused. The real one is the Worker secret `PERSONAL_AGENT_CLIENT_SECRET`.

Numbers differ from the Python version (different PRNG), but the shapes do not.

## Layout

```
edge/
  wrangler.jsonc        Worker champions-a2a, DO ChampionsEdge (SQLite), text-module rules for .html
  package.json          wrangler, test scripts
  src/index.js          Worker: forwards to the DO; 503 until secrets are set
  src/edge.js           Durable Object: builds both apps, owns SQLite
  src/common/           jwt.js (HS256 via WebCrypto), rng.js (seeded PRNG), http.js (tiny router, json helpers)
  src/champions/        catalog, data, matcher, insights, querylog, a2a, mcp, api, lab, app
  src/personal/         profile, planner, evaluator, judge, scenarios, client (+ wire), agent, simulator, app
  test/                 node --test suites + fixtures/ (golden shapes from Python)
```

## Testing

- `node --test edge/test` covers the unit and contract tests above, using an in-memory SQLite stand-in for DO storage.
- `wrangler dev` runs a local end-to-end check.
- After deploy, the live smoke test covers health, Agent Card, a consented chat turn (OAuth, Card, A2A, MCP), the Lab returning 401 without the password and 200 with it, and a simulation filling the Lab.
