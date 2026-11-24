// Query log (port of champions/querylog.py): every question partner agents send, what we
// answered, and whether their agent found it useful. The dataset for improving the Champions
// agent later (export as CSV or JSONL).
//
// SQLite via the db interface (Durable Object storage in production), so it survives restarts.
// Stores the question text, structured filters, the *role and industry* the caller chose to
// share (never goals or other free text), the intent category, gaps and the usefulness ratings.

import { randomHex } from "../common/http.js";
import { pct, pyDumps, pyFloat, round } from "./pyfmt.js";

export const INTENTS = ["catalog", "contacts", "timing_renewals", "tech_displacement", "growth_signals", "tech_stack",
  "market_sizing", "intent_research", "account_discovery", "other"];

const RULES = [
  ["timing_renewals", /renew|contract|\bwhen\b|timing|next quarter/],
  ["tech_displacement", /switch|replac|migrat|displac|moving (off|from|to)|competitor/],
  ["growth_signals", /grow|funded|funding|revenue|invest/],
  ["tech_stack", /(what|which) (crm|erp|cloud|hr platforms?|tech)|tech stack|\buse\b|\busing\b|installed/],
  ["market_sizing", /\bsize\b|sizing|how many|market|\btam\b|\bcount\b|share of/],
  ["intent_research", /research|intent|in[- ]market|surge|buying/],
  ["account_discovery", /find|accounts?|target|which compan|list|prospects?|leads?/],
];

export const COLUMNS = ["query_id", "at", "client", "channel", "source", "skill", "intent", "need", "filters",
  "shared_role", "shared_industry", "shared_fields", "cards", "insight_ids", "matching",
  "gaps", "latency_ms", "ratings"];

const JSON_COLUMNS = ["filters", "shared_fields", "cards", "insight_ids", "gaps", "ratings"];
const FLOATS = new Set(["latency_ms"]);

/** Intent category of a (validated) capability request, rule-based. */
export function classify(request) {
  if (request.skill === "describe_capabilities") return "catalog";
  if (request.desired_outputs.includes("contacts")) return "contacts";
  const text = (request.need || "").toLowerCase();
  for (const [intent, pattern] of RULES) if (pattern.test(text)) return intent;
  if (request.filters.intent_topics.length) return "intent_research";
  if (request.desired_outputs.includes("financials")) return "growth_signals";
  return "other";
}

/** What the agent could not do well for this request. */
export function gaps(request, matching) {
  if (request.skill === "describe_capabilities") return [];
  if (matching === 0) return ["no_results"];
  const found = [];
  const f = request.filters;
  if (![f.industries, f.regions, f.countries, f.size_bands, f.intent_topics].some((v) => v.length)) {
    found.push("segment_not_understood");
  }
  if (request.desired_outputs.includes("contacts")) found.push("contacts_not_available");
  if (/hiring|job post|layoff|headcount growth|esg|sustainab|patent/.test((request.need || "").toLowerCase())) {
    found.push("topic_not_tracked");
  }
  return found;
}

/** "2026-11-24T00:16:30" (UTC: Workers have no local time zone). */
const now = () => new Date().toISOString().slice(0, 19);

function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class QueryLog {
  constructor(db) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS queries (${COLUMNS.map((c) => c + " TEXT").join(", ")})`);
  }

  record(request, { channel, client, shared, cards, insightIds, matching, latencyMs }) {
    const queryId = `q-${randomHex(6)}`;
    shared = shared || {};
    const row = {
      query_id: queryId,
      at: now(),
      client: client || "",
      channel,
      source: request.source,
      skill: request.skill,
      intent: classify(request),
      need: request.need,
      filters: pyDumps(request.filters),
      shared_role: String(shared.role || ""),
      shared_industry: String(shared.industry || ""),
      shared_fields: pyDumps(Object.keys(shared).sort()),
      cards: pyDumps(cards),
      insight_ids: pyDumps(insightIds),
      matching: String(matching),
      gaps: pyDumps(gaps(request, matching)),
      latency_ms: pyFloat(round(latencyMs, 1)),
      ratings: "{}",
    };
    this.db.run(`INSERT INTO queries VALUES (${COLUMNS.map(() => "?").join(", ")})`, ...COLUMNS.map((c) => row[c]));
    return queryId;
  }

  /**
   * Store {insight_id: useful} for a query. False if the query is unknown, or (when client
   * is given) belongs to another client.
   */
  addFeedback(queryId, ratings, client = null) {
    let sql = "SELECT ratings FROM queries WHERE query_id = ?";
    const params = [queryId];
    if (client !== null && client !== undefined) {
      sql += " AND client = ?";
      params.push(client);
    }
    const found = this.db.one(sql, ...params);
    if (!found) return false;
    const merged = { ...JSON.parse(found.ratings) };
    for (const [k, v] of Object.entries(ratings)) merged[k] = Boolean(v);
    this.db.run("UPDATE queries SET ratings = ? WHERE query_id = ?", pyDumps(merged), queryId);
    return true;
  }

  // ---------------------------------------------------------------- reading

  rows(limit = null) {
    const sql = "SELECT * FROM queries ORDER BY at DESC, rowid DESC" + (limit ? ` LIMIT ${Math.trunc(limit)}` : "");
    return this.db.all(sql).map((raw) => {
      const r = Object.fromEntries(COLUMNS.map((c) => [c, raw[c]]));
      for (const key of JSON_COLUMNS) r[key] = JSON.parse(r[key]);
      r.matching = parseInt(r.matching, 10);
      r.latency_ms = parseFloat(r.latency_ms);
      const values = Object.values(r.ratings);
      r.rated = values.length;
      r.useful = values.filter(Boolean).length;
      return r;
    });
  }

  recent(limit = 50) {
    return this.rows(limit);
  }

  /** Aggregates over every query, or only client's own (for partner-facing views). */
  stats(client = null) {
    const rows = this.rows().filter((r) => client === null || client === undefined || r.client === client);
    const total = rows.length;
    const answered = rows.filter((r) => r.matching > 0 && !r.gaps.includes("no_results")).length;
    const rated = rows.reduce((s, r) => s + r.rated, 0);
    const useful = rows.reduce((s, r) => s + r.useful, 0);

    const group = (key) => {
      const out = new Map();
      for (const r of rows) {
        const k = r[key] || "(not shared)";
        const g = out.get(k) ?? { n: 0, rated: 0, useful: 0 };
        g.n += 1;
        g.rated += r.rated;
        g.useful += r.useful;
        out.set(k, g);
      }
      return [...out.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    };

    const insights = new Map();
    for (const r of rows) {
      for (const iid of r.insight_ids) {
        const g = insights.get(iid) ?? { shown: 0, rated: 0, useful: 0 };
        g.shown += 1;
        if (iid in r.ratings) {
          g.rated += 1;
          g.useful += r.ratings[iid] ? 1 : 0;
        }
        insights.set(iid, g);
      }
    }
    const insightRows = [...insights.entries()].map(([k, v]) => ({ insight: k, ...v, useful_pct: pct(v.useful, v.rated) }));
    insightRows.sort((a, b) => b.useful_pct - a.useful_pct || b.shown - a.shown ||
      (a.insight < b.insight ? -1 : a.insight > b.insight ? 1 : 0));

    const gapCounts = new Map();
    const examples = {};
    for (const r of rows) {
      for (const gap of r.gaps) {
        gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1);
        examples[gap] ??= [];
        if (!examples[gap].includes(r.need) && examples[gap].length < 3) examples[gap].push(r.need);
      }
    }

    const sources = {};
    const channels = {};
    for (const r of rows) {
      sources[r.source] = (sources[r.source] ?? 0) + 1;
      channels[r.channel] = (channels[r.channel] ?? 0) + 1;
    }

    return {
      total,
      answered_pct: pct(answered, total),
      useful_pct: pct(useful, rated),
      rated,
      avg_latency_ms: total ? round(rows.reduce((s, r) => s + r.latency_ms, 0) / total, 1) : 0,
      by_intent: group("intent").map(([k, v]) => ({ intent: k, queries: v.n, useful_pct: pct(v.useful, v.rated) })),
      by_role: group("shared_role").map(([k, v]) => ({ role: k, queries: v.n, useful_pct: pct(v.useful, v.rated) })),
      insights: insightRows,
      gaps: [...gapCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ gap: k, count: v, examples: examples[k] })),
      by_source: sources,
      by_channel: channels,
    };
  }

  /** CSV (Python csv.DictWriter: header, \r\n line ends, JSON cells) or JSONL. */
  export(fmt = "csv") {
    const rows = this.rows();
    if (fmt === "jsonl") {
      return rows.map((r) => pyDumps(Object.fromEntries(COLUMNS.map((c) => [c, r[c]])), FLOATS)).join("\n");
    }
    const lines = [COLUMNS.join(",")];
    for (const r of rows) {
      lines.push(COLUMNS.map((c) => {
        const v = r[c];
        if (v !== null && typeof v === "object") return csvCell(pyDumps(v));
        return csvCell(FLOATS.has(c) ? pyFloat(v) : v);
      }).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  clear() {
    this.db.run("DELETE FROM queries");
  }
}
