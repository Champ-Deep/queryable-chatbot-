// Champions REST API (/api/v1): the plain endpoints the MCP server wraps. Port of champions/api.py
// and champions/service.py.
//
// Protected by an internal API key (X-API-Key). Partner agents never get this key: they reach
// the same functions through A2A or MCP with their own OAuth token, and Champions' MCP server
// calls this API on their behalf (in-process here).
import { HttpError, Router, readJson, safeEqual } from "../common/http.js";
import { BY_ID, CARDS } from "./catalog.js";
import { answer as matcherAnswer } from "./matcher.js";
import { gaps } from "./querylog.js";
import { ValidationError, capabilityRequest, feedback as feedbackSchema } from "./schemas.js";

/** Answers a validated capability request and logs it, whichever door it came through. */
export function answer(companies, log, request, { channel, client }) {
  const started = performance.now();
  const result = matcherAnswer(companies, request);
  const shared = request.context ? request.context.shared : {};
  result.gaps = gaps(request, result.matching_companies);
  result.query_id = log.record(request, {
    channel, client, shared,
    cards: result.matches.map((m) => m.card_id),
    insightIds: result.insights.map((i) => i.id).filter(Boolean),
    matching: result.matching_companies,
    latencyMs: performance.now() - started,
  });
  return result;
}

/** Stores ratings on one of client's own queries; how many were recorded, or null. */
export function recordFeedback(log, fb, client) {
  const ratings = Object.fromEntries(fb.ratings.map((r) => [r.insight_id, r.useful]));
  return log.addFeedback(fb.query_id, ratings, client) ? Object.keys(ratings).length : null;
}

export function cardList() {
  return CARDS.map((c) => ({
    id: c.id, name: c.name, description: c.description, refresh: c.refresh,
    credits_per_1k_records: c.credits_per_1k_records, vaf_field_count: c.vaf_fields.length,
    contains_personal_data: c.contains_personal_data,
  }));
}

export function unknownCard(cardId) {
  return `Unknown card_id '${cardId}'. Known: ${Object.keys(BY_ID).join(", ")}`;
}

export function cardFields(cardId) {
  const card = Object.hasOwn(BY_ID, cardId) ? BY_ID[cardId] : null;
  if (!card) throw new HttpError(404, unknownCard(cardId));
  return { card_id: card.id, name: card.name, vaf_fields: card.vaf_fields };
}

function validated(parse, body) {
  try {
    return parse(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new HttpError(422, err.errors.map((e) => ({ ...e, loc: ["body", ...e.loc] })));
    }
    throw err;
  }
}

export function createApi({ companies, log, apiKey }) {
  const who = (request) => [
    request.headers.get("x-champions-channel") || "rest",
    request.headers.get("x-on-behalf-of") || "internal",
  ];
  const router = new Router();
  const ask = async (request, skill) => {
    const body = validated(capabilityRequest, await readJson(request));
    const [channel, client] = who(request);
    return answer(companies, log, { ...body, skill }, { channel, client });
  };

  router
    .get("/api/v1/cards", () => cardList())
    .get("/api/v1/cards/{card_id}/fields", (_r, { card_id }) => cardFields(card_id))
    .post("/api/v1/search", (request) => ask(request, "find_data_cards"))
    .post("/api/v1/insights", (request) => ask(request, "get_insights"))
    .post("/api/v1/feedback", async (request) => {
      const fb = validated(feedbackSchema, await readJson(request));
      const recorded = recordFeedback(log, fb, who(request)[1]);
      if (recorded === null) throw new HttpError(404, `unknown query_id ${fb.query_id}`);
      return { recorded };
    })
    .get("/api/v1/query-stats", (request, _p, url) => {
      // Called on behalf of a partner: only that partner's queries, whatever ?client= says.
      const onBehalf = who(request)[1];
      return log.stats(onBehalf !== "internal" ? onBehalf : url.searchParams.get("client"));
    });

  return {
    async fetch(request) {
      if (!safeEqual(request.headers.get("x-api-key") ?? "", apiKey)) {
        throw new HttpError(401, "missing or invalid X-API-Key");
      }
      return router.handle(request);
    },
  };
}
