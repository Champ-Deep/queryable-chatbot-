# Agent-to-agent testing, personalised insights and MCP-as-API-wrapper

Date: 2026-11-23 · Status: approved by user (chat, 2026-11-23)

## Goal

Answer the four questions the boss asked, with a working demo:

1. When a personal agent (knows the person) talks to the Champions agent (knows the data cards), does it find insights that matter to that person?
2. What queries do agents send to the Champions agent?
3. Which responses/insights are actually useful?
4. Keep those real queries so the agent can be improved later.

Plus: show MCP as "a server that wraps an API, so the caller needs no API credentials".

Constraints: rule-based (no LLM: the network blocks OpenRouter), synthetic data, offline, existing 27 tests keep passing (two assertions about tool/skill lists are updated on purpose).

## Design

### 1. Personalised insights (Champions, `champions/insights.py`)
- About 12 insight generators over the segment, each tagged with themes (`accounts`, `intent`, `timing`, `displacement`, `sizing`, `growth`, `tech`, `campaign`, `geo`, `budget`):
  segment size, topic surge per requested topic, hot accounts (intent ≥ 80), legacy-platform switchers, renewals in the next two quarters, HR-tech spend, growth leaders, funding mix, country hotspot, CRM mix, ERP mix, cloud mix, overall intent.
- `rank(candidates, need, shared)`: a theme weight from the shared role, goals and industry and from the question text. Each insight gets `score`, a `why_for_you` line built only from shared fields, and 1–2 `follow_ups`.
- `get_insights` returns the top 6 ranked insights. `insights_for` (generic) stays for compatibility.
- Synthetic data gains `renewal_quarter` and `revenue_growth_pct`, from a separate RNG so existing values do not change.

### 2. Usefulness judged privately (Personal Agent, `personal/judge.py`)
- `judge(insights, profile, question)` marks each insight useful or not, with a reason. It uses the full private profile: notes (e.g. "ADP or Oracle HCM"), must-have fields, goals and role.
- Only `{insight_id, useful}` ratings go back to Champions as an A2A DataPart `champions.feedback/v1` (new skill `submit_feedback`). Reasons stay local.

### 3. Query log (Champions, `champions/querylog.py`)
- SQLite file (`data/query_log.db`, env `CHAMPIONS_QUERY_LOG`), so it survives restarts.
- One row per A2A / MCP / REST query. Each row holds:
  - time, client, channel, source (`live` / `simulator`)
  - skill, need text, filters, shared role and industry
  - intent category, cards returned, insight ids, result count
  - gaps, latency, and the usefulness ratings
- Intent categories: `catalog`, `market_sizing`, `account_discovery`, `tech_displacement`, `timing_renewals`, `contacts`, `growth_signals`, `other`.
- Gaps: `no_results`, `segment_not_understood`, `contacts_not_available`, `topic_not_tracked`.
- `stats()` returns the KPIs and the breakdowns. Export to CSV and JSONL.

### 4. MCP wraps the REST API
- REST API `/api/v1/*` (cards, card fields, search, insights, query stats), protected by an internal `X-API-Key`.
- MCP tools call that API through httpx using the key held by the server (in-process by default, or `CHAMPIONS_API_URL` for a remote API). The MCP caller only presents its own bearer token.
- Tools: `list_data_cards`, `get_vaf_fields`, `find_data_cards`, `get_insights`, `get_query_stats`.

### 5. Simulator (`personal/simulator.py`, `scripts/simulate.py`)
- 10 personas × 4–5 questions, including hard ones (contacts, vague, unknown segment). Consent is given automatically for the shareable fields + target segment. The simulator runs the real OAuth → A2A → MCP → feedback path and tags requests `source=simulator`.
- It produces a report: answered %, useful %, by intent, top gaps. The report is written to `reports/simulation.md`.

### 6. UI
- **:9200 Conversation tab:**
  - insight cards with "why this matters to you", a useful/not-useful badge with its private reason, and follow-up chips
  - a protocol step timeline
  - 10 personas
- **:9100/lab Agent Lab:** the Champions operator view of what agents ask.
  - KPI tiles, intent bars, most-useful insight types, gaps
  - the recent-queries table with CSV/JSONL export
  - a "Run simulation" button (calls :9200 `/api/simulate`)

## Plan (TDD, in order)
1. Schemas (Insight extra fields, feedback, source); data columns. Tests: data stability.
2. `insights.py`: generators and ranking. Tests: role changes the order; `why_for_you` uses only shared fields.
3. `querylog.py`: classify, gaps, record, feedback, stats, export. Tests.
4. Champions app: log A2A, feedback skill, REST API + key, MCP via API, lab routes. Tests.
5. Personal: judge, feedback send, more personas, simulator, `/api/simulate`, CORS. Tests.
6. UI (:9200 page, :9100/lab).
7. Docs (MODEL.md section "Agent testing findings"), README, run the simulation, verify in the browser.
