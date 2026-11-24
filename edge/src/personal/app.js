// Personal Agent web app: the demo page plus its JSON API.
// Port of personal/app.py (routes, validation errors and status codes).
import { HttpError, Router, error, html } from "../common/http.js";
import { runTurn } from "./agent.js";
import { ChampionsClient, ChampionsError, Wire } from "./client.js";
import { ConsentError, ConsentStore, FIELDS, PERSONAS, PURPOSES, getProfile, isPersona } from "./profile.js";
import { SCENARIOS } from "./scenarios.js";
import * as simulator from "./simulator.js";

// ------------------------------------------- FastAPI/Pydantic-style validation

function invalid(errors) {
  return new HttpError(422, errors);
}

/** Parses a JSON body like FastAPI: 422 with a Pydantic error list on bad input. */
async function readBody(request, spec) {
  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw invalid([{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {}, ctx: { error: String(err.message) } }]);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid([{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  const errors = [];
  for (const [name, type] of Object.entries(spec)) {
    if (!(name in body)) {
      errors.push({ type: "missing", loc: ["body", name], msg: "Field required", input: body });
    } else if (type === "str" && typeof body[name] !== "string") {
      errors.push({ type: "string_type", loc: ["body", name], msg: "Input should be a valid string", input: body[name] });
    } else if (type === "list[str]") {
      if (!Array.isArray(body[name])) {
        errors.push({ type: "list_type", loc: ["body", name], msg: "Input should be a valid list", input: body[name] });
      } else {
        body[name].forEach((v, i) => {
          if (typeof v !== "string") errors.push({ type: "string_type", loc: ["body", name, i], msg: "Input should be a valid string", input: v });
        });
      }
    }
  }
  if (errors.length) throw invalid(errors);
  return body;
}

function persona(name) {
  if (!isPersona(name)) throw new HttpError(404, `unknown persona ${name}`);
  return name;
}

// ---------------------------------------------------------------------- app

/**
 * @param db        {all, one, run} SQLite access (Durable Object storage or memoryDb)
 * @param pages     {index: "<html>"}
 * @param champions async (Request) => Response, the Champions agent in-process
 * @param config    {championsBase, clientId, clientSecret}
 */
export function createPersonal({ db, pages, champions, config }) {
  const consents = new ConsentStore(db);
  const deps = { champions, config };
  let simulating = false;

  const router = new Router()
    .get("/", () => html(pages.index))

    .get("/api/personas", () => Object.entries(PERSONAS).map(([id, v]) => ({ id, display: v.display, role: v.role })))

    .get("/api/scenarios", () => SCENARIOS)

    // Run every persona's questions through the real A2A path; returns the report.
    // (Python also writes reports/simulation.md; there is no file system here.)
    .post("/api/simulate", async () => {
      if (simulating) throw new HttpError(409, "a simulation is already running");
      simulating = true;
      try {
        return await simulator.run(deps);
      } catch (err) {
        if (err instanceof ChampionsError) throw new HttpError(502, `Champions unavailable: ${err.message}`);
        throw err;
      } finally {
        simulating = false;
      }
    })

    .get("/api/profile/{persona}", (_req, params) => {
      const name = persona(params.persona);
      return {
        profile: getProfile(name),
        fields: Object.entries(FIELDS).map(([n, [cls, label]]) => ({ name: n, label, class: cls })),
        consents: consents.allFor(name),
        purposes: PURPOSES,
      };
    })

    .post("/api/consent", async (request) => {
      const body = await readBody(request, { persona: "str", purpose: "str", fields: "list[str]" });
      try {
        return consents.grant(persona(body.persona), body.purpose, body.fields);
      } catch (err) {
        if (err instanceof ConsentError) throw new HttpError(400, err.message);
        throw err;
      }
    })

    .delete("/api/consent/{persona}/{purpose}", (_req, params) => ({
      revoked: consents.revoke(persona(params.persona), params.purpose),
    }))

    .post("/api/chat", async (request) => {
      const body = await readBody(request, { persona: "str", message: "str" });
      if (!body.message.trim()) throw new HttpError(400, "empty message");
      return runTurn(persona(body.persona), body.message.slice(0, 1000), consents, deps);
    })

    // What Champions recorded about this client (its own audit view).
    .get("/api/champions/audit", async () => {
      try {
        return { entries: await new ChampionsClient(new Wire(), champions, config).audit() };
      } catch (err) {
        if (err instanceof ChampionsError) throw new HttpError(502, `Champions unavailable: ${err.message}`);
        throw err;
      }
    })

    .get("/api/health", async () => {
      let status;
      try {
        const base = String(config.championsBase).replace(/\/+$/, "");
        status = await (await champions(new Request(`${base}/health`))).json();
      } catch {
        status = { status: "unavailable" };
      }
      return { status: "ok", agent: "personal", champions: status };
    });

  return {
    async fetch(request) {
      return (await router.handle(request)) ?? error(404, "Not Found");
    },
  };
}
