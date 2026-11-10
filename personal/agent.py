"""The Personal Agent's turn: plan -> consent gate -> A2A -> MCP -> evaluate."""

from personal import evaluator, planner
from personal.champions_client import ChampionsClient, ChampionsError, Wire
from personal.profile import FIELDS, PURPOSES, default_shared_fields, get_profile, shared_context
from common.schemas import UserContext


def _consent_prompt(purpose, profile, wire):
    fields = []
    for name, (cls, label) in FIELDS.items():
        fields.append({
            "name": name, "label": label, "class": cls,
            "default": cls == "shareable",
            "preview": None if cls == "private" else profile.get(name),
        })
    wire.local("Consent", f"Consent needed for purpose '{purpose}'",
               {"purpose": purpose, "would_share_by_default": default_shared_fields(),
                "never_shared": [n for n, (c, _) in FIELDS.items() if c == "private"]})
    return {"status": "consent_required", "purpose": purpose,
            "purpose_label": PURPOSES[purpose], "fields": fields, "wire": wire.events}


def _answer_text(request, catalog, recommendation):
    if request.skill == "describe_capabilities":
        names = ", ".join(m.name for m in catalog.matches)
        best = [o.name for o in recommendation.options[:2]]
        return (f"Champions offers {len(catalog.matches)} data cards ({names}) with "
                f"{catalog.insights[1].value} VAF fields in total. "
                f"Best fits for your profile: {' and '.join(best)}. "
                "Ask about a specific segment and I'll check what fits your budget.")
    lines = [f"Champions found {catalog.matching_companies} matching companies."]
    lines += [f"{i.label}: {i.value}" + (f" ({i.detail})" if i.detail else "") for i in catalog.insights[1:4]]
    lines.append(recommendation.summary)
    return "\n".join(lines)


async def run_turn(persona, question, consents, transport=None):
    wire = Wire()
    profile = get_profile(persona)

    request, purpose = planner.plan(question, profile, [])
    consent = consents.active(persona, purpose)
    if consent is None:
        return _consent_prompt(purpose, profile, wire)

    request, _ = planner.plan(question, profile, consent["fields"])
    shared = shared_context(profile, consent)
    request.context = UserContext(consent_id=consent["consent_id"], purpose=purpose, shared=shared)
    wire.local("Consent", f"Consent {consent['consent_id']} covers '{purpose}'", {
        "sending": sorted(shared),
        "kept_private": sorted(set(FIELDS) - set(consent["fields"])),
    })
    wire.local("Plan", f"Skill {request.skill}", request.model_dump(by_alias=True, exclude={"context"}))

    client = ChampionsClient(wire, transport=transport)
    try:
        catalog = await client.ask(request)
        vaf_details = {}
        must_have = set(profile.get("must_have_fields", []))
        for match in catalog.matches[:3]:
            details = await client.mcp_tool("get_vaf_fields", {"card_id": match.card_id})
            vaf_details[match.card_id] = [f["name"] for f in details["vaf_fields"]]
        wire.local("Evaluate", "Checked must-have fields against VAF definitions (private)", {
            "must_have_fields": "(private, not sent)",
            "found_in": {cid: sorted(must_have & set(names)) for cid, names in vaf_details.items()},
        })
    except ChampionsError as error:
        wire.local("Error", str(error))
        return {"status": "error", "error": str(error), "wire": wire.events}

    recommendation = evaluator.evaluate(catalog, profile, vaf_details)
    if request.skill == "describe_capabilities":
        recommendation.summary = ("How each Champions data card fits your profile. "
                                  "Nothing to buy yet: ask about a segment for a budgeted bundle.")
    wire.local("Recommend", recommendation.summary,
               {"bundle": recommendation.bundle, "credits": recommendation.bundle_monthly_credits})
    return {
        "status": "ok",
        "answer": _answer_text(request, catalog, recommendation),
        "catalog": catalog.model_dump(by_alias=True),
        "recommendation": recommendation.model_dump(by_alias=True),
        "consent": consent,
        "wire": wire.events,
    }
