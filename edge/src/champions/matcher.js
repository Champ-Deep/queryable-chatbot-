// Turns a CapabilityRequest into a CatalogResult: which cards fit, and what the data says
// (port of champions/matcher.py). Deterministic (keyword and filter based), so the demo gives
// the same answer every time and needs no LLM.

import { BY_ID, CARDS, cardCoverage } from "./catalog.js";
import { N_COMPANIES, avg, groupCount, median, where } from "./data.js";
import { insight, personalised, segmentOf } from "./insights.js";
import { grouped, pct, pyFloat, round } from "./pyfmt.js";

// Words in the need that point at each card, with the fields they touch.
const SIGNALS = [
  ["technographics",
    /\b(tech|technolog\w*|platform\w*|stack|crm|erp|cloud|hris|hcm|software|using|installed|workday|sap|salesforce)\b/g,
    ["hr_platform", "crm", "erp", "cloud_provider"]],
  ["intent_signals",
    /\b(switch\w*|replac\w*|migrat\w*|in[- ]market|intent|buying|evaluat\w*|looking for|research\w*|surge|moving)\b/g,
    ["intent_topic", "intent_score", "surge_start"]],
  ["hr_tech_spend",
    /\b(budget\w*|spend\w*|renewal\w*|contract\w*|hr tech|deal size|wallet)\b/g,
    ["annual_hr_tech_spend_usd", "contract_renewal_window"]],
  ["financials",
    /\b(revenue|growth|funding|funded|financ\w*|profit\w*|series [a-e])\b/g,
    ["revenue_usd_m", "revenue_growth_pct", "funding_stage"]],
  ["contacts",
    /\b(contacts?|emails?|decision[- ]makers?|people to|reach out|outreach|leads?|personas?|buyers?)\b/g,
    ["job_title", "seniority", "business_email"]],
];

export const SCHEMA_CATALOG_RESULT = "champions.catalog_result/v1";

/** A CardMatch with the Python model's key order. */
function cardMatch(cardId, relevance, why, fields) {
  const card = BY_ID[cardId];
  return {
    card_id: card.id,
    name: card.name,
    relevance: round(Math.min(relevance, 1.0), 2),
    why,
    matched_fields: fields,
    coverage_pct: cardCoverage(card),
    refresh: card.refresh,
    credits_per_1k_records: card.credits_per_1k_records,
    contains_personal_data: card.contains_personal_data,
  };
}

export function matchCards(need, filters, desiredOutputs) {
  const text = (need || "").toLowerCase();
  const matches = [];

  // Firmographics define the segment, so any segment filter makes it core.
  const segment = [
    ["industry", filters.industries],
    ["region", filters.regions.length ? filters.regions : filters.countries],
    ["size_band", filters.size_bands],
  ].filter(([, values]) => values.length).map(([name]) => name);
  matches.push(cardMatch(
    "firmographics", segment.length ? 0.95 : 0.6,
    "Defines the target segment" + (segment.length ? ` (${segment.join(", ")})` : ""),
    segment.length ? segment : ["company_name", "industry", "hq_country"],
  ));

  for (const [cardId, pattern, fields] of SIGNALS) {
    const hits = [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort();
    const asked = desiredOutputs.includes(cardId);
    if (cardId === "intent_signals" && filters.intent_topics.length) hits.push("topic filter");
    if (hits.length || asked) {
      const relevance = 0.55 + 0.15 * Math.min(hits.length, 3) + (asked ? 0.2 : 0);
      const reason = hits.length ? `Request mentions ${hits.join(", ")}` : "Requested output";
      matches.push(cardMatch(cardId, relevance, reason, fields));
    }
  }
  return matches.sort((a, b) => b.relevance - a.relevance); // stable, like Python's sorted
}

/**
 * [segment size, insights, sample] for a segment. Intent topics describe what the buyer is
 * looking *for* inside a segment, so they are reported as a share of the segment rather than
 * used as a filter (filtering on them would make "showing intent" always 100%).
 */
export function insightsFor(companies, filters) {
  const topics = [...filters.intent_topics];
  const rows = where(companies, segmentOf(filters));
  const total = rows.length;
  if (!total) return [0, [insight({ label: "Matching companies", value: 0, detail: "No companies match these filters." })], []];

  const out = [insight({ label: "Matching companies", value: total })];
  for (const topic of topics) {
    const on = rows.filter((r) => r.intent_topic === topic);
    out.push(insight({
      label: `Researching ${topic}`, value: on.length,
      detail: on.length
        ? `${pyFloat(pct(on.length, total))}% of the segment, average surge score ${round(avg(on.map((r) => r.intent_score))).toFixed(0)}`
        : "No surge on this topic in the segment",
    }));
  }
  const inMarket = rows.filter((r) => r.intent_topic !== null).length;
  out.push(insight({ label: "Showing any buying intent", value: `${pyFloat(pct(inMarket, total))}%` }));
  out.push(insight({ label: "Top countries", value: groupCount(rows, "hq_country", 3).map(([c, n]) => `${c} (${n})`).join(", ") }));
  out.push(insight({ label: "Size mix", value: groupCount(rows, "size_band").map(([s, n]) => `${s} ${pyFloat(pct(n, total))}%`).join(", ") }));
  out.push(insight({ label: "Most common HR platforms", value: groupCount(rows, "hr_platform", 3).map(([p, n]) => `${p} (${n})`).join(", ") }));
  out.push(insight({ label: "Median HR tech spend", value: `$${grouped(median(rows.map((r) => r.annual_hr_tech_spend_usd)))}` }));

  // Sample: companies on the requested topic first, strongest surge first.
  const topicRank = (r) => (r.intent_topic === null ? 2 : topics.includes(r.intent_topic) ? 0 : 1);
  const sample = [...rows]
    .sort((a, b) => topicRank(a) - topicRank(b) || (b.intent_score ?? 0) - (a.intent_score ?? 0) ||
      (a.company_id < b.company_id ? -1 : 1))
    .slice(0, 5)
    .map((r) => ({
      company_name: r.company_name, hq_country: r.hq_country, size_band: r.size_band,
      hr_platform: r.hr_platform, intent_topic: r.intent_topic || "-",
    }));
  return [total, out, sample];
}

/** A CatalogResult with the Python model's defaults and key order. */
export function catalogResult(fields) {
  return {
    schema: SCHEMA_CATALOG_RESULT,
    matches: fields.matches,
    matching_companies: fields.matching_companies,
    insights: fields.insights ?? [],
    sample: fields.sample ?? [],
    method: fields.method,
    consent_id: fields.consent_id ?? null,
    query_id: fields.query_id ?? null,
    personalised_for: fields.personalised_for ?? [],
    gaps: fields.gaps ?? [],
  };
}

/** Catalog overview for "what can Champions do?". */
export function capabilities(companies) {
  return catalogResult({
    matches: CARDS.map((c) => cardMatch(c.id, 0.5, c.description, c.vaf_fields.slice(0, 4).map((x) => x.name))),
    matching_companies: companies.length,
    insights: [
      insight({ label: "Data cards", value: CARDS.length }),
      insight({ label: "VAF fields", value: CARDS.reduce((s, c) => s + c.vaf_fields.length, 0) }),
    ],
    method: "Full catalog listing",
  });
}

/** The CatalogResult for a (validated) CapabilityRequest. */
export function answer(companies, request) {
  let result;
  if (request.skill === "describe_capabilities") {
    result = capabilities(companies);
  } else {
    const matches = matchCards(request.need, request.filters, request.desired_outputs);
    const shared = request.context ? request.context.shared : {};
    const [total, , sample] = insightsFor(companies, request.filters);
    const ranked = personalised(companies, request.filters, request.need, shared,
      request.skill === "find_data_cards" ? 3 : 6);
    result = catalogResult({
      matches,
      matching_companies: total,
      insights: ranked,
      sample: request.skill === "find_data_cards" ? [] : sample,
      personalised_for: Object.keys(shared).filter((k) => ["role", "goals", "industry"].includes(k)).sort(),
      method: "Keyword and filter match over the catalog; insights ranked for the shared role, goals " +
        `and industry; aggregates over ${N_COMPANIES} synthetic companies. No records exported.`,
    });
  }
  if (request.context) result.consent_id = request.context.consent_id;
  return result;
}
