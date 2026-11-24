// Both agents around one db. The Personal Agent calls the Champions Group Agent in-process
// with real Request objects, so the OAuth -> Agent Card -> A2A -> MCP exchange is the same as
// over the network. Used by the Durable Object (edge.js) and by tests.
import { createChampions } from "./champions/app.js";
import { createPersonal } from "./personal/app.js";
import { isChampionsPath } from "./routes.js";

export const CLIENT_ID = "personal-agent-demo";

export function createAgents({ db, pages, publicUrl, labPassword, clientSecret }) {
  const champions = createChampions({
    db,
    pages,
    config: { publicUrl, labPassword, clients: { [CLIENT_ID]: clientSecret }, hosted: true },
  });
  const personal = createPersonal({
    db,
    pages,
    champions: (request) => champions.fetch(request),
    config: { championsBase: publicUrl, clientId: CLIENT_ID, clientSecret },
  });
  return {
    champions,
    personal,
    fetch(request) {
      const { pathname } = new URL(request.url);
      return isChampionsPath(pathname) ? champions.fetch(request) : personal.fetch(request);
    },
  };
}
