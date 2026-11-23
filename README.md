# Champions Group ⇄ Personal Agent: A2A demo

Two agents that talk to each other over open protocols:

| Agent | Port | Role |
|---|---|---|
| **Champions Group Agent** | 9100 | Data provider. Knows the data cards and VAF fields, answers with matches and aggregate insights. A2A server, MCP server, OAuth2 token endpoint. |
| **Personal Agent** | 9200 | The user's advocate. Holds their private profile and consents, asks Champions on their behalf, scores the answer against budget and policy, and recommends. Serves the demo page. |

The data catalog and the 2,400 companies are **synthetic** (mock Champions catalog).

## Run

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```
or by hand:
```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn champions.app:app --port 9100
.venv\Scripts\python.exe -m uvicorn personal.app:app --port 9200
```
Open **http://127.0.0.1:9200** (demo) and **http://127.0.0.1:9100/lab** (Agent Lab).

## Agent-to-agent testing (what the boss asked for)

- **Personalised insights:** Champions ranks about 12 insight types (who is researching X, legacy-platform switchers, hot accounts, renewals, growth, spend, tech mix…) for the person's shared role and goals, and explains each with "why for you".
- **Private usefulness:** the personal agent judges each insight against private notes, must-have fields and goals, then sends Champions only *useful / not useful* (A2A `champions.feedback/v1`).
- **Query log + Agent Lab** (`:9100/lab`): every query from agents, with intent, gaps and usefulness; export CSV/JSONL to improve the agent later.
- **Simulator:** 10 personas × 4–5 questions over the real path. **Run simulation** in the Lab or the demo's *Agent testing* tab, or `.venv\Scripts\python.exe scripts\simulate.py` (`--in-process` needs no servers). Report: `reports/simulation.md`.
- **MCP wraps the REST API:** `/api/v1/*` needs an internal key that only the MCP server holds; MCP callers just use their OAuth token.
- **Deep link:** `http://127.0.0.1:9200/#persona=chen&ask=Payroll%20outsourcing%20intent%20in%20Australia`

Findings: [docs/MODEL.md §10](docs/MODEL.md#10-agent-to-agent-testing-what-we-learned).

## Try it

1. Pick a user (Priya, Marcus or Aiko) and click an example question.
2. The agent asks for **consent** first and shows exactly which fields it would share. Private fields (budget, notes, must-have fields, compliance policy) are locked.
3. Watch the **Agent wire** tab: OAuth2 token → Agent Card discovery → A2A `SendMessage` → MCP `tools/call get_vaf_fields` → private evaluation. Click any row for the JSON.
4. **Champions audit** shows what Champions logged: consent id, purpose and *which* fields were shared, never their values.
5. **Profile & consent** lets you revoke a consent; the next question asks again.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest
```
66 tests. Covers personalised ranking, the query log, feedback, the MCP→REST wrapper, the simulator, OAuth scopes, the public Agent Card, A2A and MCP with and without tokens, consent enforcement (private data never on the wire), the evaluator, and full turns over A2A + MCP.

## Layout

```
common/      schemas.py (versioned JSON contracts), auth.py (OAuth2 client credentials, JWT)
champions/   app.py (A2A + MCP + OAuth), api.py (REST API the MCP tools wrap), insights.py (personalised
             insights), querylog.py (query log, intents, gaps), lab.py + static/lab.html (Agent Lab),
             service.py, catalog.py, data.py, matcher.py
personal/    app.py, agent.py (turn), planner.py, evaluator.py, judge.py (private usefulness),
             scenarios.py + simulator.py (agent testing), profile.py (10 personas + consent),
             champions_client.py (A2A/MCP client + wire recorder), static/index.html
docs/MODEL.md  architecture model and protocol research
```

See [docs/MODEL.md](docs/MODEL.md) for the model, protocol comparison and production notes.
