"""Turns the user's question into a CapabilityRequest (rule-based, no LLM).

Filters come from the question itself. The user's stored target segment is
used only when they consented to share it ("target_segment"), because filters
travel to Champions too.
"""

import re

from common.schemas import CapabilityRequest, Filters

INDUSTRIES = {
    r"health\s?care|hospital|clinic|medical|pharma": "Healthcare",
    r"financ\w*|bank\w*|insur\w*|fintech": "Financial Services",
    r"manufactur\w*|industrial|automotive|factor\w*": "Manufacturing",
    r"retail\w*|e-?commerce|shop\w*": "Retail",
    r"tech(nology)? compan\w*|software|saas|it services": "Technology",
    r"educat\w*|universit\w*|school\w*": "Education",
    r"logistic\w*|freight|warehous\w*|shipping": "Logistics",
    r"energy|utilit\w*|renewabl\w*|oil": "Energy",
}

REGIONS = {
    r"europe\w*|\beu\b|emea": "EMEA",
    r"north america|\bus\b|\busa\b|united states|canada": "NA",
    r"apac|asia\w*|pacific": "APAC",
    r"latam|latin america|south america": "LATAM",
}

COUNTRIES = {
    r"\buk\b|united kingdom|britain|british": "United Kingdom",
    r"german\w*": "Germany",
    r"france|french": "France",
    r"\bindia\w*": "India",
    r"japan\w*": "Japan",
    r"singapore": "Singapore",
    r"australia\w*": "Australia",
}

SIZES = {
    r"\bsmall\b|\bsmb\b|startups?": "SMB",
    r"mid[- ]?(size|sized|market)|medium": "Mid-market",
    r"enterprise\w*|\blarge\b": "Enterprise",
}

TOPICS = {
    r"(switch|replac|chang|migrat)\w* (their |an? )?(hr|hris|hcm)|hr platform": "HR Platform Replacement",
    r"payroll": "Payroll Outsourcing",
    r"crm": "CRM Migration",
    r"cloud migration|moving to (the )?cloud": "Cloud Migration",
    r"cyber\w*|security": "Cybersecurity",
    r"\berp\b": "ERP Upgrade",
    r"analytics|data platform": "Data Analytics",
}

OUTPUTS = {
    r"contacts?|emails?|decision[- ]makers?|people|outreach": "contacts",
    r"tech\w*|stack|platform|crm|erp|cloud": "technographics",
    r"intent|switch\w*|replac\w*|in[- ]market|buying": "intent_signals",
    r"budget|spend|renewal": "hr_tech_spend",
    r"revenue|funding|growth": "financials",
}


def _found(table, text):
    return sorted({value for pattern, value in table.items() if re.search(pattern, text)})


def plan(question, profile, consented_fields):
    """(CapabilityRequest without context, purpose)."""

    text = (question or "").lower()

    if re.search(r"what (data|can)|capabilit\w*|what do you (have|offer)|which data cards exist|catalog", text):
        skill = "describe_capabilities"
    elif re.search(r"how many|insight\w*|trend\w*|market|size the|count|share of", text):
        skill = "get_insights"
    else:
        skill = "get_insights"

    filters = Filters(
        industries=_found(INDUSTRIES, text),
        regions=_found(REGIONS, text),
        countries=_found(COUNTRIES, text),
        size_bands=_found(SIZES, text),
        intent_topics=_found(TOPICS, text),
    )
    if "target_segment" in consented_fields and skill != "describe_capabilities":
        target = profile.get("target_segment", {})
        for key in ("industries", "regions", "countries", "size_bands"):
            if not getattr(filters, key) and target.get(key):
                setattr(filters, key, list(target[key]))

    outputs = _found(OUTPUTS, text)
    purpose = "outreach" if "contacts" in outputs else (
        "market_insights" if skill == "get_insights" else "data_discovery")

    request = CapabilityRequest(skill=skill, need=question.strip(), filters=filters, desired_outputs=outputs)
    return request, purpose
