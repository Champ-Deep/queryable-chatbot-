"""Agent-to-agent simulator: many personal agents, each with its own person's
context, ask the Champions agent realistic questions over the real path
(OAuth -> Agent Card -> A2A -> MCP -> feedback). Requests are tagged
``source=simulator`` so the Champions query log can tell them apart.

Consent is given automatically for the shareable fields and the target
segment (never the private ones), as a real user would after a first prompt.
"""

import time

from personal import agent
from personal.profile import PERSONAS, ConsentStore, default_shared_fields
from personal.scenarios import SCENARIOS

AUTO_CONSENT = default_shared_fields() + ["target_segment"]


async def _ask(persona, question, store, transport):
    result = await agent.run_turn(persona, question, store, transport=transport, source="simulator")
    if result["status"] == "consent_required":
        store.grant(persona, result["purpose"], AUTO_CONSENT)
        result = await agent.run_turn(persona, question, store, transport=transport, source="simulator")
    return result


async def run(transport=None, personas=None):
    store = ConsentStore()
    started = time.perf_counter()
    rows = []
    for persona in personas or list(SCENARIOS):
        for question in SCENARIOS[persona]:
            result = await _ask(persona, question, store, transport)
            ok = result["status"] == "ok"
            insights = result.get("insights", []) if ok else []
            catalog = result.get("catalog", {}) if ok else {}
            useful = [i for i in insights if i["useful"]]
            rows.append({
                "persona": persona,
                "role": PERSONAS[persona]["role"],
                "question": question,
                "status": result["status"],
                "skill": result.get("skill", ""),
                "matching": catalog.get("matching_companies", 0),
                "insights": len(insights),
                "useful": len(useful),
                "top_useful": [f"{i['label']}: {i['value']}" for i in useful[:2]],
                "why": useful[0]["why_for_you"] if useful else "",
                "gaps": catalog.get("gaps", []),
                "error": result.get("error", ""),
            })
    return _report(rows, time.perf_counter() - started)


def _pct(a, b):
    return round(100 * a / b, 1) if b else 0.0


def _report(rows, seconds):
    answered = [r for r in rows if r["status"] == "ok" and r["matching"] > 0 and "no_results" not in r["gaps"]]
    shown = sum(r["insights"] for r in rows)
    useful = sum(r["useful"] for r in rows)
    by_persona = {}
    for r in rows:
        g = by_persona.setdefault(r["persona"], {"persona": r["persona"], "role": r["role"], "questions": 0,
                                                  "insights": 0, "useful": 0})
        g["questions"] += 1
        g["insights"] += r["insights"]
        g["useful"] += r["useful"]
    for g in by_persona.values():
        g["useful_pct"] = _pct(g["useful"], g["insights"])
    gaps = {}
    for r in rows:
        for gap in r["gaps"]:
            gaps.setdefault(gap, []).append(r["question"])
    best = sorted((r for r in rows if r["useful"]), key=lambda r: (-r["useful"] / max(r["insights"], 1),
                                                                   r["persona"]))
    return {
        "conversations": len(rows),
        "answered_pct": _pct(len(answered), len(rows)),
        "insights_shown": shown,
        "useful_pct": _pct(useful, shown),
        "seconds": round(seconds, 1),
        "by_persona": sorted(by_persona.values(), key=lambda g: -g["useful_pct"]),
        "gaps": [{"gap": k, "count": len(v), "examples": v[:3]} for k, v in
                 sorted(gaps.items(), key=lambda kv: -len(kv[1]))],
        "examples": best[:6],
        "rows": rows,
    }


def markdown(report):
    lines = [
        "# Agent-to-agent simulation",
        "",
        f"{report['conversations']} conversations from {len(report['by_persona'])} personal agents "
        f"in {report['seconds']} s.",
        "",
        "| Metric | Value |", "|---|---|",
        f"| Questions answered with data | {report['answered_pct']}% |",
        f"| Insights shown | {report['insights_shown']} |",
        f"| Judged useful by the person's own agent | {report['useful_pct']}% |",
        "",
        "## Usefulness by persona", "",
        "| Persona | Role | Questions | Useful insights |", "|---|---|---|---|",
    ]
    lines += [f"| {g['persona']} | {g['role']} | {g['questions']} | {g['useful']}/{g['insights']} "
              f"({g['useful_pct']}%) |" for g in report["by_persona"]]
    lines += ["", "## Where the Champions agent falls short", ""]
    lines += [f"- **{g['gap']}** ({g['count']}): e.g. \"{g['examples'][0]}\"" for g in report["gaps"]] or ["- none"]
    lines += ["", "## Examples of useful answers", ""]
    for r in report["examples"]:
        lines.append(f"- **{r['persona']}** asked \"{r['question']}\" → {'; '.join(r['top_useful'])}. "
                     f"_{r['why']}_")
    return "\n".join(lines) + "\n"
