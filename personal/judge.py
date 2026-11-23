"""Judges which of Champions' insights are actually useful to *this* person.

Runs inside the Personal Agent with the full private profile: notes,
must-have fields, goals and role. Only the yes/no ratings go back to
Champions (as feedback); the reasons stay here.
"""

import re

PLATFORMS = ["ADP", "Oracle HCM", "Workday", "SAP SuccessFactors", "BambooHR", "Personio", "UKG", "Dayforce",
             "Salesforce", "HubSpot", "Microsoft Dynamics", "Zoho", "SAP S/4HANA", "Oracle NetSuite", "Infor",
             "AWS", "Azure", "Google Cloud", "Series B", "Series C", "Ireland", "United Kingdom", "India",
             "Australia"]

# Which insights carry each must-have field.
FIELD_INSIGHTS = {
    "intent_score": ("hot_accounts", "topic_surge", "intent_share"),
    "intent_topic": ("topic_surge", "top_topics", "intent_share", "country_hotspot"),
    "hr_platform": ("legacy_platform_switchers",),
    "employee_count": ("segment_size", "growth_leaders"),
    "erp": ("erp_mix",),
    "crm": ("crm_mix",),
    "cloud_provider": ("cloud_mix",),
    "revenue_usd_m": ("growth_leaders", "spend_profile"),
    "funding_stage": ("funding_mix",),
}

GOAL_THEMES = {
    r"pipeline|accounts?|leads?": "accounts",
    r"switch|replac|moving|migrat": "displacement",
    r"campaign|\babm\b": "campaign",
    r"\bsize\b|market": "sizing",
    r"renew": "timing",
    r"grow|invest": "growth",
    r"\berp\b": "erp",
    r"\bcrm\b|territor": "crm",
    r"cloud": "cloud",
    r"payroll|\bhr\b": "hr",
    r"hiring": "growth",
}


def _empty(value):
    return value in (0, "0", "0.0%", "") or (isinstance(value, str) and value.startswith("0 "))


def judge(insights, profile, question=""):
    """[{insight_id, useful, reason}] in the same order as ``insights``."""

    notes = profile.get("private_notes", "")
    noted = [p for p in PLATFORMS if p.lower() in notes.lower()]
    must = profile.get("must_have_fields", [])
    goal_text = " ".join(profile.get("goals", [])) + " " + (question or "")
    goal_themes = {theme for pattern, theme in GOAL_THEMES.items() if re.search(pattern, goal_text, re.I)}
    no_outreach = bool(re.search(r"no outreach", notes, re.I))

    out = []
    for rank, insight in enumerate(insights):
        points, reasons = 0, []
        text = f"{insight.label} {insight.value} {insight.detail}"
        hits = [p for p in noted if p.lower() in text.lower()]
        if hits:
            points += 2
            reasons.append(f"mentions {', '.join(hits)}, which your private notes prioritise")
        fields = [f for f in must if any(insight.id.startswith(i) for i in FIELD_INSIGHTS.get(f, ()))]
        if fields:
            points += 2
            reasons.append(f"covers your must-have field {', '.join(fields)}")
        themes = goal_themes & set(insight.themes)
        if themes:
            points += 1
            reasons.append(f"serves your goal ({', '.join(sorted(themes))})")
        if rank < 2 and insight.score >= 6:
            points += 1
            reasons.append("Champions ranked it highly for your role")
        if no_outreach and "accounts" in insight.themes and not themes:
            points -= 1
            reasons.append("your notes say no outreach is planned")
        if _empty(insight.value):
            points = -1
            reasons = ["nothing found for this segment"]
        useful = points >= 2
        out.append({"insight_id": insight.id, "useful": useful,
                    "reason": ("Useful: " if useful else "Less useful: ") + ("; ".join(reasons) or
                                                                           "not tied to your goals or must-haves")})
    return out
