/**
 * Durable Object that runs both agents (JavaScript edition, Workers Free plan).
 *
 * One instance ("main") holds the synthetic data in memory and all state
 * (query log, consents, audit) in its SQLite storage.
 */
import { DurableObject } from "cloudflare:workers";

import indexPage from "../../personal/static/index.html";
import labPage from "../../champions/static/lab.html";
import { createAgents } from "./agents.js";
import { doDb } from "./common/db.js";

export class ChampionsEdge extends DurableObject {
  async fetch(request) {
    this.agents ??= createAgents({
      db: doDb(this.ctx.storage.sql),
      pages: { index: indexPage, lab: labPage },
      publicUrl: new URL(request.url).origin,
      labPassword: this.env.LAB_PASSWORD,
      clientSecret: this.env.PERSONAL_AGENT_CLIENT_SECRET,
    });
    return this.agents.fetch(request);
  }
}
