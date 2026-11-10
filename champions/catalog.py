"""Mock Champions Group data catalog: data cards and their VAF fields.

Synthetic, for the demo only. Each data card is a product Champions can
deliver; VAF (value-added field) entries describe each field's type,
coverage and refresh cadence so a buyer's agent can judge fit before buying.
"""

from common.schemas import DataCard, VafField


def _f(name, type_, description, coverage, refresh, example=None):
    return VafField(
        name=name, type=type_, description=description,
        coverage_pct=coverage, refresh=refresh, example=example,
    )


CARDS = [
    DataCard(
        id="firmographics",
        name="Firmographics",
        description="Core company profile: industry, size, location and structure.",
        credits_per_1k_records=40,
        delivery=["API", "CSV", "CRM sync"],
        refresh="monthly",
        vaf_fields=[
            _f("company_name", "string", "Registered trading name", 99.8, "monthly", "Northwind Health GmbH"),
            _f("domain", "string", "Primary web domain", 97.5, "monthly", "northwind-health.example"),
            _f("industry", "enum", "Champions industry taxonomy (L1)", 99.1, "monthly", "Healthcare"),
            _f("sub_industry", "enum", "Industry taxonomy (L2)", 91.4, "monthly", "Hospitals & Clinics"),
            _f("hq_country", "string", "Headquarters country", 99.6, "monthly", "Germany"),
            _f("region", "enum", "Sales region (EMEA, NA, APAC, LATAM)", 99.6, "monthly", "EMEA"),
            _f("employee_count", "integer", "Modelled global headcount", 94.2, "monthly", 820),
            _f("size_band", "enum", "SMB / Mid-market / Enterprise", 94.2, "monthly", "Mid-market"),
            _f("founded_year", "integer", "Year founded", 88.0, "quarterly", 2004),
            _f("ownership", "enum", "Public, private, PE-backed, non-profit", 86.3, "quarterly", "Private"),
        ],
    ),
    DataCard(
        id="technographics",
        name="Technographics",
        description="Installed technology by category, detected from 40+ signal sources.",
        credits_per_1k_records=75,
        delivery=["API", "CSV"],
        refresh="weekly",
        vaf_fields=[
            _f("hr_platform", "string", "Primary HRIS / HCM platform", 83.5, "weekly", "Workday"),
            _f("crm", "string", "CRM in use", 87.9, "weekly", "Salesforce"),
            _f("erp", "string", "ERP in use", 79.2, "weekly", "SAP S/4HANA"),
            _f("cloud_provider", "string", "Primary cloud", 81.0, "weekly", "Azure"),
            _f("security_stack", "list", "Detected security vendors", 64.7, "weekly", "CrowdStrike, Okta"),
            _f("tech_spend_band", "enum", "Modelled annual IT spend band", 72.4, "monthly", "$1M-$5M"),
            _f("install_first_seen", "date", "When each product was first detected", 83.5, "weekly", "2021-03-14"),
        ],
    ),
    DataCard(
        id="intent_signals",
        name="Intent Signals",
        description="Topic-level buying intent from content consumption and job postings.",
        credits_per_1k_records=120,
        delivery=["API", "CRM sync"],
        refresh="daily",
        vaf_fields=[
            _f("intent_topic", "enum", "Topic showing elevated research", 68.0, "daily", "HR Platform Replacement"),
            _f("intent_score", "integer", "0-100 surge score vs. baseline", 68.0, "daily", 82),
            _f("surge_start", "date", "First day of the current surge", 68.0, "daily", "2026-10-21"),
            _f("hiring_signal", "string", "Related job postings detected", 55.3, "daily", "HRIS Project Manager"),
            _f("competitor_research", "list", "Vendors being researched", 49.8, "daily", "SAP SuccessFactors, Workday"),
        ],
    ),
    DataCard(
        id="hr_tech_spend",
        name="HR Tech Spend",
        description="Modelled HR technology budget, contract timing and vendor mix.",
        credits_per_1k_records=90,
        delivery=["API", "CSV"],
        refresh="quarterly",
        vaf_fields=[
            _f("annual_hr_tech_spend_usd", "number", "Modelled annual HR tech spend", 76.1, "quarterly", 412000),
            _f("contract_renewal_window", "string", "Estimated renewal quarter of main HR contract", 58.9, "quarterly", "2027-Q1"),
            _f("deployment_type", "enum", "SaaS / Hybrid / On-premise", 81.7, "quarterly", "Hybrid"),
            _f("vendor_count", "integer", "HR vendors in use", 70.2, "quarterly", 6),
        ],
    ),
    DataCard(
        id="financials",
        name="Financials",
        description="Revenue, growth and funding for public and private companies.",
        credits_per_1k_records=60,
        delivery=["API", "CSV"],
        refresh="quarterly",
        vaf_fields=[
            _f("revenue_usd_m", "number", "Annual revenue (USD millions, modelled for private)", 84.4, "quarterly", 145.0),
            _f("revenue_growth_pct", "number", "Year-on-year revenue growth", 71.8, "quarterly", 12.5),
            _f("funding_stage", "enum", "Latest funding stage", 62.0, "monthly", "Series C"),
            _f("total_funding_usd_m", "number", "Total disclosed funding", 58.3, "monthly", 88.0),
        ],
    ),
    DataCard(
        id="contacts",
        name="Contacts",
        description="Business contacts by role and seniority. Personal data: requires the "
        "'outreach' purpose, a data processing agreement and the contacts:read scope.",
        contains_personal_data=True,
        credits_per_1k_records=250,
        delivery=["API", "CRM sync"],
        refresh="weekly",
        vaf_fields=[
            _f("full_name", "string", "Contact name (masked in samples)", 92.0, "weekly", "J*** D***"),
            _f("job_title", "string", "Normalised job title", 95.5, "weekly", "VP People"),
            _f("seniority", "enum", "C-level, VP, Director, Manager", 95.5, "weekly", "VP"),
            _f("department", "enum", "Function (HR, IT, Finance, Sales...)", 95.1, "weekly", "HR"),
            _f("business_email", "string", "Verified business e-mail (masked in samples)", 78.4, "weekly", "j***@example.com"),
            _f("email_verified_at", "date", "Last verification date", 78.4, "weekly", "2026-11-02"),
        ],
    ),
]

BY_ID = {card.id: card for card in CARDS}


def card_coverage(card):
    """Average coverage across a card's VAF fields."""

    return round(sum(f.coverage_pct for f in card.vaf_fields) / len(card.vaf_fields), 1)
