/**
 * Cloudflare Worker in front of the Champions A2A demo container.
 *
 * One public URL serves both agents. The container runs the Champions Group
 * Agent on :9100 and the Personal Agent on :9200; this Worker sends each path
 * to the right port. Inside the container the two agents talk over 127.0.0.1.
 */
import { DurableObject } from "cloudflare:workers";

import { CHAMPIONS_PORT, PERSONAL_PORT, portFor } from "./routes.js";

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const READY_PATHS = { [CHAMPIONS_PORT]: "/health", [PERSONAL_PORT]: "/api/health" };

export class ChampionsDemo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      // Restore the timeout and exit monitoring after a Durable Object restart.
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
      this.observeExit();
    }
  }

  async fetch(request) {
    const incoming = new URL(request.url);
    this.starting ??= this.start(incoming.origin).finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    // Keep the public host so the agents see the URL partners use; TLS ends at Cloudflare.
    const url = new URL(incoming);
    url.protocol = "http:";
    const forwarded = new Request(url, request);
    return this.ctx.container.getTcpPort(portFor(incoming.pathname)).fetch(forwarded);
  }

  async start(publicOrigin) {
    const container = this.ctx.container;
    if (!container.running) {
      const env = {
        CHAMPIONS_PUBLIC_URL: publicOrigin,
        CHAMPIONS_URL: `http://127.0.0.1:${CHAMPIONS_PORT}`,
        PERSONAL_AGENT_CLIENT_SECRET: this.env.PERSONAL_AGENT_CLIENT_SECRET,
      };
      // Without LAB_PASSWORD the hosted Agent Lab fails closed (refuses everyone).
      if (this.env.LAB_PASSWORD) env.CHAMPIONS_LAB_PASSWORD = this.env.LAB_PASSWORD;
      container.start({
        image: container.images.base,
        instance: "standard-1",
        enableInternet: false,
        env,
      });
    }
    this.observeExit();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // running means startup was requested, not that both servers are ready.
    for (const port of [CHAMPIONS_PORT, PERSONAL_PORT]) {
      await this.waitForPort(port);
    }
  }

  async waitForPort(port) {
    const tcp = this.ctx.container.getTcpPort(port);
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const response = await tcp.fetch(`http://container${READY_PATHS[port]}`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Not listening yet: retry the readiness probe.
      }
      await scheduler.wait(200);
    }
    throw new Error(`Container did not become ready on port ${port}`);
  }

  observeExit() {
    if (this.monitoring) return;
    this.monitoring = this.ctx.container
      .monitor()
      .then(() => console.log("Container exited"))
      .catch((error) => console.error("Container failed:", error))
      .finally(() => {
        this.monitoring = undefined;
      });
    this.ctx.waitUntil(this.monitoring);
  }
}

// Secrets the deployment needs: `npx wrangler secret put <NAME>`.
const REQUIRED_SECRETS = ["PERSONAL_AGENT_CLIENT_SECRET", "LAB_PASSWORD"];

export default {
  async fetch(request, env) {
    const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
    if (missing.length) {
      // Fail closed: never run with the demo secret that is published in the repo.
      console.error(`Missing Worker secrets: ${missing.join(", ")}`);
      return new Response("This deployment is not configured yet.", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    try {
      // A single instance: the demo keeps its query log and consents in memory and SQLite.
      return await env.CHAMPIONS_DEMO.getByName("main").fetch(request);
    } catch (error) {
      console.error("Container request failed:", error);
      return new Response(
        "The demo is starting up (cold start takes about 30 seconds). Please refresh in a moment.",
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "10" } },
      );
    }
  },
};
