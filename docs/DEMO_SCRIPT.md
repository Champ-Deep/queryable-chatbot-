# Demo script (about 10 minutes)

A presenter's guide to the Champions Group ⇄ Personal Agent demo. Start both agents first (`start.ps1` or `./start.sh`) and keep two browser tabs open:

- **Tab 1: Personal Agent demo:** http://127.0.0.1:9200
- **Tab 2: Agent Lab:** http://127.0.0.1:9100/lab

To start from an empty Lab, click **Clear log** in the Lab before you begin.

---

## 1. The story (1 min)

> "Soon buyers won't browse our catalog. They'll send their own AI agent to ask us questions. That agent knows the person: their role, goals, budget and private notes. Our agent knows the data. This demo shows the two agents talking over open standards, with the user in control of what is shared."

Point at the header: **A2A 1.0 · MCP · OAuth2 · consent**.

## 2. Consent first (2 min), Tab 1

1. Persona: **Priya, Head of Sales at an HR-software vendor (Berlin)**.
2. Click *"Find mid-size healthcare companies in Europe that are switching HR platforms"*.
3. The agent asks for consent and lists every field it would share. Point out:
   - **shareable** fields are ticked (role, region, goals);
   - **private** fields (budget, must-have fields, data-protection policy, internal notes) are locked: *"never leaves your agent"*.
4. Click **Share selected & continue**.

## 3. Watch the agents talk (2 min), Tab 1, *Agent wire*

Walk through the colour-coded rows:

| Step | What it shows |
|---|---|
| **OAuth2** | The Personal Agent gets a 5-minute, scoped token. It has an agent identity, not a shared password. |
| **A2A card** | It discovers what Champions can do from its public Agent Card. |
| **A2A** | `SendMessage` carries the need and *only the consented fields*. |
| **MCP** | `tools/call get_vaf_fields` makes a precise, deterministic lookup of field definitions. |
| **Local** | Evaluation against budget and private notes happens inside the user's agent. |

Click any row to show the raw JSON. Then open:
- **Champions audit:** Champions recorded *which* fields were shared and the consent id, never the values.
- **Profile & consent:** revoke the consent; the next question asks again.

## 4. Personalised insights (1 min)

In the chat answer, show the ranked insights and their **"why for you"** lines. Each one is built only from what Priya chose to share. Each insight carries a private **useful / not useful** verdict. Only the yes/no goes back to Champions, never the reason.

## 5. Agent Lab: what agents really ask (3 min), Tab 2

Click **Run simulation**. Ten personas (sales, marketing ops, strategy, RevOps, investors, talent, product marketing, channel, customer success) send 41 questions over the real protocol path.

Walk the dashboard top to bottom:

1. **KPI tiles:** queries, answered-with-data rate, % of insights rated useful, unmet needs, answer time.
2. **What do agents ask?** Questions by intent (tech stack, growth, market sizing, switching…) with the useful-rate per intent.
3. **Which insights are actually useful?** These ratings tell us which insight types to invest in and which to retire.
4. **Who is asking?** The roles agents chose to share.
5. **Where we fall short:** real gaps with a suggested fix, for example *topic not tracked* (hiring signals, ESG) and *contacts not available*.

Click **Export CSV / JSONL**: *"Every real query is kept, so we can improve the agent with evidence instead of guesses."*

## 6. Architecture takeaway (1 min)

> "MCP wraps our REST API. A partner's agent presents its own OAuth token and calls tools by name. It never sees an API key or an endpoint. The same MCP server can point at our real API by changing one setting (`CHAMPIONS_API_URL`)."

Close with the next steps from [MODEL.md §9–10](MODEL.md): real catalog, an IdP with JWKS, token exchange for user delegation, and an LLM in the planner and judge.

---

### Handy deep link

Open a persona with a question already asked:

```
http://127.0.0.1:9200/#persona=chen&ask=Payroll%20outsourcing%20intent%20in%20Australia
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| Port 9100/9200 already in use | An earlier run is still alive. Close the minimized Python windows, or stop the `uvicorn` processes. |
| Demo shows Champions as offline | Check http://127.0.0.1:9100/health. Start the Champions agent first. |
| Lab is empty | Click **Run simulation**, or ask a question in the demo. |
