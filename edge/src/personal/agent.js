// The Personal Agent's turn: plan -> consent gate -> A2A -> MCP -> evaluate -> judge -> feedback.
// Port of personal/agent.py.
import { ChampionsClient, ChampionsError, Wire } from "./client.js";
import { evaluate } from "./evaluator.js";
import { judge } from "./judge.js";
import { plan } from "./planner.js";
import { FIELDS, PURPOSES, defaultSharedFields, getProfile, privateFields, sharedContext } from "./profile.js";
import { userContext } from "./schemas.js";

function consentPrompt(purpose, profile, wire) {
  const fields = Object.entries(FIELDS).map(([name, [cls, label]]) => ({
    name, label, class: cls,
    default: cls === "shareable",
    preview: cls === "private" ? null : profile[name] ?? null,
  }));
  wire.local("Consent", `Consent needed for purpose '${purpose}'`, {
    purpose,
    would_share_by_default: defaultSharedFields(),
    never_shared: privateFields(),
  });
  return { status: "consent_required", purpose, purpose_label: PURPOSES[purpose], fields, wire: wire.events };
}

function answerText(request, catalog, rec, insights) {
  if (request.skill === "describe_capabilities") {
    const names = catalog.matches.map((m) => m.name).join(", ");
    const best = rec.options.slice(0, 2).map((o) => o.name);
    return `Champions offers ${catalog.matches.length} data cards (${names}) with ` +
      `${catalog.insights[1]?.value} VAF fields in total. ` +
      `Best fits for your profile: ${best.join(" and ")}. ` +
      "Ask about a specific segment and I'll check what fits your budget.";
  }
  const useful = insights.filter((i) => i.useful);
  const lines = [`Champions found ${catalog.matching_companies} matching companies and ranked ` +
    `${insights.length} insights for you. ${useful.length} look useful to you:`];
  for (const i of useful.slice(0, 3)) lines.push(`• ${i.label}: ${i.value}` + (i.detail ? ` (${i.detail})` : ""));
  if (catalog.gaps.includes("segment_not_understood")) {
    lines.push("I couldn't tell which segment you mean, so this covers every company. " +
      "Name an industry, region or size to narrow it.");
  }
  if (catalog.gaps.includes("contacts_not_available")) {
    lines.push("Champions doesn't hand out contacts over this channel; that needs the Contacts card " +
      "with a data processing agreement.");
  }
  if (catalog.gaps.includes("topic_not_tracked")) {
    lines.push("Champions doesn't track that signal yet, so these are the closest insights it has.");
  }
  lines.push(rec.summary);
  return lines.join("\n");
}

function judgedInsights(catalog, judged) {
  const byId = new Map(judged.map((j) => [j.insight_id, j]));
  const rows = catalog.insights
    .filter((i) => byId.has(i.id))
    .map((i) => ({ ...i, useful: byId.get(i.id).useful, reason: byId.get(i.id).reason }));
  rows.sort((a, b) => Number(!a.useful) - Number(!b.useful)); // useful first, Champions' order within
  return rows;
}

function followUps(insights) {
  const seen = [];
  for (const i of insights) for (const q of i.follow_ups) if (!seen.includes(q)) seen.push(q);
  return seen.slice(0, 3);
}

/**
 * One turn for a persona.
 * @param consents ConsentStore (or MemoryConsentStore)
 * @param champions async (Request) => Response
 * @param config {championsBase, clientId, clientSecret}
 * @param source "live" | "simulator" (tags the CapabilityRequest, as in Python)
 */
export async function runTurn(persona, question, consents, { champions, config, source = "live" }) {
  const wire = new Wire();
  const profile = getProfile(persona);

  let [request, purpose] = plan(question, profile, []);
  const consent = consents.active(persona, purpose);
  if (consent === null) return consentPrompt(purpose, profile, wire);

  [request] = plan(question, profile, consent.fields);
  request.source = source;
  const shared = sharedContext(profile, consent);
  request.context = userContext({ consent_id: consent.consent_id, purpose, shared });
  wire.local("Consent", `Consent ${consent.consent_id} covers '${purpose}'`, {
    sending: Object.keys(shared).sort(),
    kept_private: Object.keys(FIELDS).filter((f) => !consent.fields.includes(f)).sort(),
  });
  const { context, ...planned } = request;
  wire.local("Plan", `Skill ${request.skill}`, planned);

  const client = new ChampionsClient(wire, champions, config);
  let catalog;
  const vafDetails = {};
  try {
    catalog = await client.ask(request);
    const mustHave = new Set(profile.must_have_fields ?? []);
    for (const match of catalog.matches.slice(0, 3)) {
      const details = await client.mcpTool("get_vaf_fields", { card_id: match.card_id });
      vafDetails[match.card_id] = (details.vaf_fields ?? []).map((f) => f.name);
    }
    wire.local("Evaluate", "Checked must-have fields against VAF definitions (private)", {
      must_have_fields: "(private, not sent)",
      found_in: Object.fromEntries(Object.entries(vafDetails).map(([cid, names]) => [cid, [...new Set(names)].filter((n) => mustHave.has(n)).sort()])),
    });
  } catch (error) {
    if (!(error instanceof ChampionsError)) throw error;
    wire.local("Error", error.message);
    return { status: "error", error: error.message, wire: wire.events };
  }

  let judged = [];
  if (request.skill !== "describe_capabilities" && catalog.insights.length) {
    judged = judge(catalog.insights, profile, question);
    const useful = judged.filter((j) => j.useful).length;
    const ratings = Object.fromEntries(judged.map((j) => [j.insight_id, j.useful]));
    wire.local("Judge", `${useful} of ${judged.length} insights are useful to you (reasons stay private)`, {
      ratings,
      reasons: "(private, not sent)",
    });
    if (catalog.query_id) {
      try {
        await client.feedback(catalog.query_id, ratings);
      } catch (error) {
        if (!(error instanceof ChampionsError)) throw error;
        wire.local("Error", `Feedback not delivered: ${error.message}`);
      }
    }
  }
  const insights = judgedInsights(catalog, judged);

  const rec = evaluate(catalog, profile, vafDetails);
  if (request.skill === "describe_capabilities") {
    rec.summary = "How each Champions data card fits your profile. " +
      "Nothing to buy yet: ask about a segment for a budgeted bundle.";
  }
  wire.local("Recommend", rec.summary, { bundle: rec.bundle, credits: rec.bundle_monthly_credits });
  return {
    status: "ok",
    answer: answerText(request, catalog, rec, insights),
    insights,
    follow_ups: followUps(insights),
    skill: request.skill,
    catalog,
    recommendation: rec,
    consent,
    wire: wire.events,
  };
}
