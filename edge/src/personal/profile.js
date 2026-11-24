// The user's private profile and consent records (held only by the Personal Agent).
// Port of personal/profile.py.
//
// Each profile field has a sharing class:
//   shareable  may be sent to Champions if the user consents (on by default)
//   opt_in     may be sent only if the user ticks it (off by default)
//   private    never leaves the Personal Agent (budget, notes, must-haves)
import { randomHex } from "../common/http.js";

/** name -> [class, label], in display order. */
export const FIELDS = {
  industry: ["shareable", "Your industry"],
  role: ["shareable", "Your role"],
  region: ["shareable", "Your sales region"],
  goals: ["shareable", "What you are trying to achieve"],
  target_segment: ["opt_in", "Industries, regions and sizes you sell to"],
  company_name: ["opt_in", "Your company's name"],
  budget_monthly_credits: ["private", "Monthly data budget"],
  must_have_fields: ["private", "Fields you require"],
  compliance: ["private", "Your data-protection policy"],
  private_notes: ["private", "Internal notes"],
};

export const PURPOSES = {
  data_discovery: "Find which Champions data cards fit a need",
  market_insights: "Get aggregate market insights for a segment",
  outreach: "Prepare contact-level outreach (personal data)",
};

export const PERSONAS = {
  priya: {
    display: "Priya, Head of Sales at an HR-software vendor (Berlin)",
    industry: "HR Software",
    role: "Head of Sales",
    region: "EMEA",
    goals: ["Build pipeline with companies replacing their HR platform"],
    target_segment: { industries: ["Healthcare"], regions: ["EMEA"], size_bands: ["Mid-market"] },
    company_name: "PeopleFlow GmbH",
    budget_monthly_credits: 600,
    must_have_fields: ["intent_score", "hr_platform", "employee_count"],
    compliance: "gdpr_strict",
    freshness: "weekly",
    private_notes: "Q1 quota at risk; prioritise accounts on ADP or Oracle HCM.",
  },
  marcus: {
    display: "Marcus, Marketing Ops at a UK fintech (London)",
    industry: "Fintech",
    role: "Marketing Operations Manager",
    region: "EMEA",
    goals: ["Run an ABM campaign for payroll products"],
    target_segment: {
      industries: ["Financial Services", "Technology"],
      countries: ["United Kingdom"],
      size_bands: ["SMB", "Mid-market"],
    },
    company_name: "Ledgerly Ltd",
    budget_monthly_credits: 300,
    must_have_fields: ["intent_topic", "crm"],
    compliance: "standard",
    freshness: "monthly",
    private_notes: "CMO wants CRM-synced lists before the March launch.",
  },
  aiko: {
    display: "Aiko, Strategy Analyst at a manufacturer (Tokyo)",
    industry: "Manufacturing",
    role: "Strategy Analyst",
    region: "APAC",
    goals: ["Size the APAC market for cloud ERP"],
    target_segment: { industries: ["Manufacturing"], regions: ["APAC"] },
    company_name: "Kanto Precision KK",
    budget_monthly_credits: 1000,
    must_have_fields: ["erp", "revenue_usd_m"],
    compliance: "standard",
    freshness: "quarterly",
    private_notes: "Board deck due end of month; no outreach planned.",
  },
  dev: {
    display: "Dev, RevOps Lead at a US SaaS company (Austin)",
    industry: "Sales Software",
    role: "Revenue Operations Lead",
    region: "NA",
    goals: ["Fix territory planning with accurate CRM and tech data"],
    target_segment: { industries: ["Technology"], regions: ["NA"] },
    company_name: "Quotient Labs Inc",
    budget_monthly_credits: 800,
    must_have_fields: ["crm", "employee_count"],
    compliance: "standard",
    freshness: "weekly",
    private_notes: "Our Salesforce has 30% duplicate accounts; HubSpot users are the priority segment.",
  },
  sofia: {
    display: "Sofia, Partner at a growth-equity fund (Amsterdam)",
    industry: "Private Equity",
    role: "Investment Partner",
    region: "EMEA",
    goals: ["Find fast-growing mid-market companies to invest in"],
    target_segment: { regions: ["EMEA"], size_bands: ["Mid-market"] },
    company_name: "Keizer Growth Partners",
    budget_monthly_credits: 500,
    must_have_fields: ["revenue_usd_m", "funding_stage"],
    compliance: "standard",
    freshness: "quarterly",
    private_notes: "Thesis: Series B and Series C companies in healthcare and logistics; avoid public companies.",
  },
  liam: {
    display: "Liam, Talent Acquisition Lead at a logistics group (Dublin)",
    industry: "Logistics",
    role: "Talent Acquisition Lead",
    region: "EMEA",
    goals: ["Map growing companies we compete with for hiring"],
    target_segment: { industries: ["Logistics"], regions: ["EMEA"] },
    company_name: "Shannon Freight",
    budget_monthly_credits: 200,
    must_have_fields: ["employee_count"],
    compliance: "gdpr_strict",
    freshness: "monthly",
    private_notes: "Board wants a hiring-competition map for Ireland and the United Kingdom.",
  },
  noor: {
    display: "Noor, Product Marketing at a cybersecurity vendor (Toronto)",
    industry: "Cybersecurity",
    role: "Product Marketing Manager",
    region: "NA",
    goals: ["Plan an ABM campaign for companies researching cybersecurity"],
    target_segment: { industries: ["Financial Services", "Healthcare"], regions: ["NA"] },
    company_name: "Northguard Security",
    budget_monthly_credits: 400,
    must_have_fields: ["intent_topic", "cloud_provider"],
    compliance: "standard",
    freshness: "weekly",
    private_notes: "Azure shops convert twice as well; launch is in Q1.",
  },
  chen: {
    display: "Chen, Channel Sales Director at a payroll provider (Singapore)",
    industry: "Payroll Services",
    role: "Channel Sales Director",
    region: "APAC",
    goals: ["Build pipeline with companies outsourcing payroll"],
    target_segment: { regions: ["APAC"], size_bands: ["SMB", "Mid-market"] },
    company_name: "PayAsia Pte Ltd",
    budget_monthly_credits: 450,
    must_have_fields: ["intent_score", "hr_platform"],
    compliance: "standard",
    freshness: "weekly",
    private_notes: "Partners in India and Australia; BambooHR users are easy wins.",
  },
  elena: {
    display: "Elena, Customer Success Director at an ERP vendor (Munich)",
    industry: "ERP Software",
    role: "Customer Success Director",
    region: "EMEA",
    goals: ["Find manufacturing customers due for an ERP renewal"],
    target_segment: { industries: ["Manufacturing"], regions: ["EMEA"] },
    company_name: "Werkplan AG",
    budget_monthly_credits: 700,
    must_have_fields: ["erp", "revenue_usd_m"],
    compliance: "gdpr_strict",
    freshness: "monthly",
    private_notes: "SAP S/4HANA migration deadline drives renewals; Infor accounts are at risk.",
  },
  omar: {
    display: "Omar, Sales Director at a cloud consultancy (New York)",
    industry: "Cloud Consulting",
    role: "Sales Director",
    region: "NA",
    goals: ["Build pipeline with retailers moving to the cloud"],
    target_segment: { industries: ["Retail"], regions: ["NA"] },
    company_name: "Skyward Partners",
    budget_monthly_credits: 350,
    must_have_fields: ["cloud_provider", "intent_score"],
    compliance: "standard",
    freshness: "weekly",
    private_notes: "We are an AWS partner: prioritise Azure and Google Cloud accounts for migration.",
  },
};

export function isPersona(name) {
  return typeof name === "string" && Object.hasOwn(PERSONAS, name);
}

/** A deep copy of one persona's profile; throws for an unknown persona. */
export function getProfile(persona) {
  if (!isPersona(persona)) throw new Error(`unknown persona ${persona}`);
  return structuredClone(PERSONAS[persona]);
}

export function defaultSharedFields() {
  return Object.keys(FIELDS).filter((name) => FIELDS[name][0] === "shareable");
}

export function privateFields() {
  return Object.keys(FIELDS).filter((name) => FIELDS[name][0] === "private");
}

/** Raised for a bad grant (Python's ValueError; the API turns it into a 400). */
export class ConsentError extends Error {}

/** Validates a grant and builds the record (shared by both stores). */
function newRecord(persona, purpose, fields) {
  if (!Object.hasOwn(PURPOSES, purpose)) throw new ConsentError(`unknown purpose ${purpose}`);
  // Unknown field names count as private, as in Python.
  const blocked = fields.filter((f) => (Object.hasOwn(FIELDS, f) ? FIELDS[f][0] : "private") === "private");
  if (blocked.length) throw new ConsentError(`private fields can never be shared: ${blocked.join(", ")}`);
  return {
    consent_id: `cns-${randomHex(6)}`,
    persona,
    purpose,
    fields: [...new Set(fields)].sort(),
    // Python: time.strftime("%Y-%m-%dT%H:%M:%S") (local time; UTC here).
    granted_at: new Date().toISOString().slice(0, 19),
  };
}

function fromRow(r) {
  return r && { consent_id: r.consent_id, persona: r.persona, purpose: r.purpose, fields: JSON.parse(r.fields), granted_at: r.granted_at };
}

/** Consent ledger in SQLite: one active consent per persona and purpose. */
export class ConsentStore {
  constructor(db) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS consents (
      persona TEXT NOT NULL, purpose TEXT NOT NULL, consent_id TEXT NOT NULL,
      fields TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY (persona, purpose))`);
  }

  grant(persona, purpose, fields) {
    const rec = newRecord(persona, purpose, fields);
    // Upsert keeps the row's position, like re-assigning a Python dict key.
    this.db.run(
      `INSERT INTO consents (persona, purpose, consent_id, fields, granted_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (persona, purpose) DO UPDATE SET consent_id = excluded.consent_id,
       fields = excluded.fields, granted_at = excluded.granted_at`,
      persona, purpose, rec.consent_id, JSON.stringify(rec.fields), rec.granted_at,
    );
    return rec;
  }

  revoke(persona, purpose) {
    const had = this.active(persona, purpose) !== null;
    if (had) this.db.run("DELETE FROM consents WHERE persona = ? AND purpose = ?", persona, purpose);
    return had;
  }

  active(persona, purpose) {
    return fromRow(this.db.one("SELECT * FROM consents WHERE persona = ? AND purpose = ?", persona, purpose)) ?? null;
  }

  allFor(persona) {
    return this.db.all("SELECT * FROM consents WHERE persona = ? ORDER BY rowid", persona).map(fromRow);
  }
}

/** Same interface, in memory: the simulator's throwaway ledger (as in Python). */
export class MemoryConsentStore {
  constructor() {
    this.records = new Map();
  }
  grant(persona, purpose, fields) {
    const rec = newRecord(persona, purpose, fields);
    this.records.set(`${persona}\u0000${purpose}`, rec);
    return structuredClone(rec);
  }
  revoke(persona, purpose) {
    return this.records.delete(`${persona}\u0000${purpose}`);
  }
  active(persona, purpose) {
    const r = this.records.get(`${persona}\u0000${purpose}`);
    return r ? structuredClone(r) : null;
  }
  allFor(persona) {
    return [...this.records.values()].filter((r) => r.persona === persona).map((r) => structuredClone(r));
  }
}

function isEmpty(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v).length === 0;
}

/** Only the consented fields, flattened for the wire. */
export function sharedContext(profile, consent) {
  const shared = {};
  for (const field of consent.fields) {
    const value = profile[field];
    if (isEmpty(value)) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [k, inner] of Object.entries(value)) shared[`${field}.${k}`] = inner;
    } else {
      shared[field] = value;
    }
  }
  return shared;
}
