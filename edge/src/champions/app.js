/**
 * Champions Group Agent, JavaScript edition (port of champions/app.py).
 *
 *   GET  /.well-known/agent-card.json   A2A Agent Card (public)
 *   POST /oauth/token                   OAuth2 client credentials -> scoped JWT
 *   POST /a2a                           A2A JSON-RPC (SendMessage, GetTask)        [Bearer]
 *   POST /mcp                           MCP Streamable HTTP, stateless JSON         [Bearer]
 *   GET  /audit                         this client's audit entries                [Bearer, audit:read]
 *   *    /api/v1/...                    REST API that the MCP tools wrap            [X-API-Key, internal]
 *   GET  /lab                           Agent Lab                                   [HTTP Basic]
 *   GET  /health
 */
import { HttpError, Router, error, json, readForm } from "../common/http.js";
import { createA2a, agentCard } from "./a2a.js";
import { createApi, answer, recordFeedback } from "./api.js";
import { AuthError, createAuth, requireScope } from "./auth.js";
import { CARDS } from "./catalog.js";
import { generateCompanies } from "./data.js";
import { createLab } from "./lab.js";
import { createMcp } from "./mcp.js";
import { QueryLog } from "./querylog.js";

const PROTECTED = ["/a2a", "/mcp", "/audit"];
const AUDIT_LIMIT = 500;

let companiesCache = null;

/** Audit trail in SQLite (survives Durable Object restarts); keeps the latest AUDIT_LIMIT entries. */
function createAudit(db) {
  db.run("CREATE TABLE IF NOT EXISTS champions_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, entry TEXT)");
  return {
    add(claims, event, fields) {
      const entry = { at: new Date().toISOString().slice(0, 19), client: claims?.sub ?? null, event, ...fields };
      const subject = entry.client ?? entry.client_id ?? "";
      db.run("INSERT INTO champions_audit (subject, entry) VALUES (?, ?)", subject, JSON.stringify(entry));
      db.run(`DELETE FROM champions_audit WHERE id <= (SELECT max(id) FROM champions_audit) - ${AUDIT_LIMIT}`);
      return entry;
    },
    mine(sub, limit = 50) {
      return db.all("SELECT entry FROM champions_audit WHERE subject = ? ORDER BY id DESC LIMIT ?", sub, limit)
        .map((r) => JSON.parse(r.entry)).reverse();
    },
  };
}

function formErrors(form, names) {
  return names.filter((n) => form[n] === undefined)
    .map((n) => ({ type: "missing", loc: ["body", n], msg: "Field required", input: null }));
}

/**
 * @param db     {all, one, run} SQLite access
 * @param pages  {lab: "<html>"}
 * @param config {publicUrl, labPassword, clients: {id: secret}, hosted, signingKey?, apiKey?}
 */
export function createChampions({ db, pages, config }) {
  const publicUrl = String(config.publicUrl).replace(/\/+$/, "");
  companiesCache ??= generateCompanies();
  const companies = companiesCache;
  const log = new QueryLog(db);
  const audit = createAudit(db);
  const auth = createAuth({ clients: config.clients, hosted: config.hosted, signingKey: config.signingKey, apiKey: config.apiKey });
  const api = createApi({ companies, log, apiKey: auth.apiKey });
  const apiFetch = async (request) => {
    try {
      return (await api.fetch(request)) ?? error(404, "Not Found");
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.detail, err.headers);
      throw err;
    }
  };
  const a2a = createA2a({
    answer: (request, client) => answer(companies, log, request, { channel: "a2a", client }),
    feedback: (fb, client) => recordFeedback(log, fb, client),
    audit: audit.add,
  });
  const mcp = createMcp({ api: apiFetch, apiKey: auth.apiKey, audit: audit.add, publicUrl });
  const lab = createLab({ log, page: pages.lab, password: config.labPassword });
  const card = agentCard(publicUrl);

  const router = new Router();
  router
    .get("/health", () => ({ status: "ok", agent: "champions", cards: CARDS.length }))
    .get("/.well-known/agent-card.json", () => card)
    .post("/oauth/token", async (request) => {
      const form = await readForm(request);
      const missing = formErrors(form, ["grant_type", "client_id", "client_secret"]);
      if (missing.length) throw new HttpError(422, missing);
      if (form.grant_type !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400);
      try {
        const issued = await auth.issueToken(form.client_id, form.client_secret, form.scope ?? "");
        audit.add(null, "oauth.token_issued", { client_id: form.client_id, scope: issued.scope });
        return issued;
      } catch (err) {
        if (err instanceof AuthError) return json({ error: err.message }, err.status);
        throw err;
      }
    })
    .post("/a2a", async (request, _p, _u, claims) => {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return json({ error: { code: -32700, message: "Parse error" }, id: null, jsonrpc: "2.0" });
      }
      return a2a(body, claims);
    })
    .post("/mcp", async (request, _p, _u, claims) => {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const out = await mcp(body, claims);
      return out === null ? new Response(null, { status: 202 }) : json(out);
    })
    .get("/mcp", () => error(405, "Method Not Allowed"))
    .get("/audit", (_r, _p, _u, claims) => {
      try {
        requireScope(claims, "audit:read");
      } catch (err) {
        if (err instanceof AuthError) return json({ error: err.message }, err.status);
        throw err;
      }
      return { entries: audit.mine(claims.sub) };
    });

  async function handle(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/lab" || pathname.startsWith("/lab/")) return lab.fetch(request);
    if (pathname.startsWith("/api/v1/")) return apiFetch(request);

    let claims = null;
    if (PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      try {
        claims = await auth.verifyHeader(request.headers.get("authorization"));
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        return json({ error: "unauthorized", detail: err.message }, err.status,
          { "WWW-Authenticate": 'Bearer realm="champions", error="invalid_token"' });
      }
    }
    return router.handle(request, claims);
  }

  return {
    log,
    async fetch(request) {
      try {
        return (await handle(request)) ?? error(404, "Not Found");
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.detail, err.headers);
        console.error("Champions agent error", err);
        return error(500, "Internal Server Error");
      }
    },
  };
}
