# Agent-to-Agent model: Champions Group Agent ⇄ User's Personal Agent

## 1. The model in one picture

```mermaid
flowchart LR
    U([User]) -- chat --> PA
    subgraph PA[Personal Agent: user side]
        P[(Private profile<br/>budget, notes,<br/>must-haves, policy)]
        C[(Consent ledger)]
        PL[Planner] --> G{Consent gate}
        EV[Evaluator]
    end
    subgraph CG[Champions Group Agent: provider side]
        AC[[Agent Card<br/>/.well-known/agent-card.json]]
        A2A[A2A JSON-RPC /a2a]
        MCP[MCP tools /mcp]
        CAT[(Data cards +<br/>VAF fields)]
        DB[(Company data)]
        AUD[(Audit log)]
    end
    G -- "OAuth2 token" --> CG
    G -- "discover" --> AC
    G -- "SendMessage(DataPart: capability_request)" --> A2A
    A2A -- "Task + artifact: catalog_result" --> EV
    EV -- "tools/call get_vaf_fields" --> MCP
    A2A --> CAT & DB & AUD
    MCP --> CAT
    EV --> U
```

**Responsibilities**

| Champions Group Agent | Personal Agent |
|---|---|
| Owns company data, the data-card catalog and VAF field definitions | Owns the user's profile, preferences, budget and consent |
| Explains capabilities (`describe_capabilities`) | Turns the user's question into a structured request |
| Matches cards and fields to a need (`find_data_cards`) | Shares only consented fields, for one stated purpose |
| Computes aggregate insights (`get_insights`) | Evaluates offers against private constraints |
| Never exports records or personal data over A2A | Recommends a bundle and explains why |
| Logs every exchange with its consent id and purpose | Shows the user every message it sent |

The split is the point: **the provider never sees the buyer's budget, notes or policy, and the buyer's agent never gets bulk data**. Each side keeps its own sensitive information and they exchange structured, minimal messages.

## 2. One turn, step by step

```mermaid
sequenceDiagram
    actor U as User
    participant PA as Personal Agent
    participant CG as Champions Agent
    U->>PA: "Mid-size healthcare companies in Europe switching HR platforms"
    PA->>PA: plan → skill get_insights, filters, purpose market_insights
    alt no consent for this purpose
        PA-->>U: consent card (shareable / optional / 🔒 private)
        U->>PA: approve selected fields
    end
    PA->>CG: POST /oauth/token (client_credentials, scopes)
    CG-->>PA: JWT, 5 min, catalog:read insights:read
    PA->>CG: GET /.well-known/agent-card.json
    CG-->>PA: skills, interfaces, security scheme
    PA->>CG: POST /a2a SendMessage {DataPart: capability_request + user_context}
    CG->>CG: scope check · match cards · aggregate insights · audit(consent_id, purpose, field names)
    CG-->>PA: Task COMPLETED + artifact catalog_result
    loop top 3 cards
        PA->>CG: POST /mcp tools/call get_vaf_fields
        CG-->>PA: field definitions (type, coverage, refresh)
    end
    PA->>PA: score vs private budget, must-haves, freshness, compliance
    PA-->>U: answer + ranked cards + bundle within budget
```

## 3. Protocols: what each one is for

| | **A2A (Agent2Agent)** | **MCP (Model Context Protocol)** | **Plain REST** |
|---|---|---|---|
| Purpose | One *agent* delegating a task to another *agent* | An agent calling *tools/data* exposed by a server | Any service-to-service call |
| Discovery | Agent Card at `/.well-known/agent-card.json`: skills, interfaces, auth schemes | `initialize` then `tools/list` with JSON Schemas | Out-of-band docs / OpenAPI |
| Unit of work | **Task** with lifecycle (`SUBMITTED → WORKING → COMPLETED / FAILED / INPUT_REQUIRED / AUTH_REQUIRED`), messages, artifacts | Single tool call → result | Endpoint call → response |
| Long-running / multi-turn | Built in (task ids, context ids, input-required, streaming, push notifications) | Not the focus | Hand-rolled |
| Opaque peer | Yes: the caller doesn't see the other agent's tools, prompts or data | No: the caller drives each tool | n/a |
| Used here for | Personal → Champions *"find me data for this need"* | Precise lookups of VAF field definitions; also usable by any MCP client (e.g. Claude) | OAuth token endpoint, audit view |

**Rule of thumb:** A2A is for when the other side should *think* (an opaque peer agent with its own data and logic). MCP is for when you want a *tool* you call deterministically. They complement each other: Champions offers both, so a buyer's agent can delegate with A2A and verify with MCP. REST stays useful for plumbing (tokens, health, audit).

Versions in this demo: **A2A 1.0** via `a2a-sdk` 1.3 (JSON-RPC binding, `A2A-Version: 1.0` header, method `SendMessage`) and **MCP** via `mcp` 2.3 over Streamable HTTP (stateless JSON mode, protocol `2025-06-18`).

## 4. JSON structures

All payloads carry a versioned `schema` id (`champions.<name>/v1`) and are defined once as Pydantic models in `common/schemas.py`.

**Request: A2A `SendMessage` (one DataPart)**
```json
{
  "jsonrpc": "2.0", "id": "…", "method": "SendMessage",
  "params": { "message": { "messageId": "…", "role": "ROLE_USER", "parts": [ { "data": {
    "schema": "champions.capability_request/v1",
    "skill": "get_insights",
    "need": "Find mid-size healthcare companies in Europe that are switching HR platforms",
    "filters": { "industries": ["Healthcare"], "regions": ["EMEA"], "size_bands": ["Mid-market"],
                 "countries": [], "intent_topics": ["HR Platform Replacement"] },
    "desired_outputs": ["intent_signals", "technographics"],
    "context": {
      "schema": "champions.user_context/v1",
      "consent_id": "cns-8538a81eff30",
      "purpose": "market_insights",
      "shared": { "industry": "HR Software", "role": "Head of Sales" }
    } } } ] } }
}
```

**Response: Task with a `catalog_result` artifact**
```json
{ "result": { "task": {
  "id": "…", "contextId": "…", "status": { "state": "TASK_STATE_COMPLETED" },
  "artifacts": [ { "name": "catalog_result", "parts": [ { "data": {
    "schema": "champions.catalog_result/v1",
    "matches": [ { "card_id": "intent_signals", "relevance": 1.0, "why": "Request mentions switching, topic filter",
                   "matched_fields": ["intent_topic", "intent_score", "surge_start"],
                   "coverage_pct": 61.8, "refresh": "daily", "credits_per_1k_records": 120,
                   "contains_personal_data": false } ],
    "matching_companies": 88,
    "insights": [ { "label": "Researching HR Platform Replacement", "value": 16,
                    "detail": "18.2% of the segment, average surge score 73" } ],
    "sample": [ { "company_name": "…", "hq_country": "Ireland", "size_band": "Mid-market",
                  "hr_platform": "ADP", "intent_topic": "HR Platform Replacement" } ],
    "method": "Keyword and filter match … No records exported.",
    "consent_id": "cns-8538a81eff30" } } ] } ] } } }
```

**MCP: `tools/call`**
```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "get_vaf_fields", "arguments": { "card_id": "intent_signals" } } }
```

**Personal Agent output: `recommendation/v1`** (stays on the user side)
```json
{ "schema": "champions.recommendation/v1",
  "summary": "Buy Intent Signals + Firmographics for about 520 credits/month (80 under your 600-credit budget).",
  "options": [ { "card_id": "intent_signals", "score": 87.6, "verdict": "recommended",
                 "est_monthly_credits": 480, "reasons": ["…"] } ],
  "bundle": ["intent_signals", "firmographics"], "bundle_monthly_credits": 520, "within_budget": true }
```

## 5. Authentication and authorization

- **Agent identity:** each partner agent is a registered OAuth2 client. The Personal Agent uses the **client-credentials** grant at `POST /oauth/token` and receives a **short-lived JWT** (5 minutes) with `iss`, `aud`, `sub`, `scope`, `exp` and `jti`.
- **Declared in the Agent Card:** `securitySchemes.bearer` (HTTP Bearer, JWT) plus a security requirement, so a client knows how to authenticate before its first call.
- **Enforced on every call:** middleware verifies signature, audience, issuer and expiry for `/a2a`, `/mcp` and `/audit` (401 + `WWW-Authenticate` otherwise).
- **Least privilege by scope:**

  | Scope | Allows |
  |---|---|
  | `catalog:read` | `describe_capabilities`, `find_data_cards`, MCP catalog tools |
  | `insights:read` | `get_insights` (A2A) and MCP `get_insights` |
  | `audit:read` | Read this client's own audit entries |
  | `contacts:read` | *Not granted to the demo client*: personal data needs a DPA |

- **Production upgrades:** asymmetric signing (RS256/ES256) with a JWKS endpoint; client authentication with `private_key_jwt` or mTLS instead of a shared secret; **OAuth 2.0 Token Exchange (RFC 8693)** when the Personal Agent acts *for a specific user*, so tokens carry both the agent and the user (`act` claim); signed Agent Cards; rate limits per client.

## 6. User consent and data privacy

- **Three sharing classes per profile field:** `shareable` (pre-ticked), `opt_in` (unticked: company name, target segment), `private` (locked: budget, must-have fields, compliance policy, notes). Private fields are rejected by the consent store even if requested.
- **Purpose-bound consent:** one consent per *(user, purpose)*: `data_discovery`, `market_insights`, `outreach`. Asking for contacts switches the purpose to `outreach` and triggers a new consent prompt.
- **Data minimisation:** only consented fields go into `user_context.shared`. Even search *filters* drawn from the user's stored target segment are used only if `target_segment` was consented; otherwise filters come from the question alone.
- **Consent receipt on the wire:** every request carries `consent_id` and `purpose`. Champions records them in its audit log with the *names* of shared fields, never their values.
- **Revocation:** revoking removes the consent; the next question asks again and nothing is sent until the user approves.
- **Provider-side protections:** no bulk export over A2A; only aggregates plus a 5-row sample without personal data; the Contacts card is described but never delivered over this channel; a GDPR-strict user is steered away from it by their own agent.
- **Transparency:** the user sees every outbound message (tokens and secrets redacted) and Champions' audit view of them.

## 7. Context sharing and structured user profiles

```json
{
  "industry": "HR Software",            "role": "Head of Sales",       "region": "EMEA",
  "goals": ["Build pipeline with companies replacing their HR platform"],
  "target_segment": { "industries": ["Healthcare"], "regions": ["EMEA"], "size_bands": ["Mid-market"] },
  "company_name": "PeopleFlow GmbH",
  "budget_monthly_credits": 600,        "must_have_fields": ["intent_score", "hr_platform", "employee_count"],
  "compliance": "gdpr_strict",          "freshness": "weekly",
  "private_notes": "…"
}
```

- The **profile lives with the Personal Agent**; Champions receives a *projection* of it (`user_context`) that is scoped to one purpose and versioned.
- Context is **flattened** for the wire (`target_segment.industries`), so a provider can't receive nested data it didn't ask for.
- The Personal Agent uses the **full** profile locally: it checks must-have fields against MCP field definitions, compares refresh rates to the needed freshness, and fits the bundle to the budget.

## 8. Evaluation logic (Personal Agent)

`score = 45·relevance + 15·coverage + 15·freshness fit + 15·affordable + 10·must-have coverage`

- `recommended` ≥ 62, `optional` ≥ 45. Personal-data cards are `not_recommended` for GDPR-strict users.
- The bundle takes recommended cards in score order while they fit the monthly budget. A card that doesn't fit is downgraded to `optional`, with the reason given.
- Monthly credits = price per 1k × max(segment, 1,000 minimum order) × deliveries per month.

## 9. Demo scope vs production

| Demo | Production |
|---|---|
| Rule-based planner and matcher (no LLM, works offline) | An LLM for need parsing and wording; the protocol and contracts stay the same |
| HS256 shared signing key, one registered client | IdP with JWKS, private_key_jwt or mTLS, token exchange for user delegation |
| In-memory consent ledger, task store and audit log | Durable stores; consent receipts (e.g. Kantara-style); tamper-evident audit |
| Synthetic catalog and companies | Real Champions catalog, coverage stats, pricing |
| Non-streaming A2A | Streaming and push notifications for long jobs (list builds, enrichment) |
| Both agents on localhost | Separate trust domains, TLS, signed Agent Cards, rate limiting |

## 10. Agent-to-agent testing: what we learned

Setup: 10 personal agents (sales, channel sales, customer success, marketing ops, product marketing, RevOps, strategy, investor, talent acquisition), 41 realistic questions, all sent over the real path (OAuth → Agent Card → A2A → MCP → feedback). Each personal agent judges every insight against its person's **private** profile and sends back only *useful / not useful*. Everything lands in the Champions query log (Agent Lab: `http://127.0.0.1:9100/lab`, export CSV/JSONL). Re-run any time: **Run simulation** in the Lab or `scripts\simulate.py`.

### Q1. Can Champions find insights that matter to the person?
Yes, once the person's agent shares **role and goals** (consented, never budget or notes):
- Every question was answered with data (100%), and **52% of insights were judged useful** by the asking agent's private judgement. That rose to **72% for a Head of Sales**, whose goal matches our data best.
- Ranking is explained to the user in a "why for you" line, e.g. *"As Head of Sales, these look like switchers away from a competing platform; it answers what you asked."*
- What the question asks for explicitly (renewals, spend, cloud migration…) goes first; role and goals order the rest.

### Q2. What do agents ask?
By intent, from the log: tech stack (9), growth & funding (7), market sizing (6), switching/displacement (5), who is researching X (4), account discovery (3), contacts (2), timing/renewals (2), catalog (1). Buyers' agents mostly ask **"who uses what"**, **"who is growing"** and **"how big is it"**, not for raw lists.

### Q3. Which responses are actually useful?
| Insight type | Useful when shown |
|---|---|
| Topic surge (who is researching X) | 95% |
| Top topics in a segment | 100% (3 shown) |
| Fast growers (20%+ growth) | 79% |
| Funding mix | 70% |
| Legacy-platform switchers | 57% |
| Hot accounts (surge ≥ 80) | 50% |
| CRM mix / overall intent | 50% |
| ERP mix, HR-tech spend, country hotspot, cloud mix | 33–41% |
| Segment size | 31% |
| Renewals soon | 16% |

**Reading:** *actionable, specific* insights (who is researching, who is growing, who is switching) beat *descriptive* ones (segment size, mixes). "Renewals soon" is shown often but rarely useful: the data only has the **HR** contract renewal, so ERP and cloud buyers can't use it.

### Q4. How the real queries improve the agent next
The Lab turns gaps into a to-do list:
1. **Signals not tracked** (hiring/job postings, ESG): add them to the catalog, or say clearly that they aren't covered.
2. **Contacts requested over A2A**: offer a consented outreach flow (Contacts card + DPA + `contacts:read`), or return a count of reachable personas.
3. **Renewal data is HR-only**: add ERP/CRM/cloud contract renewal windows (the most-shown, least-useful insight).
4. **Vague questions** ("what's hot?"): ask back with A2A `INPUT_REQUIRED` instead of answering for every company.
5. Use the exported query log as a **golden set**: replay it after each change and compare usefulness, then swap the rule-based planner/ranker for an LLM and measure against the same set.

### MCP as a wrapper around our API
Champions now has a plain REST API (`/api/v1/cards`, `/cards/{id}/fields`, `/search`, `/insights`, `/feedback`, `/query-stats`) protected by an **internal API key**. The MCP server's tools (`list_data_cards`, `get_vaf_fields`, `find_data_cards`, `get_insights`, `get_query_stats`) **call that API with the key the server holds**. An MCP client (a partner agent, Claude Desktop…) presents only its own OAuth token and calls tools by name. It never needs API credentials or endpoint knowledge. Set `CHAMPIONS_API_URL` to point the same MCP server at a remote/real API.

```mermaid
flowchart LR
    C[Any MCP client] -- "OAuth bearer, tools/call get_insights" --> M[Champions MCP server]
    M -- "X-API-Key (held by server), POST /api/v1/insights" --> API[Champions REST API]
    API --> E[Insight engine + query log]
```
