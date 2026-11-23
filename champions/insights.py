"""Personalised insights: what in the data matters to *this* person.

``candidates(filters)`` computes every insight type for a segment. Each carries
themes (accounts, intent, timing, ...). ``rank(candidates, need, shared)`` scores
them against what the caller's agent was allowed to share (role, goals,
industry) and the question, and explains each one in a ``why_for_you`` line.

Only the shared context is used: Champions never sees the person's budget,
notes or policy. Rule-based, so the ranking is explainable and repeatable.
"""

import re

from champions import data
from common.schemas import Insight

TOP_N = 6
LEGACY_HR = ["ADP", "Oracle HCM", "UKG", "Dayforce"]
SWITCH_TOPICS = ["HR Platform Replacement", "Payroll Outsourcing"]

# ------------------------------------------------------------------ candidates


def _pct(part, whole):
    return round(100 * part / whole, 1) if whole else 0.0


def _q(sql, segment, params=()):
    return data.query(sql, segment, params)


def _cond(segment):
    """Joins an extra condition onto the segment WHERE clause."""

    return " AND" if any((segment.industries, segment.regions, segment.countries, segment.size_bands)) else " WHERE"


def _mix(column, segment, total, limit=3):
    rows = _q(f"SELECT {column}, count(*) AS n FROM companies{{where}} GROUP BY 1 ORDER BY n DESC, 1 LIMIT {limit}",
              segment)
    return rows, ", ".join(f"{v} {_pct(n, total)}%" for v, n in rows)


TOPIC_THEMES = {"HR Platform Replacement": "hr", "Payroll Outsourcing": "hr", "CRM Migration": "crm",
                "Cloud Migration": "cloud", "ERP Upgrade": "erp", "Cybersecurity": "tech",
                "Data Analytics": "tech", "Employee Experience": "hr"}


def _topic_themes(topic):
    switching = any(w in topic for w in ("Replacement", "Migration", "Upgrade", "Outsourcing"))
    return (["displacement"] if switching else []) + ["intent", "accounts", TOPIC_THEMES.get(topic, "tech")]


def candidates(filters):
    """Every insight type for the segment described by ``filters``."""

    topics = list(filters.intent_topics)
    segment = filters.model_copy(update={"intent_topics": []})
    total = _q("SELECT count(*) FROM companies{where}", segment)[0][0]
    if not total:
        return [Insight(id="segment_size", label="Matching companies", value=0, themes=["sizing"],
                        detail="No companies match these filters.",
                        follow_ups=["Widen the region or size band and try again"])]

    and_ = _cond(segment)
    found = []

    countries, country_text = _mix("hq_country", segment, total)
    found.append(Insight(
        id="segment_size", label="Companies in this segment", value=total, themes=["sizing"],
        detail=f"Top countries: {country_text}",
        evidence="count(*) over the segment filters",
        follow_ups=["Which of these companies show buying intent right now?"]))

    if topics:
        for n, topic in enumerate(topics):
            count, score = _q(f"SELECT count(*), avg(intent_score) FROM companies{{where}}{and_} intent_topic = ?",
                              segment, (topic,))[0]
            found.append(Insight(
                id="topic_surge" if n == 0 else f"topic_surge_{n + 1}",
                label=f"Researching {topic}", value=count, themes=_topic_themes(topic),
                detail=(f"{_pct(count, total)}% of the segment, average surge score {score:.0f}" if count
                        else "No surge on this topic in the segment"),
                evidence=f"intent_topic = '{topic}'",
                follow_ups=[f"Which platforms do the companies researching {topic} use today?"]))
    else:
        rows = _q(f"SELECT intent_topic, count(*) AS n FROM companies{{where}}{and_} intent_topic IS NOT NULL "
                  "GROUP BY 1 ORDER BY n DESC, 1 LIMIT 3", segment)
        if rows:
            found.append(Insight(
                id="top_topics", label="What this segment is researching", value=rows[0][0],
                themes=["intent", "campaign"],
                detail=", ".join(f"{t} ({n})" for t, n in rows),
                evidence="intent_topic, grouped",
                follow_ups=[f"Show companies researching {rows[0][0]}"]))

    hot = _q(f"SELECT count(*) FROM companies{{where}}{and_} intent_score >= 80", segment)[0][0]
    found.append(Insight(
        id="hot_accounts", label="Hot accounts (surge score 80+)", value=hot,
        themes=["accounts", "intent", "timing"],
        detail=f"{_pct(hot, total)}% of the segment is in a strong buying surge",
        evidence="intent_score >= 80",
        follow_ups=["What are the hot accounts researching, and which HR platform do they run?"]))

    marks = ", ".join("?" * len(LEGACY_HR))
    topic_marks = ", ".join("?" * len(SWITCH_TOPICS))
    switchers = _q(f"SELECT hr_platform, count(*) AS n FROM companies{{where}}{and_} hr_platform IN ({marks}) "
                   f"AND intent_topic IN ({topic_marks}) GROUP BY 1 ORDER BY n DESC, 1",
                   segment, (*LEGACY_HR, *SWITCH_TOPICS))
    switch_total = sum(n for _, n in switchers)
    found.append(Insight(
        id="legacy_platform_switchers", label="On a legacy HR platform and researching a switch",
        value=switch_total, themes=["displacement", "accounts", "hr", "intent"],
        detail=", ".join(f"{p} ({n})" for p, n in switchers) or "None right now",
        evidence=f"hr_platform in {LEGACY_HR} and intent_topic in {SWITCH_TOPICS}",
        follow_ups=["When do these switchers' HR contracts renew?"]))

    upcoming = ", ".join("?" * len(data.UPCOMING_RENEWALS))
    renewals, renew_spend = _q(
        f"SELECT count(*), median(annual_hr_tech_spend_usd) FROM companies{{where}}{and_} "
        f"renewal_quarter IN ({upcoming})", segment, tuple(data.UPCOMING_RENEWALS))[0]
    found.append(Insight(
        id="renewals_soon", label=f"HR contract renews in {' or '.join(data.UPCOMING_RENEWALS)}",
        value=renewals, themes=["timing", "accounts", "hr", "budget"],
        detail=f"{_pct(renewals, total)}% of the segment; median HR tech spend ${renew_spend or 0:,.0f}",
        evidence=f"renewal_quarter in {data.UPCOMING_RENEWALS}",
        follow_ups=["Which of the renewing companies are also showing intent?"]))

    median, p75 = _q("SELECT median(annual_hr_tech_spend_usd), quantile_cont(annual_hr_tech_spend_usd, 0.75) "
                     "FROM companies{where}", segment)[0]
    found.append(Insight(
        id="spend_profile", label="Median HR tech spend", value=f"${median:,.0f}",
        themes=["budget", "sizing", "hr"],
        detail=f"Top quarter spends ${p75:,.0f}+ a year; segment total about ${median * total / 1e6:,.1f}M",
        evidence="median and 75th percentile of annual_hr_tech_spend_usd",
        follow_ups=["Which companies spend the most on HR tech?"]))

    growers = _q(f"SELECT count(*) FROM companies{{where}}{and_} revenue_growth_pct >= 20", segment)[0][0]
    found.append(Insight(
        id="growth_leaders", label="Fast growers (20%+ revenue growth)", value=growers,
        themes=["growth", "accounts", "sizing"],
        detail=f"{_pct(growers, total)}% of the segment is growing fast",
        evidence="revenue_growth_pct >= 20",
        follow_ups=["What are the fast growers researching?"]))

    _, funding_text = _mix("funding_stage", segment, total)
    found.append(Insight(
        id="funding_mix", label="Funding stage mix", value=funding_text.split(",")[0],
        themes=["growth", "budget"], detail=funding_text, evidence="funding_stage, grouped",
        follow_ups=["Show the growth of Series B and later companies"]))

    hotspot = _q("SELECT hq_country, count(*) AS n, count(intent_topic) AS i FROM companies{where} "
                 "GROUP BY 1 HAVING count(*) >= 5 ORDER BY i * 1.0 / n DESC, n DESC LIMIT 1", segment)
    if hotspot and len(countries) > 1:  # pointless when the segment is one country
        country, n, i = hotspot[0]
        found.append(Insight(
            id="country_hotspot", label="Country with the most buying intent", value=country,
            themes=["geo", "campaign", "intent"],
            detail=f"{_pct(i, n)}% of its {n} companies show intent",
            evidence="share of companies with any intent_topic, by hq_country",
            follow_ups=[f"Focus on {country}: what are they researching?"]))

    _, crm_text = _mix("crm", segment, total)
    found.append(Insight(id="crm_mix", label="CRM in use", value=crm_text.split(",")[0],
                         themes=["tech", "crm", "campaign"], detail=crm_text, evidence="crm, grouped",
                         follow_ups=["Which companies are researching a CRM migration?"]))
    _, erp_text = _mix("erp", segment, total)
    found.append(Insight(id="erp_mix", label="ERP in use", value=erp_text.split(",")[0],
                         themes=["tech", "erp", "sizing"], detail=erp_text, evidence="erp, grouped",
                         follow_ups=["How many are researching an ERP upgrade?"]))
    _, cloud_text = _mix("cloud_provider", segment, total)
    found.append(Insight(id="cloud_mix", label="Primary cloud", value=cloud_text.split(",")[0],
                         themes=["tech", "cloud"], detail=cloud_text, evidence="cloud_provider, grouped",
                         follow_ups=["Which companies are researching a cloud migration?"]))

    in_market = _q("SELECT count(intent_topic) FROM companies{where}", segment)[0][0]
    found.append(Insight(id="intent_share", label="Showing any buying intent", value=f"{_pct(in_market, total)}%",
                         themes=["intent", "sizing"], detail=f"{in_market} of {total} companies",
                         evidence="intent_topic is not null",
                         follow_ups=["Break the intent down by topic"]))
    return found


# --------------------------------------------------------------------- ranking

ROLE_THEMES = {
    r"sales|business development|\bbdr\b|\bsdr\b|account exec": {"accounts": 3, "intent": 2, "timing": 2,
                                                                   "displacement": 2},
    r"customer success|account manag": {"timing": 3, "accounts": 2, "displacement": 1},
    r"marketing|\babm\b|demand": {"campaign": 3, "intent": 2, "geo": 2, "tech": 1},
    r"revops|revenue operations|operations": {"tech": 2, "accounts": 2, "crm": 2, "timing": 1},
    r"analyst|strategy|research|consult": {"sizing": 3, "tech": 2, "growth": 1, "geo": 1},
    r"invest|partner|venture|corporate development": {"growth": 3, "sizing": 2, "budget": 1},
    r"talent|recruit": {"growth": 3, "geo": 2},
    r"product": {"tech": 2, "intent": 2, "sizing": 1},
}

KEYWORD_THEMES = {
    r"pipeline|leads?\b|accounts?|target|prospect": {"accounts": 2},
    r"switch|replac|displac|migrat|competitor": {"displacement": 3, "intent": 1},
    r"campaign|\babm\b|segment": {"campaign": 2},
    r"\bsize\b|sizing|market|\btam\b": {"sizing": 2},
    r"renew|contract|timing|\bwhen\b": {"timing": 3},
    r"growth|growing|fund|invest": {"growth": 3},
    r"\berp\b": {"erp": 3},
    r"\bcrm\b": {"crm": 3},
    r"cloud": {"cloud": 3},
    r"\bhr\b|payroll|hris|hcm": {"hr": 2},
    r"budget|spend|wallet": {"budget": 3},
    r"countr|where|region|geograph": {"geo": 2},
    r"intent|research|in[- ]market|buying": {"intent": 2},
}

ANGLE = {
    "accounts": "it points to accounts you can act on",
    "intent": "these companies are actively researching right now",
    "timing": "it tells you when to reach out",
    "displacement": "these look like switchers away from a competing platform",
    "sizing": "it sizes the opportunity",
    "growth": "it shows who has momentum and budget",
    "tech": "it shows the stack you would integrate with or replace",
    "campaign": "it tells you where to focus a campaign",
    "geo": "it shows where to focus geographically",
    "budget": "it shows what these companies can spend",
    "hr": "it is about HR technology, your market",
    "erp": "it covers the ERP stack you care about",
    "crm": "it covers the CRM stack you care about",
    "cloud": "it covers the cloud stack you care about",
}

BASE = {"segment_size": 1.5, "topic_surge": 3.0}
CONTEXT_WEIGHT = 0.5
FOCUS_BONUS = 6


def _weights(table, text):
    out = {}
    for pattern, themes in table.items():
        if text and re.search(pattern, text, re.IGNORECASE):
            for theme, weight in themes.items():
                out[theme] = max(out.get(theme, 0), weight)
    return out


def _goals(shared):
    goals = shared.get("goals") or []
    return [goals] if isinstance(goals, str) else list(goals)


def rank(found, need, shared):
    """Insights ordered by what matters to the person, each with ``why_for_you``."""

    shared = shared or {}
    role = str(shared.get("role") or "")
    goals = _goals(shared)
    sources = {
        "role": _weights(ROLE_THEMES, role),
        "goal": _weights(KEYWORD_THEMES, " ".join(goals)),
        "industry": _weights(KEYWORD_THEMES, str(shared.get("industry") or "")),
        "question": _weights(KEYWORD_THEMES, need or ""),
    }

    # A theme the question asks for explicitly (weight 3) is the focus: an insight
    # that is primarily about it answers the question and goes first.
    focus = {theme for theme, weight in sources["question"].items() if weight >= 3}

    ranked = []
    for insight in found:
        base = BASE["topic_surge"] if insight.id.startswith("topic_surge") else BASE.get(insight.id, 1.0)
        contributions = []  # (weight, source, theme)
        for source, weights in sources.items():
            for theme in insight.themes:
                if weights.get(theme):
                    contributions.append((weights[theme], source, theme))
        # Context (role, goals, industry) steers the order; the question decides it.
        context = sum(w for w, s, _ in contributions if s != "question") * CONTEXT_WEIGHT
        asked = sum(w for w, s, _ in contributions if s == "question")
        # A topic surge is the direct answer to "who is researching X" whatever X's theme is.
        answers = bool(insight.themes) and (insight.themes[0] in focus or (
            insight.id.startswith("topic_surge") and bool(focus & set(insight.themes))))
        score = base + context + asked + (FOCUS_BONUS if answers else 0)
        if insight.value in (0, "0", "0.0%"):
            score -= 2  # an empty finding is rarely the most useful one
        answered = next((t for t in insight.themes if t in focus), None) if answers else None
        why = _why(contributions, role, goals, answered)
        ranked.append(insight.model_copy(update={"score": round(score, 1), "why_for_you": why}))
    ranked.sort(key=lambda i: (-i.score, i.id))
    return ranked


def _why(contributions, role, goals, answered_theme=None):
    if answered_theme:
        angle = ANGLE[answered_theme]
        if any(s == "role" for _, s, _ in contributions):
            return f"As {role}, {angle}; it answers what you asked."
        return f"Answers what you asked: {angle}."
    if not contributions:
        return "General market view. Share your role or goals for a sharper ranking."
    order = {"role": 0, "goal": 1, "question": 2, "industry": 3}
    weight, source, theme = max(contributions, key=lambda c: (c[0], -order[c[1]]))
    angle = ANGLE[theme]
    if source == "role":
        return f"As {role}, {angle}."
    if source == "goal":
        return f"Supports your goal \"{goals[0]}\": {angle}."
    if source == "industry":
        return f"Relevant to your industry: {angle}."
    return f"Matches your question: {angle}."


def personalised(filters, need, shared, top=TOP_N):
    return rank(candidates(filters), need, shared)[:top]
