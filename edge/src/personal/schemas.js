// JSON contracts the Personal Agent builds or reads (port of the parts of
// common/schemas.py it uses). Builders return plain objects with the same key
// order and defaults as the Pydantic models' model_dump(by_alias=True).

export const schemaId = (name) => `champions.${name}/v1`;

export function filters(f = {}) {
  return {
    industries: f.industries ?? [],
    regions: f.regions ?? [],
    countries: f.countries ?? [],
    size_bands: f.size_bands ?? [],
    intent_topics: f.intent_topics ?? [],
  };
}

export function userContext({ consent_id, purpose, shared = {} }) {
  return { schema: schemaId("user_context"), consent_id, purpose, shared };
}

export function capabilityRequest({ skill, need, filters: f, desired_outputs = [], context = null, source = "live" }) {
  return { schema: schemaId("capability_request"), skill, need, filters: filters(f), desired_outputs, context, source };
}

function cardMatch(m) {
  return {
    card_id: m.card_id,
    name: m.name,
    relevance: m.relevance,
    why: m.why,
    matched_fields: m.matched_fields ?? [],
    coverage_pct: m.coverage_pct,
    refresh: m.refresh,
    credits_per_1k_records: m.credits_per_1k_records,
    contains_personal_data: m.contains_personal_data ?? false,
  };
}

export function insight(i) {
  return {
    label: i.label,
    value: i.value,
    detail: i.detail ?? "",
    id: i.id ?? "",
    themes: i.themes ?? [],
    score: i.score ?? 0,
    why_for_you: i.why_for_you ?? "",
    evidence: i.evidence ?? "",
    follow_ups: i.follow_ups ?? [],
  };
}

/** CatalogResult from an A2A artifact's data part (defaults filled, canonical key order). */
export function catalogResult(d) {
  if (!d || !Array.isArray(d.matches) || typeof d.matching_companies !== "number") {
    throw new TypeError("not a champions.catalog_result/v1 payload");
  }
  return {
    schema: d.schema ?? schemaId("catalog_result"),
    matches: d.matches.map(cardMatch),
    matching_companies: d.matching_companies,
    insights: (d.insights ?? []).map(insight),
    sample: d.sample ?? [],
    method: d.method ?? "",
    consent_id: d.consent_id ?? null,
    query_id: d.query_id ?? null,
    personalised_for: d.personalised_for ?? [],
    gaps: d.gaps ?? [],
  };
}

/** Personal Agent -> Champions: which insights were useful. Ratings only, never reasons. */
export function feedback(queryId, ratings) {
  return {
    schema: schemaId("feedback"),
    query_id: queryId,
    ratings: Object.entries(ratings).map(([insight_id, useful]) => ({ insight_id, useful })),
  };
}

export function recommendation({ summary, options, bundle, bundle_monthly_credits, within_budget }) {
  return { schema: schemaId("recommendation"), summary, options, bundle, bundle_monthly_credits, within_budget };
}

// ------------------------------------------------- Python number formatting

/** str(float) for a value Pydantic typed as float: 95 -> "95.0", 61.8 -> "61.8". */
export function pyFloat(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** round(x, n) with Python's half-to-even on ties. */
export function pyRound(x, n = 0) {
  const m = 10 ** n;
  const y = x * m;
  const floor = Math.floor(y);
  const diff = y - floor;
  let r;
  if (diff > 0.5) r = floor + 1;
  else if (diff < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / m;
}
