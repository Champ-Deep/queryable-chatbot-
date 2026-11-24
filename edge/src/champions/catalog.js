// Mock Champions Group data catalog: data cards and their VAF fields (port of champions/catalog.py).
// Synthetic, for the demo only. VAF (value-added field) entries describe each field's type,
// coverage and refresh cadence so a buyer's agent can judge fit before buying.

import { round } from "./pyfmt.js";

const f = (name, type, description, coverage_pct, refresh, example = null) =>
  ({ name, type, description, coverage_pct, refresh, example });

export const CARDS = [
  {
    id: "firmographics",
    name: "Firmographics",
    description: "Core company profile: industry, size, location and structure.",
    contains_personal_data: false,
    credits_per_1k_records: 40,
    delivery: ["API", "CSV", "CRM sync"],
    refresh: "monthly",
    vaf_fields: [
      f("company_name", "string", "Registered trading name", 99.8, "monthly", "Northwind Health GmbH"),
      f("domain", "string", "Primary web domain", 97.5, "monthly", "northwind-health.example"),
      f("industry", "enum", "Champions industry taxonomy (L1)", 99.1, "monthly", "Healthcare"),
      f("sub_industry", "enum", "Industry taxonomy (L2)", 91.4, "monthly", "Hospitals & Clinics"),
      f("hq_country", "string", "Headquarters country", 99.6, "monthly", "Germany"),
      f("region", "enum", "Sales region (EMEA, NA, APAC, LATAM)", 99.6, "monthly", "EMEA"),
      f("employee_count", "integer", "Modelled global headcount", 94.2, "monthly", 820),
      f("size_band", "enum", "SMB / Mid-market / Enterprise", 94.2, "monthly", "Mid-market"),
      f("founded_year", "integer", "Year founded", 88.0, "quarterly", 2004),
      f("ownership", "enum", "Public, private, PE-backed, non-profit", 86.3, "quarterly", "Private"),
    ],
  },
  {
    id: "technographics",
    name: "Technographics",
    description: "Installed technology by category, detected from 40+ signal sources.",
    contains_personal_data: false,
    credits_per_1k_records: 75,
    delivery: ["API", "CSV"],
    refresh: "weekly",
    vaf_fields: [
      f("hr_platform", "string", "Primary HRIS / HCM platform", 83.5, "weekly", "Workday"),
      f("crm", "string", "CRM in use", 87.9, "weekly", "Salesforce"),
      f("erp", "string", "ERP in use", 79.2, "weekly", "SAP S/4HANA"),
      f("cloud_provider", "string", "Primary cloud", 81.0, "weekly", "Azure"),
      f("security_stack", "list", "Detected security vendors", 64.7, "weekly", "CrowdStrike, Okta"),
      f("tech_spend_band", "enum", "Modelled annual IT spend band", 72.4, "monthly", "$1M-$5M"),
      f("install_first_seen", "date", "When each product was first detected", 83.5, "weekly", "2021-03-14"),
    ],
  },
  {
    id: "intent_signals",
    name: "Intent Signals",
    description: "Topic-level buying intent from content consumption and job postings.",
    contains_personal_data: false,
    credits_per_1k_records: 120,
    delivery: ["API", "CRM sync"],
    refresh: "daily",
    vaf_fields: [
      f("intent_topic", "enum", "Topic showing elevated research", 68.0, "daily", "HR Platform Replacement"),
      f("intent_score", "integer", "0-100 surge score vs. baseline", 68.0, "daily", 82),
      f("surge_start", "date", "First day of the current surge", 68.0, "daily", "2026-10-21"),
      f("hiring_signal", "string", "Related job postings detected", 55.3, "daily", "HRIS Project Manager"),
      f("competitor_research", "list", "Vendors being researched", 49.8, "daily", "SAP SuccessFactors, Workday"),
    ],
  },
  {
    id: "hr_tech_spend",
    name: "HR Tech Spend",
    description: "Modelled HR technology budget, contract timing and vendor mix.",
    contains_personal_data: false,
    credits_per_1k_records: 90,
    delivery: ["API", "CSV"],
    refresh: "quarterly",
    vaf_fields: [
      f("annual_hr_tech_spend_usd", "number", "Modelled annual HR tech spend", 76.1, "quarterly", 412000),
      f("contract_renewal_window", "string", "Estimated renewal quarter of main HR contract", 58.9, "quarterly", "2027-Q1"),
      f("deployment_type", "enum", "SaaS / Hybrid / On-premise", 81.7, "quarterly", "Hybrid"),
      f("vendor_count", "integer", "HR vendors in use", 70.2, "quarterly", 6),
    ],
  },
  {
    id: "financials",
    name: "Financials",
    description: "Revenue, growth and funding for public and private companies.",
    contains_personal_data: false,
    credits_per_1k_records: 60,
    delivery: ["API", "CSV"],
    refresh: "quarterly",
    vaf_fields: [
      f("revenue_usd_m", "number", "Annual revenue (USD millions, modelled for private)", 84.4, "quarterly", 145.0),
      f("revenue_growth_pct", "number", "Year-on-year revenue growth", 71.8, "quarterly", 12.5),
      f("funding_stage", "enum", "Latest funding stage", 62.0, "monthly", "Series C"),
      f("total_funding_usd_m", "number", "Total disclosed funding", 58.3, "monthly", 88.0),
    ],
  },
  {
    id: "contacts",
    name: "Contacts",
    description:
      "Business contacts by role and seniority. Personal data: requires the " +
      "'outreach' purpose, a data processing agreement and the contacts:read scope.",
    contains_personal_data: true,
    credits_per_1k_records: 250,
    delivery: ["API", "CRM sync"],
    refresh: "weekly",
    vaf_fields: [
      f("full_name", "string", "Contact name (masked in samples)", 92.0, "weekly", "J*** D***"),
      f("job_title", "string", "Normalised job title", 95.5, "weekly", "VP People"),
      f("seniority", "enum", "C-level, VP, Director, Manager", 95.5, "weekly", "VP"),
      f("department", "enum", "Function (HR, IT, Finance, Sales...)", 95.1, "weekly", "HR"),
      f("business_email", "string", "Verified business e-mail (masked in samples)", 78.4, "weekly", "j***@example.com"),
      f("email_verified_at", "date", "Last verification date", 78.4, "weekly", "2026-11-02"),
    ],
  },
];

export const BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

/** Average coverage across a card's VAF fields. */
export function cardCoverage(card) {
  return round(card.vaf_fields.reduce((s, x) => s + x.coverage_pct, 0) / card.vaf_fields.length, 1);
}
