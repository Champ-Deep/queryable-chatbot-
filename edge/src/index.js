/**
 * Worker entry: forwards every request to the single ChampionsEdge Durable Object.
 * The Worker itself does almost nothing (Workers Free: 10 ms CPU); the Durable
 * Object has 30 s of CPU per request, enough for agent turns and simulations.
 */
export { ChampionsEdge } from "./edge.js";

// Secrets the deployment needs: `npx wrangler secret put <NAME>`.
const REQUIRED_SECRETS = ["PERSONAL_AGENT_CLIENT_SECRET", "LAB_PASSWORD"];

export default {
  async fetch(request, env) {
    const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
    if (missing.length) {
      // Fail closed: never run with the demo secret that is published in the repo.
      console.error(`Missing Worker secrets: ${missing.join(", ")}`);
      return new Response("This deployment is not configured yet.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return env.CHAMPIONS_EDGE.getByName("main").fetch(request);
  },
};
