"""Synthetic company records behind the catalog (seeded, so results are stable).

Held in an in-memory DuckDB database. Only aggregates and a few masked sample
rows ever leave the Champions agent; there is no bulk export path.
"""

import random
import threading

import duckdb

SEED = 20261110
N_COMPANIES = 2400

INDUSTRIES = {
    "Healthcare": ["Hospitals & Clinics", "Medical Devices", "Pharma", "Health Insurance"],
    "Financial Services": ["Banking", "Insurance", "Asset Management", "Fintech"],
    "Manufacturing": ["Industrial Machinery", "Automotive", "Chemicals", "Electronics"],
    "Retail": ["E-commerce", "Grocery", "Apparel", "Home & Garden"],
    "Technology": ["SaaS", "IT Services", "Semiconductors", "Cybersecurity"],
    "Education": ["Higher Education", "EdTech", "K-12"],
    "Logistics": ["Freight", "Warehousing", "Last-mile Delivery"],
    "Energy": ["Renewables", "Oil & Gas", "Utilities"],
}

COUNTRIES = {
    "EMEA": ["Germany", "United Kingdom", "France", "Netherlands", "Spain", "Sweden", "Italy", "Ireland"],
    "NA": ["United States", "Canada"],
    "APAC": ["India", "Singapore", "Australia", "Japan"],
    "LATAM": ["Brazil", "Mexico"],
}

HR_PLATFORMS = ["Workday", "SAP SuccessFactors", "Oracle HCM", "BambooHR", "Personio", "ADP", "UKG", "Dayforce"]
CRMS = ["Salesforce", "HubSpot", "Microsoft Dynamics", "Zoho"]
ERPS = ["SAP S/4HANA", "Oracle NetSuite", "Microsoft Dynamics 365", "Infor"]
CLOUDS = ["AWS", "Azure", "Google Cloud"]
INTENT_TOPICS = [
    "HR Platform Replacement", "Payroll Outsourcing", "CRM Migration", "Cloud Migration",
    "Cybersecurity", "ERP Upgrade", "Data Analytics", "Employee Experience",
]
FUNDING = ["Bootstrapped", "Seed", "Series A", "Series B", "Series C", "Private Equity", "Public"]

_NAME_A = ["North", "Blue", "Silver", "Bright", "Clear", "Summit", "Harbor", "Nova", "Apex", "Vertex",
           "Cedar", "Atlas", "Orion", "Lumen", "Pioneer", "Evergreen"]
_NAME_B = ["wind", "stone", "bridge", "field", "point", "line", "gate", "path", "wave", "peak"]


def size_band(employees):
    if employees < 200:
        return "SMB"
    if employees < 2000:
        return "Mid-market"
    return "Enterprise"


def _companies():
    rng = random.Random(SEED)
    rows = []
    for i in range(1, N_COMPANIES + 1):
        industry = rng.choice(list(INDUSTRIES))
        region = rng.choices(list(COUNTRIES), weights=[45, 35, 15, 5])[0]
        country = rng.choice(COUNTRIES[region])
        employees = int(rng.lognormvariate(6.3, 1.2)) + 10
        hr = rng.choice(HR_PLATFORMS)
        topic = rng.choice(INTENT_TOPICS) if rng.random() < 0.68 else None
        if topic is None and hr in ("ADP", "Oracle HCM") and rng.random() < 0.5:
            topic = "HR Platform Replacement"
        name = f"{rng.choice(_NAME_A)}{rng.choice(_NAME_B)} {rng.choice(INDUSTRIES[industry]).split()[0]} {i:04d}"
        rows.append(
            (
                f"CG-{i:05d}", name, industry, rng.choice(INDUSTRIES[industry]), country, region,
                employees, size_band(employees), hr, rng.choice(CRMS), rng.choice(ERPS), rng.choice(CLOUDS),
                topic, rng.randint(55, 98) if topic else None,
                round(employees * rng.uniform(0.08, 0.35), 1),
                rng.choice(FUNDING), round(employees * rng.uniform(250, 900)),
                rng.choice(["SaaS", "Hybrid", "On-premise"]),
            )
        )
    return rows


_lock = threading.Lock()
_conn = None


def connection():
    global _conn
    with _lock:
        if _conn is None:
            conn = duckdb.connect(":memory:")
            conn.execute(
                """CREATE TABLE companies (
                    company_id VARCHAR, company_name VARCHAR, industry VARCHAR, sub_industry VARCHAR,
                    hq_country VARCHAR, region VARCHAR, employee_count INTEGER, size_band VARCHAR,
                    hr_platform VARCHAR, crm VARCHAR, erp VARCHAR, cloud_provider VARCHAR,
                    intent_topic VARCHAR, intent_score INTEGER, revenue_usd_m DOUBLE,
                    funding_stage VARCHAR, annual_hr_tech_spend_usd DOUBLE, deployment_type VARCHAR)"""
            )
            conn.executemany(f"INSERT INTO companies VALUES ({', '.join(['?'] * 18)})", _companies())
            _conn = conn
        return _conn


def _where(filters):
    clauses, params = [], []
    for column, values in (
        ("industry", filters.industries),
        ("region", filters.regions),
        ("hq_country", filters.countries),
        ("size_band", filters.size_bands),
        ("intent_topic", filters.intent_topics),
    ):
        if values:
            clauses.append(f"{column} IN ({', '.join(['?'] * len(values))})")
            params.extend(values)
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def query(sql_tail, filters, extra_params=()):
    """Run a parameterised aggregate over the filtered companies."""

    where, params = _where(filters)
    cur = connection().cursor()
    try:
        return cur.execute(sql_tail.format(where=where), [*params, *extra_params]).fetchall()
    finally:
        cur.close()
