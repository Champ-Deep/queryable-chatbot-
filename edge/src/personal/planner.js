// Turns the user's question into a CapabilityRequest (rule-based, no LLM).
// Port of personal/planner.py.
//
// Filters come from the question itself. The user's stored target segment is
// used only when they consented to share it ("target_segment"), because filters
// travel to Champions too.
import { capabilityRequest, filters as emptyFilters } from "./schemas.js";

const INDUSTRIES = [
  [/health\s?care|hospital|clinic|medical|pharma/, "Healthcare"],
  [/financ\w*|bank\w*|insur\w*|fintech/, "Financial Services"],
  [/manufactur\w*|industrial|automotive|factor\w*/, "Manufacturing"],
  [/retail\w*|e-?commerce|shop\w*/, "Retail"],
  [/tech(nology)? compan\w*|software|saas|it services/, "Technology"],
  [/educat\w*|universit\w*|school\w*/, "Education"],
  [/logistic\w*|freight|warehous\w*|shipping/, "Logistics"],
  [/energy|utilit\w*|renewabl\w*|oil/, "Energy"],
];

const REGIONS = [
  [/europe\w*|\beu\b|emea/, "EMEA"],
  [/north america|\bus\b|\busa\b|united states|canada/, "NA"],
  [/apac|asia\w*|pacific/, "APAC"],
  [/latam|latin america|south america/, "LATAM"],
];

const COUNTRIES = [
  [/\buk\b|united kingdom|britain|british/, "United Kingdom"],
  [/german\w*/, "Germany"],
  [/france|french/, "France"],
  [/\bindia\w*/, "India"],
  [/japan\w*/, "Japan"],
  [/singapore/, "Singapore"],
  [/australia\w*/, "Australia"],
  [/ireland|irish/, "Ireland"],
  [/netherlands|dutch/, "Netherlands"],
  [/spain|spanish/, "Spain"],
  [/sweden|swedish/, "Sweden"],
  [/\bital(y|ian)\b/, "Italy"],
  [/brazil\w*/, "Brazil"],
  [/mexic\w*/, "Mexico"],
];

const SIZES = [
  [/\bsmall\b|\bsmb\b|startups?/, "SMB"],
  [/mid[- ]?(size|sized|market)|medium/, "Mid-market"],
  [/enterprise\w*|\blarge\b/, "Enterprise"],
];

const TOPICS = [
  [/(switch|replac|chang|migrat)\w* (their |an? )?(hr|hris|hcm)|hr platform/, "HR Platform Replacement"],
  [/payroll/, "Payroll Outsourcing"],
  [/crm/, "CRM Migration"],
  [/cloud migration|moving to (the )?cloud/, "Cloud Migration"],
  [/cyber\w*|security/, "Cybersecurity"],
  [/\berp\b/, "ERP Upgrade"],
  [/analytics|data platform/, "Data Analytics"],
];

const OUTPUTS = [
  [/contacts?|emails?|decision[- ]makers?|people to (contact|reach)|outreach/, "contacts"],
  [/tech\w*|stack|platform|crm|erp|cloud/, "technographics"],
  [/intent|switch\w*|replac\w*|in[- ]market|buying/, "intent_signals"],
  [/budget|spend|renewal/, "hr_tech_spend"],
  [/revenue|funding|growth/, "financials"],
];

/** Sorted distinct values whose pattern occurs in the text. */
function found(table, text) {
  return [...new Set(table.filter(([re]) => re.test(text)).map(([, v]) => v))].sort();
}

/** [CapabilityRequest without context, purpose]. */
export function plan(question, profile, consentedFields) {
  const text = (question ?? "").toLowerCase();

  // Both branches of the Python version map to get_insights unless it is a catalog question.
  const skill = /what (data|can)|capabilit\w*|what do you (have|offer)|which data cards exist|catalog/.test(text)
    ? "describe_capabilities"
    : "get_insights";

  const filters = emptyFilters({
    industries: found(INDUSTRIES, text),
    regions: found(REGIONS, text),
    countries: found(COUNTRIES, text),
    size_bands: found(SIZES, text),
    intent_topics: found(TOPICS, text),
  });
  if (consentedFields.includes("target_segment") && skill !== "describe_capabilities") {
    const target = profile.target_segment ?? {};
    for (const key of ["industries", "regions", "countries", "size_bands"]) {
      if (!filters[key].length && target[key]?.length) filters[key] = [...target[key]];
    }
  }

  const outputs = found(OUTPUTS, text);
  const purpose = outputs.includes("contacts") ? "outreach" : skill === "get_insights" ? "market_insights" : "data_discovery";

  const request = capabilityRequest({ skill, need: (question ?? "").trim(), filters, desired_outputs: outputs });
  return [request, purpose];
}
