"""Scores what Champions offered against the user's private profile.

Runs inside the Personal Agent, so budget, must-have fields and compliance
policy are used here and never sent anywhere.

score (0-100) = relevance 45 + coverage 15 + freshness 15 + cost 15 + must-haves 10
"""

import math

from common.schemas import RankedOption, Recommendation

FRESHNESS_RANK = {"daily": 4, "weekly": 3, "monthly": 2, "quarterly": 1}
DELIVERIES_PER_MONTH = {"daily": 4, "weekly": 4, "monthly": 1, "quarterly": 1 / 3}
MIN_ORDER_RECORDS = 1000


def monthly_credits(match, matching_companies):
    records = max(matching_companies, MIN_ORDER_RECORDS)
    return math.ceil(match.credits_per_1k_records * records / 1000 * DELIVERIES_PER_MONTH[match.refresh])


def _freshness_score(card_refresh, wanted):
    have, need = FRESHNESS_RANK[card_refresh], FRESHNESS_RANK.get(wanted, 1)
    return 1.0 if have >= need else max(0.0, 1 - 0.4 * (need - have))


def evaluate(catalog, profile, vaf_details=None):
    """Recommendation for a CatalogResult. ``vaf_details``: {card_id: [field names]}."""

    budget = profile.get("budget_monthly_credits", 0)
    must_have = set(profile.get("must_have_fields", []))
    vaf_details = vaf_details or {}
    options = []

    for match in catalog.matches:
        credits = monthly_credits(match, catalog.matching_companies)
        reasons = [f"Champions: {match.why.lower()} (relevance {match.relevance:.2f})"]

        fresh = _freshness_score(match.refresh, profile.get("freshness"))
        # Affordability only; the bundle step below enforces the total budget.
        cost = 1.0 if credits <= budget else 0.0
        fields = set(vaf_details.get(match.card_id, match.matched_fields))
        covered = must_have & fields
        must = len(covered) / len(must_have) if must_have else 0.0

        score = round(45 * match.relevance + 15 * match.coverage_pct / 100 + 15 * fresh + 15 * cost + 10 * must, 1)

        reasons.append(f"Average field coverage {match.coverage_pct}%, refreshed {match.refresh}")
        if fresh < 1:
            reasons.append(f"Slower than the {profile.get('freshness')} refresh you need")
        reasons.append(
            f"About {credits} credits/month"
            + (" (fits your budget)" if credits <= budget else " (over your monthly budget)"))
        if covered:
            reasons.append(f"Has your must-have field(s): {', '.join(sorted(covered))}")

        verdict = "recommended" if score >= 62 else "optional" if score >= 45 else "not_recommended"
        if match.contains_personal_data and profile.get("compliance") == "gdpr_strict":
            verdict = "not_recommended"
            reasons.append("Contains personal data: your GDPR-strict policy needs a DPA and a "
                           "lawful basis before buying contacts")
        options.append(RankedOption(
            card_id=match.card_id, name=match.name, score=score, verdict=verdict,
            reasons=reasons, est_monthly_credits=credits))

    options.sort(key=lambda o: o.score, reverse=True)

    bundle, spent = [], 0
    for option in options:
        if option.verdict == "recommended" and spent + option.est_monthly_credits <= budget:
            bundle.append(option.card_id)
            spent += option.est_monthly_credits
        elif option.verdict == "recommended":
            option.verdict = "optional"
            option.reasons.append("Left out of the bundle to stay within budget")

    names = [o.name for o in options if o.card_id in bundle]
    if names:
        left = budget - spent
        room = (f"uses your full {budget}-credit budget" if left == 0
                else f"{left} under your {budget}-credit budget")
        summary = f"Buy {' + '.join(names)} for about {spent} credits/month ({room})."
    else:
        summary = "Nothing fits both the need and your budget; see the optional cards."
    return Recommendation(
        summary=summary, options=options, bundle=bundle,
        bundle_monthly_credits=spent, within_budget=spent <= budget)
