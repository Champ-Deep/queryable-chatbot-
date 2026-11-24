// Synthetic company records behind the catalog (port of champions/data.py).
// Seeded, so results are stable per seed. Python held them in DuckDB; here they are a plain
// array and the aggregates are plain JS. Only aggregates and a few masked sample rows ever
// leave the Champions agent; there is no bulk export path.

import { Rng } from "../common/rng.js";
import { round } from "./pyfmt.js";

export const SEED = 20261110;
export const N_COMPANIES = 2400;

export const INDUSTRIES = {
  Healthcare: ["Hospitals & Clinics", "Medical Devices", "Pharma", "Health Insurance"],
  "Financial Services": ["Banking", "Insurance", "Asset Management", "Fintech"],
  Manufacturing: ["Industrial Machinery", "Automotive", "Chemicals", "Electronics"],
  Retail: ["E-commerce", "Grocery", "Apparel", "Home & Garden"],
  Technology: ["SaaS", "IT Services", "Semiconductors", "Cybersecurity"],
  Education: ["Higher Education", "EdTech", "K-12"],
  Logistics: ["Freight", "Warehousing", "Last-mile Delivery"],
  Energy: ["Renewables", "Oil & Gas", "Utilities"],
};

export const COUNTRIES = {
  EMEA: ["Germany", "United Kingdom", "France", "Netherlands", "Spain", "Sweden", "Italy", "Ireland"],
  NA: ["United States", "Canada"],
  APAC: ["India", "Singapore", "Australia", "Japan"],
  LATAM: ["Brazil", "Mexico"],
};

export const HR_PLATFORMS = ["Workday", "SAP SuccessFactors", "Oracle HCM", "BambooHR", "Personio", "ADP", "UKG", "Dayforce"];
export const CRMS = ["Salesforce", "HubSpot", "Microsoft Dynamics", "Zoho"];
export const ERPS = ["SAP S/4HANA", "Oracle NetSuite", "Microsoft Dynamics 365", "Infor"];
export const CLOUDS = ["AWS", "Azure", "Google Cloud"];
export const INTENT_TOPICS = [
  "HR Platform Replacement", "Payroll Outsourcing", "CRM Migration", "Cloud Migration",
  "Cybersecurity", "ERP Upgrade", "Data Analytics", "Employee Experience",
];
export const FUNDING = ["Bootstrapped", "Seed", "Series A", "Series B", "Series C", "Private Equity", "Public"];

const NAME_A = ["North", "Blue", "Silver", "Bright", "Clear", "Summit", "Harbor", "Nova", "Apex", "Vertex",
  "Cedar", "Atlas", "Orion", "Lumen", "Pioneer", "Evergreen"];
const NAME_B = ["wind", "stone", "bridge", "field", "point", "line", "gate", "path", "wave", "peak"];

export const RENEWAL_QUARTERS = ["2026-Q4", "2027-Q1", "2027-Q2", "2027-Q3", "2027-Q4"];
export const UPCOMING_RENEWALS = RENEWAL_QUARTERS.slice(0, 2);

export function sizeBand(employees) {
  if (employees < 200) return "SMB";
  if (employees < 2000) return "Mid-market";
  return "Enterprise";
}

/** The N_COMPANIES synthetic rows, in the same draw order as the Python generator. */
export function generateCompanies() {
  const rng = new Rng(SEED);
  // Columns added later use their own generator, so the original values stay the same.
  const extra = new Rng(SEED + 1);
  const industries = Object.keys(INDUSTRIES);
  const regions = Object.keys(COUNTRIES);
  const rows = [];
  for (let i = 1; i <= N_COMPANIES; i++) {
    const industry = rng.choice(industries);
    const region = rng.weighted(regions, [45, 35, 15, 5]);
    const country = rng.choice(COUNTRIES[region]);
    const employees = Math.trunc(rng.lognormvariate(6.3, 1.2)) + 10;
    const hr = rng.choice(HR_PLATFORMS);
    let topic = rng.random() < 0.68 ? rng.choice(INTENT_TOPICS) : null;
    if (topic === null && (hr === "ADP" || hr === "Oracle HCM") && rng.random() < 0.5) topic = "HR Platform Replacement";
    const num = String(i).padStart(4, "0");
    const name = `${rng.choice(NAME_A)}${rng.choice(NAME_B)} ${rng.choice(INDUSTRIES[industry]).split(" ")[0]} ${num}`;
    rows.push({
      company_id: `CG-${String(i).padStart(5, "0")}`,
      company_name: name,
      industry,
      sub_industry: rng.choice(INDUSTRIES[industry]),
      hq_country: country,
      region,
      employee_count: employees,
      size_band: sizeBand(employees),
      hr_platform: hr,
      crm: rng.choice(CRMS),
      erp: rng.choice(ERPS),
      cloud_provider: rng.choice(CLOUDS),
      intent_topic: topic,
      intent_score: topic ? rng.randint(55, 98) : null,
      revenue_usd_m: round(employees * rng.uniform(0.08, 0.35), 1),
      funding_stage: rng.choice(FUNDING),
      annual_hr_tech_spend_usd: round(employees * rng.uniform(250, 900)),
      deployment_type: rng.choice(["SaaS", "Hybrid", "On-premise"]),
      renewal_quarter: extra.choice(RENEWAL_QUARTERS),
      revenue_growth_pct: round(extra.gauss(9, 14), 1),
    });
  }
  return rows;
}

// --------------------------------------------------------------- aggregates
// Replacements for the DuckDB SQL: filters are {industries, regions, countries, size_bands, intent_topics}.

const FILTER_COLUMNS = [
  ["industries", "industry"],
  ["regions", "region"],
  ["countries", "hq_country"],
  ["size_bands", "size_band"],
  ["intent_topics", "intent_topic"],
];

/** Rows matching every non-empty filter list (the Python _where clause). */
export function where(rows, filters) {
  const active = FILTER_COLUMNS.filter(([key]) => filters[key]?.length).map(([key, col]) => [col, new Set(filters[key])]);
  if (!active.length) return rows;
  return rows.filter((r) => active.every(([col, values]) => values.has(r[col])));
}

/** count(*) ... GROUP BY column ORDER BY n DESC, column [LIMIT limit] -> [[value, n], ...]. */
export function groupCount(rows, column, limit = Infinity) {
  const counts = new Map();
  for (const r of rows) {
    const v = r[column];
    if (v === null || v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit);
}

/** quantile_cont (linear interpolation); median = quantile(0.5). null for no rows. */
export function quantile(values, q) {
  const xs = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function median(values) {
  return quantile(values, 0.5);
}

/** avg() over non-null values, null for none. */
export function avg(values) {
  const xs = values.filter((v) => v !== null && v !== undefined);
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
