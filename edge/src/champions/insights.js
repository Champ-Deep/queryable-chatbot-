// Personalised insights: what in the data matters to *this* person (port of champions/insights.py).
//
// candidates(data, filters) computes every insight type for a segment. Each carries themes
// (accounts, intent, timing, ...). rank(found, need, shared) scores them against what the
// caller's agent was allowed to share (role, goals, industry) and the question, and explains
// each one in a why_for_you line. Only the shared context is used: Champions never sees the
// person's budget, notes or policy. Rule-based, so the ranking is explainable and repeatable.

import { UPCOMING_RENEWALS, avg, groupCount, median, quantile, where } from "./data.js";
import { grouped, pct, pyFloat, pyList, round } from "./pyfmt.js";

export const TOP_N = 6;
export const LEGACY_HR = ["ADP", "Oracle HCM", "UKG", "Dayforce"];
export const SWITCH_TOPICS = ["HR Platform Replacement", "Payroll Outsourcing"];

/** An Insight with the Python model's defaults and key order. */
export function insight(fields) {
  return {
    label: fields.label,
    value: fields.value,
    detail: fields.detail ?? "",
    id: fields.id ?? "",
    themes: fields.themes ?? [],
    score: fields.score ?? 0.0,
    why_for_you: fields.why_for_you ?? "",
    evidence: fields.evidence ?? "",
    follow_ups: fields.follow_ups ?? [],
  };
}

/** The segment filters without intent topics (topics are reported as a share, not filtered on). */
export function segmentOf(filters) {
  return { ...filters, intent_topics: [] };
}

function mix(rows, column, total, limit = 3) {
  const found = groupCount(rows, column, limit);
  return [found, found.map(([v, n]) => `${v} ${pyFloat(pct(n, total))}%`).join(", ")];
}

const TOPIC_THEMES = {
  "HR Platform Replacement": "hr", "Payroll Outsourcing": "hr", "CRM Migration": "crm",
  "Cloud Migration": "cloud", "ERP Upgrade": "erp", Cybersecurity: "tech",
  "Data Analytics": "tech", "Employee Experience": "hr",
};

function topicThemes(topic) {
  const switching = ["Replacement", "Migration", "Upgrade", "Outsourcing"].some((w) => topic.includes(w));
  return [...(switching ? ["displacement"] : []), "intent", "accounts", TOPIC_THEMES[topic] ?? "tech"];
}

const fmt0 = (x) => round(x).toFixed(0);

/** Every insight type for the segment described by filters, over the company rows. */
export function candidates(companies, filters) {
  const topics = [...(filters.intent_topics ?? [])];
  const rows = where(companies, segmentOf(filters));
  const total = rows.length;
  if (!total) {
    return [insight({
      id: "segment_size", label: "Matching companies", value: 0, themes: ["sizing"],
      detail: "No companies match these filters.",
      follow_ups: ["Widen the region or size band and try again"],
    })];
  }
  const found = [];

  const [countries, countryText] = mix(rows, "hq_country", total);
  found.push(insight({
    id: "segment_size", label: "Companies in this segment", value: total, themes: ["sizing"],
    detail: `Top countries: ${countryText}`,
    evidence: "count(*) over the segment filters",
    follow_ups: ["Which of these companies show buying intent right now?"],
  }));

  if (topics.length) {
    topics.forEach((topic, n) => {
      const on = rows.filter((r) => r.intent_topic === topic);
      const count = on.length;
      const score = avg(on.map((r) => r.intent_score));
      found.push(insight({
        id: n === 0 ? "topic_surge" : `topic_surge_${n + 1}`,
        label: `Researching ${topic}`, value: count, themes: topicThemes(topic),
        detail: count
          ? `${pyFloat(pct(count, total))}% of the segment, average surge score ${fmt0(score)}`
          : "No surge on this topic in the segment",
        evidence: `intent_topic = '${topic}'`,
        follow_ups: [`Which platforms do the companies researching ${topic} use today?`],
      }));
    });
  } else {
    const top = groupCount(rows, "intent_topic", 3);
    if (top.length) {
      found.push(insight({
        id: "top_topics", label: "What this segment is researching", value: top[0][0],
        themes: ["intent", "campaign"],
        detail: top.map(([t, n]) => `${t} (${n})`).join(", "),
        evidence: "intent_topic, grouped",
        follow_ups: [`Show companies researching ${top[0][0]}`],
      }));
    }
  }

  const hot = rows.filter((r) => r.intent_score !== null && r.intent_score >= 80).length;
  found.push(insight({
    id: "hot_accounts", label: "Hot accounts (surge score 80+)", value: hot,
    themes: ["accounts", "intent", "timing"],
    detail: `${pyFloat(pct(hot, total))}% of the segment is in a strong buying surge`,
    evidence: "intent_score >= 80",
    follow_ups: ["What are the hot accounts researching, and which HR platform do they run?"],
  }));

  const switchers = groupCount(
    rows.filter((r) => LEGACY_HR.includes(r.hr_platform) && SWITCH_TOPICS.includes(r.intent_topic)), "hr_platform");
  const switchTotal = switchers.reduce((s, [, n]) => s + n, 0);
  found.push(insight({
    id: "legacy_platform_switchers", label: "On a legacy HR platform and researching a switch",
    value: switchTotal, themes: ["displacement", "accounts", "hr", "intent"],
    detail: switchers.map(([p, n]) => `${p} (${n})`).join(", ") || "None right now",
    evidence: `hr_platform in ${pyList(LEGACY_HR)} and intent_topic in ${pyList(SWITCH_TOPICS)}`,
    follow_ups: ["When do these switchers' HR contracts renew?"],
  }));

  const renewing = rows.filter((r) => UPCOMING_RENEWALS.includes(r.renewal_quarter));
  const renewSpend = median(renewing.map((r) => r.annual_hr_tech_spend_usd));
  found.push(insight({
    id: "renewals_soon", label: `HR contract renews in ${UPCOMING_RENEWALS.join(" or ")}`,
    value: renewing.length, themes: ["timing", "accounts", "hr", "budget"],
    detail: `${pyFloat(pct(renewing.length, total))}% of the segment; median HR tech spend $${grouped(renewSpend || 0)}`,
    evidence: `renewal_quarter in ${pyList(UPCOMING_RENEWALS)}`,
    follow_ups: ["Which of the renewing companies are also showing intent?"],
  }));

  const spend = rows.map((r) => r.annual_hr_tech_spend_usd);
  const med = median(spend);
  const p75 = quantile(spend, 0.75);
  found.push(insight({
    id: "spend_profile", label: "Median HR tech spend", value: `$${grouped(med)}`,
    themes: ["budget", "sizing", "hr"],
    detail: `Top quarter spends $${grouped(p75)}+ a year; segment total about $${grouped((med * total) / 1e6, 1)}M`,
    evidence: "median and 75th percentile of annual_hr_tech_spend_usd",
    follow_ups: ["Which companies spend the most on HR tech?"],
  }));

  const growers = rows.filter((r) => r.revenue_growth_pct >= 20).length;
  found.push(insight({
    id: "growth_leaders", label: "Fast growers (20%+ revenue growth)", value: growers,
    themes: ["growth", "accounts", "sizing"],
    detail: `${pyFloat(pct(growers, total))}% of the segment is growing fast`,
    evidence: "revenue_growth_pct >= 20",
    follow_ups: ["What are the fast growers researching?"],
  }));

  const [, fundingText] = mix(rows, "funding_stage", total);
  found.push(insight({
    id: "funding_mix", label: "Funding stage mix", value: fundingText.split(",")[0],
    themes: ["growth", "budget"], detail: fundingText, evidence: "funding_stage, grouped",
    follow_ups: ["Show the growth of Series B and later companies"],
  }));

  // Country with the highest share of companies showing intent (at least 5 companies).
  const byCountry = new Map();
  for (const r of rows) {
    const g = byCountry.get(r.hq_country) ?? { n: 0, i: 0 };
    g.n += 1;
    if (r.intent_topic !== null) g.i += 1;
    byCountry.set(r.hq_country, g);
  }
  const hotspot = [...byCountry.entries()]
    .filter(([, g]) => g.n >= 5)
    .sort(([, a], [, b]) => b.i / b.n - a.i / a.n || b.n - a.n)[0];
  if (hotspot && countries.length > 1) { // pointless when the segment is one country
    const [country, { n, i }] = hotspot;
    found.push(insight({
      id: "country_hotspot", label: "Country with the most buying intent", value: country,
      themes: ["geo", "campaign", "intent"],
      detail: `${pyFloat(pct(i, n))}% of its ${n} companies show intent`,
      evidence: "share of companies with any intent_topic, by hq_country",
      follow_ups: [`Focus on ${country}: what are they researching?`],
    }));
  }

  const [, crmText] = mix(rows, "crm", total);
  found.push(insight({
    id: "crm_mix", label: "CRM in use", value: crmText.split(",")[0],
    themes: ["tech", "crm", "campaign"], detail: crmText, evidence: "crm, grouped",
    follow_ups: ["Which companies are researching a CRM migration?"],
  }));
  const [, erpText] = mix(rows, "erp", total);
  found.push(insight({
    id: "erp_mix", label: "ERP in use", value: erpText.split(",")[0],
    themes: ["tech", "erp", "sizing"], detail: erpText, evidence: "erp, grouped",
    follow_ups: ["How many are researching an ERP upgrade?"],
  }));
  const [, cloudText] = mix(rows, "cloud_provider", total);
  found.push(insight({
    id: "cloud_mix", label: "Primary cloud", value: cloudText.split(",")[0],
    themes: ["tech", "cloud"], detail: cloudText, evidence: "cloud_provider, grouped",
    follow_ups: ["Which companies are researching a cloud migration?"],
  }));

  const inMarket = rows.filter((r) => r.intent_topic !== null).length;
  found.push(insight({
    id: "intent_share", label: "Showing any buying intent", value: `${pyFloat(pct(inMarket, total))}%`,
    themes: ["intent", "sizing"], detail: `${inMarket} of ${total} companies`,
    evidence: "intent_topic is not null",
    follow_ups: ["Break the intent down by topic"],
  }));
  return found;
}

// ------------------------------------------------------------------- ranking

const ROLE_THEMES = [
  [/sales|business development|\bbdr\b|\bsdr\b|account exec/i, { accounts: 3, intent: 2, timing: 2, displacement: 2 }],
  [/customer success|account manag/i, { timing: 3, accounts: 2, displacement: 1 }],
  [/marketing|\babm\b|demand/i, { campaign: 3, intent: 2, geo: 2, tech: 1 }],
  [/revops|revenue operations|operations/i, { tech: 2, accounts: 2, crm: 2, timing: 1 }],
  [/analyst|strategy|research|consult/i, { sizing: 3, tech: 2, growth: 1, geo: 1 }],
  [/invest|partner|venture|corporate development/i, { growth: 3, sizing: 2, budget: 1 }],
  [/talent|recruit/i, { growth: 3, geo: 2 }],
  [/product/i, { tech: 2, intent: 2, sizing: 1 }],
];

const KEYWORD_THEMES = [
  [/pipeline|leads?\b|accounts?|target|prospect/i, { accounts: 2 }],
  [/switch|replac|displac|migrat|competitor/i, { displacement: 3, intent: 1 }],
  [/campaign|\babm\b|segment/i, { campaign: 2 }],
  [/\bsize\b|sizing|market|\btam\b/i, { sizing: 2 }],
  [/renew|contract|timing|\bwhen\b/i, { timing: 3 }],
  [/growth|growing|fund|invest/i, { growth: 3 }],
  [/\berp\b/i, { erp: 3 }],
  [/\bcrm\b/i, { crm: 3 }],
  [/cloud/i, { cloud: 3 }],
  [/\bhr\b|payroll|hris|hcm/i, { hr: 2 }],
  [/budget|spend|wallet/i, { budget: 3 }],
  [/countr|where|region|geograph/i, { geo: 2 }],
  [/intent|research|in[- ]market|buying/i, { intent: 2 }],
];

const ANGLE = {
  accounts: "it points to accounts you can act on",
  intent: "these companies are actively researching right now",
  timing: "it tells you when to reach out",
  displacement: "these look like switchers away from a competing platform",
  sizing: "it sizes the opportunity",
  growth: "it shows who has momentum and budget",
  tech: "it shows the stack you would integrate with or replace",
  campaign: "it tells you where to focus a campaign",
  geo: "it shows where to focus geographically",
  budget: "it shows what these companies can spend",
  hr: "it is about HR technology, your market",
  erp: "it covers the ERP stack you care about",
  crm: "it covers the CRM stack you care about",
  cloud: "it covers the cloud stack you care about",
};

const BASE = { segment_size: 1.5, topic_surge: 3.0 };
const CONTEXT_WEIGHT = 0.5;
const FOCUS_BONUS = 6;

function weights(table, text) {
  const out = {};
  if (!text) return out;
  for (const [pattern, themes] of table) {
    if (!pattern.test(text)) continue;
    for (const [theme, w] of Object.entries(themes)) out[theme] = Math.max(out[theme] ?? 0, w);
  }
  return out;
}

function goalsOf(shared) {
  const goals = shared.goals || [];
  return typeof goals === "string" ? [goals] : [...goals];
}

/** Insights ordered by what matters to the person, each with why_for_you. */
export function rank(found, need, shared) {
  shared = shared || {};
  const role = String(shared.role || "");
  const goals = goalsOf(shared);
  const sources = {
    role: weights(ROLE_THEMES, role),
    goal: weights(KEYWORD_THEMES, goals.join(" ")),
    industry: weights(KEYWORD_THEMES, String(shared.industry || "")),
    question: weights(KEYWORD_THEMES, need || ""),
  };
  // A theme the question asks for explicitly (weight 3) is the focus: an insight
  // that is primarily about it answers the question and goes first.
  const focus = new Set(Object.entries(sources.question).filter(([, w]) => w >= 3).map(([t]) => t));

  const ranked = found.map((item) => {
    const isSurge = item.id.startsWith("topic_surge");
    const base = isSurge ? BASE.topic_surge : BASE[item.id] ?? 1.0;
    const contributions = []; // [weight, source, theme]
    for (const [source, ws] of Object.entries(sources)) {
      for (const theme of item.themes) if (ws[theme]) contributions.push([ws[theme], source, theme]);
    }
    // Context (role, goals, industry) steers the order; the question decides it.
    const context = contributions.filter(([, s]) => s !== "question").reduce((t, [w]) => t + w, 0) * CONTEXT_WEIGHT;
    const asked = contributions.filter(([, s]) => s === "question").reduce((t, [w]) => t + w, 0);
    // A topic surge is the direct answer to "who is researching X" whatever X's theme is.
    const answers = item.themes.length > 0 &&
      (focus.has(item.themes[0]) || (isSurge && item.themes.some((t) => focus.has(t))));
    let score = base + context + asked + (answers ? FOCUS_BONUS : 0);
    if (item.value === 0 || item.value === "0" || item.value === "0.0%") score -= 2; // an empty finding is rarely the most useful one
    const answered = answers ? item.themes.find((t) => focus.has(t)) ?? null : null;
    return { ...item, score: round(score, 1), why_for_you: why(contributions, role, goals, answered) };
  });
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ranked;
}

const ORDER = { role: 0, goal: 1, question: 2, industry: 3 };

function why(contributions, role, goals, answeredTheme = null) {
  if (answeredTheme) {
    const angle = ANGLE[answeredTheme];
    if (contributions.some(([, s]) => s === "role")) return `As ${role}, ${angle}; it answers what you asked.`;
    return `Answers what you asked: ${angle}.`;
  }
  if (!contributions.length) return "General market view. Share your role or goals for a sharper ranking.";
  // max by (weight, -source order); the first one wins ties, as Python's max does.
  let best = contributions[0];
  for (const c of contributions.slice(1)) {
    if (c[0] > best[0] || (c[0] === best[0] && -ORDER[c[1]] > -ORDER[best[1]])) best = c;
  }
  const [, source, theme] = best;
  const angle = ANGLE[theme];
  if (source === "role") return `As ${role}, ${angle}.`;
  if (source === "goal") return `Supports your goal "${goals[0]}": ${angle}.`;
  if (source === "industry") return `Relevant to your industry: ${angle}.`;
  return `Matches your question: ${angle}.`;
}

export function personalised(companies, filters, need, shared, top = TOP_N) {
  return rank(candidates(companies, filters), need, shared).slice(0, top);
}
