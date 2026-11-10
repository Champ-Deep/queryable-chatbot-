"""JSON contracts exchanged between the Personal Agent and the Champions Group Agent.

Every payload carries a ``schema`` id with a version, so either side can evolve
without breaking the other. These Pydantic models are the single source for
validation, docs and the examples shown in the demo.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

SCHEMA_VERSION = "v1"


def schema_id(name):
    return f"champions.{name}/{SCHEMA_VERSION}"


# ---------------------------------------------------------------- user side

class UserContext(BaseModel):
    """The slice of the user's profile they agreed to share, nothing more."""

    schema_: str = Field(schema_id("user_context"), alias="schema")
    consent_id: str
    purpose: Literal["data_discovery", "market_insights", "outreach"]
    shared: dict[str, str | int | float | list[str]] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class Filters(BaseModel):
    industries: list[str] = Field(default_factory=list)
    regions: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    size_bands: list[str] = Field(default_factory=list)
    intent_topics: list[str] = Field(default_factory=list)


class CapabilityRequest(BaseModel):
    schema_: str = Field(schema_id("capability_request"), alias="schema")
    skill: Literal["describe_capabilities", "find_data_cards", "get_insights"]
    need: str
    filters: Filters = Field(default_factory=Filters)
    desired_outputs: list[str] = Field(default_factory=list)
    context: UserContext | None = None

    model_config = {"populate_by_name": True}


# ------------------------------------------------------------ champions side

class VafField(BaseModel):
    name: str
    type: str
    description: str
    coverage_pct: float
    refresh: str
    example: str | int | float | None = None


class DataCard(BaseModel):
    id: str
    name: str
    description: str
    contains_personal_data: bool = False
    credits_per_1k_records: int
    delivery: list[str]
    refresh: str
    vaf_fields: list[VafField]


class CardMatch(BaseModel):
    card_id: str
    name: str
    relevance: float = Field(ge=0, le=1)
    why: str
    matched_fields: list[str] = Field(default_factory=list)
    coverage_pct: float
    refresh: str
    credits_per_1k_records: int
    contains_personal_data: bool = False


class Insight(BaseModel):
    label: str
    value: str | int | float
    detail: str = ""

    @field_validator("value")
    @classmethod
    def _whole_numbers_as_int(cls, value):
        # A2A DataParts are protobuf Values, where every number is a double.
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value


class CatalogResult(BaseModel):
    schema_: str = Field(schema_id("catalog_result"), alias="schema")
    matches: list[CardMatch]
    matching_companies: int
    insights: list[Insight] = Field(default_factory=list)
    sample: list[dict] = Field(default_factory=list)
    method: str
    consent_id: str | None = None

    model_config = {"populate_by_name": True}


# ------------------------------------------------------------- recommendation

class RankedOption(BaseModel):
    card_id: str
    name: str
    score: float
    verdict: Literal["recommended", "optional", "not_recommended"]
    reasons: list[str]
    est_monthly_credits: int


class Recommendation(BaseModel):
    schema_: str = Field(schema_id("recommendation"), alias="schema")
    summary: str
    options: list[RankedOption]
    bundle: list[str]
    bundle_monthly_credits: int
    within_budget: bool

    model_config = {"populate_by_name": True}
