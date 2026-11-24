// Agent-to-agent simulator: many personal agents, each with its own person's
// context, ask the Champions agent realistic questions over the real path
// (OAuth -> Agent Card -> A2A -> MCP -> feedback). Requests are tagged
// source="simulator" so the Champions query log can tell them apart.
// Port of personal/simulator.py.
//
// Consent is given automatically for the shareable fields and the target
// segment (never the private ones), as a real user would after a first prompt.
import { runTurn } from "./agent.js";
import { MemoryConsentStore, PERSONAS, defaultSharedFields } from "./profile.js";
import { SCENARIOS } from "./scenarios.js";
import { pyRound } from "./schemas.js";

export const AUTO_CONSENT = [...defaultSharedFields(), "target_segment"];

async function ask(persona, question, store, deps) {
  const opts = { ...deps, source: "simulator" };
  let result = await runTurn(persona, question, store, opts);
  if (result.status === "consent_required") {
    store.grant(persona, result.purpose, AUTO_CONSENT);
    result = await runTurn(persona, question, store, opts);
  }
  return result;
}

/** Runs the personas' scenarios sequentially; deps = {champions, config}. */
export async function run(deps, personas = Object.keys(SCENARIOS)) {
  const store = new MemoryConsentStore();
  const started = performance.now();
  const rows = [];
  for (const persona of personas) {
    for (const question of SCENARIOS[persona]) {
      const result = await ask(persona, question, store, deps);
      const ok = result.status === "ok";
      const insights = ok ? result.insights ?? [] : [];
      const catalog = ok ? result.catalog ?? {} : {};
      const useful = insights.filter((i) => i.useful);
      rows.push({
        persona,
        role: PERSONAS[persona].role,
        question,
        status: result.status,
        skill: result.skill ?? "",
        matching: catalog.matching_companies ?? 0,
        insights: insights.length,
        useful: useful.length,
        top_useful: useful.slice(0, 2).map((i) => `${i.label}: ${i.value}`),
        why: useful.length ? useful[0].why_for_you : "",
        gaps: catalog.gaps ?? [],
        error: result.error ?? "",
      });
    }
  }
  // On Workers the clock only advances across I/O, so this can read low.
  return report(rows, (performance.now() - started) / 1000);
}

function pct(a, b) {
  return b ? pyRound((100 * a) / b, 1) : 0.0;
}

export function report(rows, seconds) {
  const answered = rows.filter((r) => r.status === "ok" && r.matching > 0 && !r.gaps.includes("no_results"));
  const shown = rows.reduce((s, r) => s + r.insights, 0);
  const useful = rows.reduce((s, r) => s + r.useful, 0);
  const byPersona = new Map();
  for (const r of rows) {
    if (!byPersona.has(r.persona)) byPersona.set(r.persona, { persona: r.persona, role: r.role, questions: 0, insights: 0, useful: 0 });
    const g = byPersona.get(r.persona);
    g.questions += 1;
    g.insights += r.insights;
    g.useful += r.useful;
  }
  for (const g of byPersona.values()) g.useful_pct = pct(g.useful, g.insights);
  const gaps = new Map();
  for (const r of rows) for (const gap of r.gaps) gaps.set(gap, [...(gaps.get(gap) ?? []), r.question]);
  const best = rows
    .filter((r) => r.useful)
    .sort((a, b) => -a.useful / Math.max(a.insights, 1) + b.useful / Math.max(b.insights, 1) || (a.persona < b.persona ? -1 : a.persona > b.persona ? 1 : 0));
  return {
    conversations: rows.length,
    answered_pct: pct(answered.length, rows.length),
    insights_shown: shown,
    useful_pct: pct(useful, shown),
    seconds: pyRound(seconds, 1),
    by_persona: [...byPersona.values()].sort((a, b) => b.useful_pct - a.useful_pct),
    gaps: [...gaps.entries()].sort((a, b) => b[1].length - a[1].length).map(([gap, qs]) => ({ gap, count: qs.length, examples: qs.slice(0, 3) })),
    examples: best.slice(0, 6),
    rows,
  };
}

/** The Markdown report Python writes to reports/simulation.md. */
export function markdown(r) {
  const lines = [
    "# Agent-to-agent simulation",
    "",
    `${r.conversations} conversations from ${r.by_persona.length} personal agents in ${r.seconds} s.`,
    "",
    "| Metric | Value |", "|---|---|",
    `| Questions answered with data | ${r.answered_pct}% |`,
    `| Insights shown | ${r.insights_shown} |`,
    `| Judged useful by the person's own agent | ${r.useful_pct}% |`,
    "",
    "## Usefulness by persona", "",
    "| Persona | Role | Questions | Useful insights |", "|---|---|---|---|",
    ...r.by_persona.map((g) => `| ${g.persona} | ${g.role} | ${g.questions} | ${g.useful}/${g.insights} (${g.useful_pct}%) |`),
    "", "## Where the Champions agent falls short", "",
  ];
  const gapLines = r.gaps.map((g) => `- **${g.gap}** (${g.count}): e.g. "${g.examples[0]}"`);
  lines.push(...(gapLines.length ? gapLines : ["- none"]));
  lines.push("", "## Examples of useful answers", "");
  for (const e of r.examples) {
    lines.push(`- **${e.persona}** asked "${e.question}" → ${e.top_useful.join("; ")}. _${e.why}_`);
  }
  return lines.join("\n") + "\n";
}
