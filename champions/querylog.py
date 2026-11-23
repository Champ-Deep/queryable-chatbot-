"""Query log: every question partner agents send, what we answered, and
whether their agent found it useful. This is the dataset for improving the
Champions agent later (export as CSV or JSONL).

SQLite, so it survives restarts. Stores the question text, structured
filters, the *role and industry* the caller chose to share (never goals or
other free text), the intent category, gaps, and the usefulness ratings.
"""

import csv
import io
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "query_log.db"

INTENTS = ["catalog", "contacts", "timing_renewals", "tech_displacement", "growth_signals", "tech_stack",
           "market_sizing", "intent_research", "account_discovery", "other"]

_RULES = [
    ("timing_renewals", r"renew|contract|\bwhen\b|timing|next quarter"),
    ("tech_displacement", r"switch|replac|migrat|displac|moving (off|from|to)|competitor"),
    ("growth_signals", r"grow|funded|funding|revenue|invest"),
    ("tech_stack", r"(what|which) (crm|erp|cloud|hr platforms?|tech)|tech stack|\buse\b|\busing\b|installed"),
    ("market_sizing", r"\bsize\b|sizing|how many|market|\btam\b|\bcount\b|share of"),
    ("intent_research", r"research|intent|in[- ]market|surge|buying"),
    ("account_discovery", r"find|accounts?|target|which compan|list|prospects?|leads?"),
]

COLUMNS = ["query_id", "at", "client", "channel", "source", "skill", "intent", "need", "filters",
           "shared_role", "shared_industry", "shared_fields", "cards", "insight_ids", "matching",
           "gaps", "latency_ms", "ratings"]


def classify(request):
    """Intent category of a capability request (rule-based)."""

    if request.skill == "describe_capabilities":
        return "catalog"
    if "contacts" in request.desired_outputs:
        return "contacts"
    text = (request.need or "").lower()
    topics = request.filters.intent_topics
    for intent, pattern in _RULES:
        if re.search(pattern, text):
            return intent
    if topics:
        return "intent_research"
    if "financials" in request.desired_outputs:
        return "growth_signals"
    return "other"


def gaps(request, matching):
    """What the agent could not do well for this request."""

    if request.skill == "describe_capabilities":
        return []
    if matching == 0:
        return ["no_results"]
    found = []
    f = request.filters
    if not any((f.industries, f.regions, f.countries, f.size_bands, f.intent_topics)):
        found.append("segment_not_understood")
    if "contacts" in request.desired_outputs:
        found.append("contacts_not_available")
    if re.search(r"hiring|job post|layoff|headcount growth|esg|sustainab|patent", (request.need or "").lower()):
        found.append("topic_not_tracked")
    return found


class QueryLog:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv("CHAMPIONS_QUERY_LOG") or DEFAULT_PATH)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._db() as db:
            db.execute(f"CREATE TABLE IF NOT EXISTS queries ({', '.join(c + ' TEXT' for c in COLUMNS)})")

    def _db(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def record(self, request, *, channel, client, shared, cards, insight_ids, matching, latency_ms):
        query_id = f"q-{uuid.uuid4().hex[:12]}"
        shared = shared or {}
        row = {
            "query_id": query_id,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "client": client or "",
            "channel": channel,
            "source": request.source,
            "skill": request.skill,
            "intent": classify(request),
            "need": request.need,
            "filters": request.filters.model_dump_json(),
            "shared_role": str(shared.get("role") or ""),
            "shared_industry": str(shared.get("industry") or ""),
            "shared_fields": json.dumps(sorted(shared)),
            "cards": json.dumps(cards),
            "insight_ids": json.dumps(insight_ids),
            "matching": str(matching),
            "gaps": json.dumps(gaps(request, matching)),
            "latency_ms": str(round(latency_ms, 1)),
            "ratings": "{}",
        }
        with self._lock, self._db() as db:
            db.execute(f"INSERT INTO queries VALUES ({', '.join('?' * len(COLUMNS))})",
                       [row[c] for c in COLUMNS])
        return query_id

    def add_feedback(self, query_id, ratings, client=None):
        """Store ``{insight_id: useful}`` for a query. False if the query is unknown,
        or (when ``client`` is given) belongs to another client."""

        sql, params = "SELECT ratings FROM queries WHERE query_id = ?", [query_id]
        if client is not None:
            sql, params = sql + " AND client = ?", params + [client]
        with self._lock, self._db() as db:
            found = db.execute(sql, params).fetchone()
            if not found:
                return False
            merged = {**json.loads(found["ratings"]), **{k: bool(v) for k, v in ratings.items()}}
            db.execute("UPDATE queries SET ratings = ? WHERE query_id = ?", (json.dumps(merged), query_id))
        return True

    # ------------------------------------------------------------- reading

    def _rows(self, limit=None):
        sql = "SELECT * FROM queries ORDER BY at DESC, rowid DESC" + (f" LIMIT {int(limit)}" if limit else "")
        with self._db() as db:
            rows = [dict(r) for r in db.execute(sql)]
        for r in rows:
            for key in ("filters", "shared_fields", "cards", "insight_ids", "gaps", "ratings"):
                r[key] = json.loads(r[key])
            r["matching"] = int(r["matching"])
            r["latency_ms"] = float(r["latency_ms"])
            r["rated"] = len(r["ratings"])
            r["useful"] = sum(1 for v in r["ratings"].values() if v)
        return rows

    def recent(self, limit=50):
        return self._rows(limit)

    def stats(self, client=None):
        """Aggregates over every query, or only ``client``'s own (for partner-facing views)."""

        rows = [r for r in self._rows() if client is None or r["client"] == client]
        total = len(rows)
        answered = sum(1 for r in rows if r["matching"] > 0 and "no_results" not in r["gaps"])
        rated = sum(r["rated"] for r in rows)
        useful = sum(r["useful"] for r in rows)

        def group(key):
            out = {}
            for r in rows:
                k = r[key] or "(not shared)"
                g = out.setdefault(k, {"n": 0, "rated": 0, "useful": 0})
                g["n"] += 1
                g["rated"] += r["rated"]
                g["useful"] += r["useful"]
            return sorted(out.items(), key=lambda kv: (-kv[1]["n"], kv[0]))

        insights = {}
        for r in rows:
            for iid in r["insight_ids"]:
                g = insights.setdefault(iid, {"shown": 0, "rated": 0, "useful": 0})
                g["shown"] += 1
                if iid in r["ratings"]:
                    g["rated"] += 1
                    g["useful"] += int(r["ratings"][iid])
        insight_rows = [{"insight": k, **v, "useful_pct": _pct(v["useful"], v["rated"])}
                        for k, v in insights.items()]
        insight_rows.sort(key=lambda x: (-x["useful_pct"], -x["shown"], x["insight"]))

        gap_counts = {}
        examples = {}
        for r in rows:
            for gap in r["gaps"]:
                gap_counts[gap] = gap_counts.get(gap, 0) + 1
                examples.setdefault(gap, [])
                if r["need"] not in examples[gap] and len(examples[gap]) < 3:
                    examples[gap].append(r["need"])

        sources = {}
        channels = {}
        for r in rows:
            sources[r["source"]] = sources.get(r["source"], 0) + 1
            channels[r["channel"]] = channels.get(r["channel"], 0) + 1

        return {
            "total": total,
            "answered_pct": _pct(answered, total),
            "useful_pct": _pct(useful, rated),
            "rated": rated,
            "avg_latency_ms": round(sum(r["latency_ms"] for r in rows) / total, 1) if total else 0,
            "by_intent": [{"intent": k, "queries": v["n"], "useful_pct": _pct(v["useful"], v["rated"])}
                          for k, v in group("intent")],
            "by_role": [{"role": k, "queries": v["n"], "useful_pct": _pct(v["useful"], v["rated"])}
                        for k, v in group("shared_role")],
            "insights": insight_rows,
            "gaps": [{"gap": k, "count": v, "examples": examples[k]}
                     for k, v in sorted(gap_counts.items(), key=lambda kv: -kv[1])],
            "by_source": sources,
            "by_channel": channels,
        }

    def export(self, fmt="csv"):
        rows = self._rows()
        if fmt == "jsonl":
            return "\n".join(json.dumps({c: r[c] for c in COLUMNS}) for r in rows)
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow({c: json.dumps(r[c]) if isinstance(r[c], (list, dict)) else r[c] for c in COLUMNS})
        return buffer.getvalue()

    def clear(self):
        with self._lock, self._db() as db:
            db.execute("DELETE FROM queries")


def _pct(part, whole):
    return round(100 * part / whole, 1) if whole else 0.0
