"""Personalised insights: Champions ranks what matters to the person it is told about."""

from champions import data, insights
from common.schemas import Filters

SEGMENT = Filters(industries=["Healthcare"], regions=["EMEA"], size_bands=["Mid-market"],
                  intent_topics=["HR Platform Replacement"])
SALES = {"industry": "HR Software", "role": "Head of Sales",
         "goals": ["Build pipeline with companies replacing their HR platform"]}
ANALYST = {"industry": "Manufacturing", "role": "Strategy Analyst", "goals": ["Size the APAC market for cloud ERP"]}


def test_new_columns_exist_and_old_values_are_unchanged():
    rows = data.connection().execute(
        "SELECT company_id, hr_platform, renewal_quarter, revenue_growth_pct FROM companies "
        "ORDER BY company_id LIMIT 3").fetchall()
    assert rows[0][0] == "CG-00001"
    assert all(r[2] and r[2].startswith(("2026-", "2027-")) for r in rows)
    assert all(isinstance(r[3], float) for r in rows)


def test_candidates_cover_many_insight_types_with_ids_and_themes():
    found = insights.candidates(SEGMENT)
    ids = {i.id for i in found}
    assert {"segment_size", "topic_surge", "hot_accounts", "legacy_platform_switchers",
            "renewals_soon", "growth_leaders"} <= ids
    assert all(i.themes for i in found)


def test_ranking_follows_the_persons_role_and_goals():
    found = insights.candidates(SEGMENT)
    sales = insights.rank(found, "companies switching HR platforms", SALES)
    analyst = insights.rank(insights.candidates(SEGMENT), "size the market", ANALYST)
    sales_top = [i.id for i in sales[:3]]
    assert "segment_size" not in sales_top
    assert {"hot_accounts", "topic_surge", "legacy_platform_switchers", "renewals_soon"} & set(sales_top)
    assert analyst[0].id in {"segment_size", "spend_profile", "growth_leaders", "erp_mix"}
    assert sales[0].score >= sales[-1].score


def test_why_for_you_uses_only_shared_context():
    ranked = insights.rank(insights.candidates(SEGMENT), "switching HR platforms", SALES)
    assert "Head of Sales" in ranked[0].why_for_you or "pipeline" in ranked[0].why_for_you
    anonymous = insights.rank(insights.candidates(SEGMENT), "switching HR platforms", {})
    assert all("Head of Sales" not in i.why_for_you for i in anonymous)
    assert anonymous[0].why_for_you


def test_every_ranked_insight_suggests_a_follow_up():
    ranked = insights.rank(insights.candidates(SEGMENT), "", SALES)
    assert all(i.follow_ups for i in ranked)


def test_empty_segment_gives_a_single_no_results_insight():
    found = insights.candidates(Filters(industries=["Nonexistent"]))
    assert [i.id for i in found] == ["segment_size"]
    assert found[0].value == 0


def test_what_the_question_asks_for_ranks_first():
    germany = Filters(industries=["Healthcare"], countries=["Germany"])
    renew = insights.rank(insights.candidates(germany), "Which have an HR contract renewing soon?", SALES)
    assert renew[0].id == "renewals_soon"
    spend = insights.rank(insights.candidates(germany), "How much do they spend on HR tech?", SALES)
    assert spend[0].id == "spend_profile"


def test_country_hotspot_is_skipped_for_a_single_country_segment():
    ids = {i.id for i in insights.candidates(Filters(countries=["United Kingdom"]))}
    assert "country_hotspot" not in ids


def test_topic_surge_answers_a_question_about_that_topic():
    retail = Filters(industries=["Retail"], regions=["NA"], intent_topics=["Cloud Migration"])
    omar = {"role": "Sales Director", "goals": ["Build pipeline with retailers moving to the cloud"]}
    ranked = insights.rank(insights.candidates(retail), "Find retailers moving to the cloud", omar)
    assert ranked[0].id == "topic_surge" and "Cloud Migration" in ranked[0].label
