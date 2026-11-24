// Judges which of Champions' insights are actually useful to *this* person.
// Port of personal/judge.py.
//
// Runs inside the Personal Agent with the full private profile: notes,
// must-have fields, goals and role. Only the yes/no ratings go back to
// Champions (as feedback); the reasons stay here.

const PLATFORMS = ["ADP", "Oracle HCM", "Workday", "SAP SuccessFactors", "BambooHR", "Personio", "UKG", "Dayforce",
  "Salesforce", "HubSpot", "Microsoft Dynamics", "Zoho", "SAP S/4HANA", "Oracle NetSuite", "Infor",
  "AWS", "Azure", "Google Cloud", "Series B", "Series C", "Ireland", "United Kingdom", "India",
  "Australia"];

// Which insights carry each must-have field.
const FIELD_INSIGHTS = {
  intent_score: ["hot_accounts", "topic_surge", "intent_share"],
  intent_topic: ["topic_surge", "top_topics", "intent_share", "country_hotspot"],
  hr_platform: ["legacy_platform_switchers"],
  employee_count: ["segment_size", "growth_leaders"],
  erp: ["erp_mix"],
  crm: ["crm_mix"],
  cloud_provider: ["cloud_mix"],
  revenue_usd_m: ["growth_leaders", "spend_profile"],
  funding_stage: ["funding_mix"],
};

const GOAL_THEMES = [
  [/pipeline|accounts?|leads?/i, "accounts"],
  [/switch|replac|moving|migrat/i, "displacement"],
  [/campaign|\babm\b/i, "campaign"],
  [/\bsize\b|market/i, "sizing"],
  [/renew/i, "timing"],
  [/grow|invest/i, "growth"],
  [/\berp\b/i, "erp"],
  [/\bcrm\b|territor/i, "crm"],
  [/cloud/i, "cloud"],
  [/payroll|\bhr\b/i, "hr"],
  [/hiring/i, "growth"],
];

/** Python: value in (0, "0", "0.0%", "") or a string starting with "0 ". */
function isEmptyValue(value) {
  return value === 0 || value === false || value === "0" || value === "0.0%" || value === "" ||
    (typeof value === "string" && value.startsWith("0 "));
}

/** [{insight_id, useful, reason}] in the same order as insights. */
export function judge(insights, profile, question = "") {
  const notes = profile.private_notes ?? "";
  const noted = PLATFORMS.filter((p) => notes.toLowerCase().includes(p.toLowerCase()));
  const must = profile.must_have_fields ?? [];
  const goalText = (profile.goals ?? []).join(" ") + " " + (question ?? "");
  const goalThemes = new Set(GOAL_THEMES.filter(([re]) => re.test(goalText)).map(([, t]) => t));
  const noOutreach = /no outreach/i.test(notes);

  return insights.map((insight, rank) => {
    let points = 0;
    let reasons = [];
    const text = `${insight.label} ${insight.value} ${insight.detail}`.toLowerCase();
    const hits = noted.filter((p) => text.includes(p.toLowerCase()));
    if (hits.length) {
      points += 2;
      reasons.push(`mentions ${hits.join(", ")}, which your private notes prioritise`);
    }
    const fields = must.filter((f) => (FIELD_INSIGHTS[f] ?? []).some((i) => insight.id.startsWith(i)));
    if (fields.length) {
      points += 2;
      reasons.push(`covers your must-have field ${fields.join(", ")}`);
    }
    const themes = [...goalThemes].filter((t) => insight.themes.includes(t));
    if (themes.length) {
      points += 1;
      reasons.push(`serves your goal (${themes.sort().join(", ")})`);
    }
    if (rank < 2 && insight.score >= 6) {
      points += 1;
      reasons.push("Champions ranked it highly for your role");
    }
    if (noOutreach && insight.themes.includes("accounts") && !themes.length) {
      points -= 1;
      reasons.push("your notes say no outreach is planned");
    }
    if (isEmptyValue(insight.value)) {
      points = -1;
      reasons = ["nothing found for this segment"];
    }
    const useful = points >= 2;
    return {
      insight_id: insight.id,
      useful,
      reason: (useful ? "Useful: " : "Less useful: ") + (reasons.join("; ") || "not tied to your goals or must-haves"),
    };
  });
}
