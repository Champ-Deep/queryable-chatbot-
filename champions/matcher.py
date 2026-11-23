"""Turns a CapabilityRequest into a CatalogResult: which cards fit, and what
the data says. Deterministic (keyword and filter based), so the demo gives
the same answer every time and needs no LLM.
"""

import re

from champions import data, insights as insight_engine
from champions.catalog import BY_ID, CARDS, card_coverage
from common.schemas import CardMatch, CatalogResult, Filters, Insight

# Words in the need that point at each card, with the fields they touch.
SIGNALS = {
    "technographics": (
        r"\b(tech|technolog\w*|platform\w*|stack|crm|erp|cloud|hris|hcm|software|using|installed|workday|sap|salesforce)\b",
        ["hr_platform", "crm", "erp", "cloud_provider"],
    ),
    "intent_signals": (
        r"\b(switch\w*|replac\w*|migrat\w*|in[- ]market|intent|buying|evaluat\w*|looking for|research\w*|surge|moving)\b",
        ["intent_topic", "intent_score", "surge_start"],
    ),
    "hr_tech_spend": (
        r"\b(budget\w*|spend\w*|renewal\w*|contract\w*|hr tech|deal size|wallet)\b",
        ["annual_hr_tech_spend_usd", "contract_renewal_window"],
    ),
    "financials": (
        r"\b(revenue|growth|funding|funded|financ\w*|profit\w*|series [a-e])\b",
        ["revenue_usd_m", "revenue_growth_pct", "funding_stage"],
    ),
    "contacts": (
        r"\b(contacts?|emails?|decision[- ]makers?|people to|reach out|outreach|leads?|personas?|buyers?)\b",
        ["job_title", "seniority", "business_email"],
    ),
}


def _match(card_id, relevance, why, fields):
    card = BY_ID[card_id]
    return CardMatch(
        card_id=card.id,
        name=card.name,
        relevance=round(min(relevance, 1.0), 2),
        why=why,
        matched_fields=fields,
        coverage_pct=card_coverage(card),
        refresh=card.refresh,
        credits_per_1k_records=card.credits_per_1k_records,
        contains_personal_data=card.contains_personal_data,
    )


def match_cards(need, filters, desired_outputs):
    text = (need or "").lower()
    matches = {}

    # Firmographics define the segment, so any segment filter makes it core.
    segment = [name for name, values in (
        ("industry", filters.industries), ("region", filters.regions or filters.countries),
        ("size_band", filters.size_bands)) if values]
    matches["firmographics"] = _match(
        "firmographics", 0.95 if segment else 0.6,
        "Defines the target segment" + (f" ({', '.join(segment)})" if segment else ""),
        segment or ["company_name", "industry", "hq_country"],
    )

    for card_id, (pattern, fields) in SIGNALS.items():
        hits = sorted(set(re.findall(pattern, text)))
        asked = card_id in desired_outputs
        if card_id == "intent_signals" and filters.intent_topics:
            hits.append("topic filter")
        if hits or asked:
            relevance = 0.55 + 0.15 * min(len(hits), 3) + (0.2 if asked else 0)
            reason = f"Request mentions {', '.join(hits)}" if hits else "Requested output"
            matches[card_id] = _match(card_id, relevance, reason, fields)

    return sorted(matches.values(), key=lambda m: m.relevance, reverse=True)


def _pct(part, whole):
    return round(100 * part / whole, 1) if whole else 0.0


def insights_for(filters):
    """(segment size, insights, sample) for a segment.

    Intent topics describe what the buyer is looking *for* inside a segment,
    so they are reported as a share of the segment rather than used as a
    filter (filtering on them would make "showing intent" always 100%).
    """

    topics = list(filters.intent_topics)
    segment = filters.model_copy(update={"intent_topics": []})
    total = data.query("SELECT count(*) FROM companies{where}", segment)[0][0]
    if not total:
        return 0, [Insight(label="Matching companies", value=0, detail="No companies match these filters.")], []

    insights = [Insight(label="Matching companies", value=total)]

    for topic in topics:
        count, score = data.query(
            "SELECT count(*), avg(intent_score) FROM companies{where}"
            + (" AND" if _has_filters(segment) else " WHERE") + " intent_topic = ?", segment, (topic,))[0]
        insights.append(Insight(
            label=f"Researching {topic}", value=count,
            detail=f"{_pct(count, total)}% of the segment, average surge score {score:.0f}" if count else
            "No surge on this topic in the segment"))

    in_market = data.query("SELECT count(intent_topic) FROM companies{where}", segment)[0][0]
    insights.append(Insight(
        label="Showing any buying intent", value=f"{_pct(in_market, total)}%"))

    by_country = data.query(
        "SELECT hq_country, count(*) AS n FROM companies{where} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 3", segment)
    insights.append(Insight(
        label="Top countries", value=", ".join(f"{c} ({n})" for c, n in by_country)))

    by_size = data.query(
        "SELECT size_band, count(*) FROM companies{where} GROUP BY 1 ORDER BY 2 DESC", segment)
    insights.append(Insight(
        label="Size mix", value=", ".join(f"{s} {_pct(n, total)}%" for s, n in by_size)))

    platforms = data.query(
        "SELECT hr_platform, count(*) AS n FROM companies{where} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 3", segment)
    insights.append(Insight(
        label="Most common HR platforms", value=", ".join(f"{p} ({n})" for p, n in platforms)))

    spend = data.query("SELECT median(annual_hr_tech_spend_usd) FROM companies{where}", segment)[0][0]
    insights.append(Insight(label="Median HR tech spend", value=f"${spend:,.0f}"))

    # Sample: companies on the requested topic first, strongest surge first.
    sample = [
        {"company_name": r[0], "hq_country": r[1], "size_band": r[2], "hr_platform": r[3],
         "intent_topic": r[4] or "-"}
        for r in data.query(
            "SELECT company_name, hq_country, size_band, hr_platform, intent_topic FROM companies{where} "
            "ORDER BY list_contains(?, intent_topic) DESC NULLS LAST, coalesce(intent_score, 0) DESC, "
            "company_id LIMIT 5", segment, (topics,))
    ]
    return total, insights, sample


def _has_filters(filters):
    return any((filters.industries, filters.regions, filters.countries, filters.size_bands, filters.intent_topics))


def capabilities():
    """Catalog overview for 'what can Champions do?'."""

    return CatalogResult(
        matches=[
            _match(c.id, 0.5, c.description, [f.name for f in c.vaf_fields[:4]]) for c in CARDS
        ],
        matching_companies=data.query("SELECT count(*) FROM companies{where}", Filters())[0][0],
        insights=[Insight(label="Data cards", value=len(CARDS)),
                  Insight(label="VAF fields", value=sum(len(c.vaf_fields) for c in CARDS))],
        method="Full catalog listing",
    )


def answer(request):
    """The CatalogResult for a CapabilityRequest."""

    if request.skill == "describe_capabilities":
        result = capabilities()
    else:
        matches = match_cards(request.need, request.filters, request.desired_outputs)
        shared = request.context.shared if request.context else {}
        total, _, sample = insights_for(request.filters)
        ranked = insight_engine.personalised(
            request.filters, request.need, shared, top=3 if request.skill == "find_data_cards" else 6)
        if request.skill == "find_data_cards":
            sample = []
        result = CatalogResult(
            matches=matches,
            matching_companies=total,
            insights=ranked,
            sample=sample,
            personalised_for=sorted(k for k in shared if k in ("role", "goals", "industry")),
            method="Keyword and filter match over the catalog; insights ranked for the shared role, goals "
            f"and industry; aggregates over {data.N_COMPANIES} synthetic companies. No records exported.",
        )
    if request.context:
        result.consent_id = request.context.consent_id
    return result
