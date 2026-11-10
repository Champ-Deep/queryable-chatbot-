"""The user's private profile and consent records (held only by the Personal Agent).

Each profile field has a sharing class:
  shareable  may be sent to Champions if the user consents (on by default)
  opt_in     may be sent only if the user ticks it (off by default)
  private    never leaves the Personal Agent (budget, notes, must-haves)
"""

import copy
import threading
import time
import uuid

FIELDS = {
    "industry": ("shareable", "Your industry"),
    "role": ("shareable", "Your role"),
    "region": ("shareable", "Your sales region"),
    "goals": ("shareable", "What you are trying to achieve"),
    "target_segment": ("opt_in", "Industries, regions and sizes you sell to"),
    "company_name": ("opt_in", "Your company's name"),
    "budget_monthly_credits": ("private", "Monthly data budget"),
    "must_have_fields": ("private", "Fields you require"),
    "compliance": ("private", "Your data-protection policy"),
    "private_notes": ("private", "Internal notes"),
}

PURPOSES = {
    "data_discovery": "Find which Champions data cards fit a need",
    "market_insights": "Get aggregate market insights for a segment",
    "outreach": "Prepare contact-level outreach (personal data)",
}

PERSONAS = {
    "priya": {
        "display": "Priya, Head of Sales at an HR-software vendor (Berlin)",
        "industry": "HR Software",
        "role": "Head of Sales",
        "region": "EMEA",
        "goals": ["Build pipeline with companies replacing their HR platform"],
        "target_segment": {"industries": ["Healthcare"], "regions": ["EMEA"], "size_bands": ["Mid-market"]},
        "company_name": "PeopleFlow GmbH",
        "budget_monthly_credits": 600,
        "must_have_fields": ["intent_score", "hr_platform", "employee_count"],
        "compliance": "gdpr_strict",
        "freshness": "weekly",
        "private_notes": "Q1 quota at risk; prioritise accounts on ADP or Oracle HCM.",
    },
    "marcus": {
        "display": "Marcus, Marketing Ops at a UK fintech (London)",
        "industry": "Fintech",
        "role": "Marketing Operations Manager",
        "region": "EMEA",
        "goals": ["Run an ABM campaign for payroll products"],
        "target_segment": {"industries": ["Financial Services", "Technology"], "countries": ["United Kingdom"],
                           "size_bands": ["SMB", "Mid-market"]},
        "company_name": "Ledgerly Ltd",
        "budget_monthly_credits": 300,
        "must_have_fields": ["intent_topic", "crm"],
        "compliance": "standard",
        "freshness": "monthly",
        "private_notes": "CMO wants CRM-synced lists before the March launch.",
    },
    "aiko": {
        "display": "Aiko, Strategy Analyst at a manufacturer (Tokyo)",
        "industry": "Manufacturing",
        "role": "Strategy Analyst",
        "region": "APAC",
        "goals": ["Size the APAC market for cloud ERP"],
        "target_segment": {"industries": ["Manufacturing"], "regions": ["APAC"]},
        "company_name": "Kanto Precision KK",
        "budget_monthly_credits": 1000,
        "must_have_fields": ["erp", "revenue_usd_m"],
        "compliance": "standard",
        "freshness": "quarterly",
        "private_notes": "Board deck due end of month; no outreach planned.",
    },
}


def get_profile(persona):
    if persona not in PERSONAS:
        raise KeyError(persona)
    return copy.deepcopy(PERSONAS[persona])


def default_shared_fields():
    return [name for name, (cls, _) in FIELDS.items() if cls == "shareable"]


class ConsentStore:
    """In-memory consent ledger: one active consent per persona and purpose."""

    def __init__(self):
        self._lock = threading.Lock()
        self._records = {}

    def grant(self, persona, purpose, fields):
        if purpose not in PURPOSES:
            raise ValueError(f"unknown purpose {purpose}")
        blocked = [f for f in fields if FIELDS.get(f, ("private",))[0] == "private"]
        if blocked:
            raise ValueError(f"private fields can never be shared: {', '.join(blocked)}")
        record = {
            "consent_id": f"cns-{uuid.uuid4().hex[:12]}",
            "persona": persona,
            "purpose": purpose,
            "fields": sorted(set(fields)),
            "granted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with self._lock:
            self._records[(persona, purpose)] = record
        return dict(record)

    def revoke(self, persona, purpose):
        with self._lock:
            return self._records.pop((persona, purpose), None) is not None

    def active(self, persona, purpose):
        with self._lock:
            record = self._records.get((persona, purpose))
            return dict(record) if record else None

    def all_for(self, persona):
        with self._lock:
            return [dict(r) for (p, _), r in self._records.items() if p == persona]


def shared_context(profile, consent):
    """Only the consented fields, flattened for the wire."""

    shared = {}
    for field in consent["fields"]:
        value = profile.get(field)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, dict):
            for key, inner in value.items():
                shared[f"{field}.{key}"] = inner
        else:
            shared[field] = value
    return shared
