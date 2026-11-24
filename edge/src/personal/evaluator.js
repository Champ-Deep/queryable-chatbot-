// Scores what Champions offered against the user's private profile.
// Port of personal/evaluator.py.
//
// Runs inside the Personal Agent, so budget, must-have fields and compliance
// policy are used here and never sent anywhere.
//
// score (0-100) = relevance 45 + coverage 15 + freshness 15 + cost 15 + must-haves 10
import { pyFloat, pyRound, recommendation } from "./schemas.js";

const FRESHNESS_RANK = { daily: 4, weekly: 3, monthly: 2, quarterly: 1 };
const DELIVERIES_PER_MONTH = { daily: 4, weekly: 4, monthly: 1, quarterly: 1 / 3 };
const MIN_ORDER_RECORDS = 1000;

export function monthlyCredits(match, matchingCompanies) {
  const records = Math.max(matchingCompanies, MIN_ORDER_RECORDS);
  return Math.ceil(((match.credits_per_1k_records * records) / 1000) * DELIVERIES_PER_MONTH[match.refresh]);
}

function freshnessScore(cardRefresh, wanted) {
  const have = FRESHNESS_RANK[cardRefresh];
  const need = FRESHNESS_RANK[wanted] ?? 1;
  return have >= need ? 1.0 : Math.max(0.0, 1 - 0.4 * (need - have));
}

/** Recommendation for a CatalogResult. vafDetails: {card_id: [field names]}. */
export function evaluate(catalog, profile, vafDetails = {}) {
  const budget = profile.budget_monthly_credits ?? 0;
  const mustHave = new Set(profile.must_have_fields ?? []);
  const options = [];

  for (const match of catalog.matches) {
    const credits = monthlyCredits(match, catalog.matching_companies);
    const reasons = [`Champions: ${match.why.toLowerCase()} (relevance ${match.relevance.toFixed(2)})`];

    const fresh = freshnessScore(match.refresh, profile.freshness);
    // Affordability only; the bundle step below enforces the total budget.
    const cost = credits <= budget ? 1.0 : 0.0;
    const fields = new Set(vafDetails[match.card_id] ?? match.matched_fields);
    const covered = [...mustHave].filter((f) => fields.has(f));
    const must = mustHave.size ? covered.length / mustHave.size : 0.0;

    const score = pyRound(45 * match.relevance + (15 * match.coverage_pct) / 100 + 15 * fresh + 15 * cost + 10 * must, 1);

    reasons.push(`Average field coverage ${pyFloat(match.coverage_pct)}%, refreshed ${match.refresh}`);
    if (fresh < 1) reasons.push(`Slower than the ${profile.freshness} refresh you need`);
    reasons.push(`About ${credits} credits/month` + (credits <= budget ? " (fits your budget)" : " (over your monthly budget)"));
    if (covered.length) reasons.push(`Has your must-have field(s): ${covered.sort().join(", ")}`);

    let verdict = score >= 62 ? "recommended" : score >= 45 ? "optional" : "not_recommended";
    if (match.contains_personal_data && profile.compliance === "gdpr_strict") {
      verdict = "not_recommended";
      reasons.push("Contains personal data: your GDPR-strict policy needs a DPA and a lawful basis before buying contacts");
    }
    options.push({ card_id: match.card_id, name: match.name, score, verdict, reasons, est_monthly_credits: credits });
  }

  options.sort((a, b) => b.score - a.score); // stable, like Python's sort

  const bundle = [];
  let spent = 0;
  for (const option of options) {
    if (option.verdict === "recommended" && spent + option.est_monthly_credits <= budget) {
      bundle.push(option.card_id);
      spent += option.est_monthly_credits;
    } else if (option.verdict === "recommended") {
      option.verdict = "optional";
      option.reasons.push("Left out of the bundle to stay within budget");
    }
  }

  const names = options.filter((o) => bundle.includes(o.card_id)).map((o) => o.name);
  let summary;
  if (names.length) {
    const left = budget - spent;
    const room = left === 0 ? `uses your full ${budget}-credit budget` : `${left} under your ${budget}-credit budget`;
    summary = `Buy ${names.join(" + ")} for about ${spent} credits/month (${room}).`;
  } else {
    summary = "Nothing fits both the need and your budget; see the optional cards.";
  }
  return recommendation({ summary, options, bundle, bundle_monthly_credits: spent, within_budget: spent <= budget });
}
