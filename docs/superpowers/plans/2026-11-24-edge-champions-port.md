# Plan: finish the edge edition (Champions side) and deploy

Spec: `docs/design/edge-edition.md` (approved). The Personal Agent, data, matcher,
insights, query log and schemas are already ported. Missing: everything
`edge/src/edge.js` needs from `./champions/app.js`.

## Tasks

1. **Tests first** — `edge/test/champions_app.test.js` against `createChampions`:
   health; Agent Card (fixture shape, public URL); OAuth (issue, wrong secret,
   bad grant, bad scope, demo secret refused when hosted); bearer guard on
   `/a2a`, `/mcp`, `/audit` (fixture `a2a_no_token`); A2A get_insights,
   describe_capabilities, feedback (own query only), invalid payload, scope
   failure; MCP initialize / tools/list (fixtures) / each tool / unknown card
   (fixture `mcp_call_bad_card`) / insights scope; REST `/api/v1` needs the
   internal key; Lab 401 without password, 200 with, fails closed without one,
   clear needs `X-Requested-With: lab`; audit shows only the caller's entries.
2. **`src/champions/auth.js`** — clients, issue/verify HS256 tokens, scopes.
3. **`src/champions/a2a.js`** — Agent Card + JSON-RPC `SendMessage` with A2A 1.0
   JSON task shapes (completed / failed).
4. **`src/champions/mcp.js`** — stateless JSON-RPC: initialize, tools/list
   (schemas from the fixture), tools/call wrapping the REST handlers in-process.
5. **`src/champions/api.js`, `lab.js`, `app.js`** — REST, Lab (Basic login), audit
   (SQLite), `createChampions({db, pages, config})`.
6. **End-to-end** — `edge.test.js`: `createAgents` with the real Champions; a
   consented chat turn and a simulation fill the Lab.
7. **Verify** — `npm test`, `wrangler deploy --dry-run`, `wrangler dev` smoke.
8. **Ship** — commit, pull the remote commit, push to `Champ-Deep/queryable-chatbot-`,
   set secrets, `wrangler deploy` to the Free account, live smoke test.
