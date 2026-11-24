// Agent Lab: the Champions operator's view of what partner agents ask (port of champions/lab.py).
// Hosted, so it always asks for an HTTP Basic login (user "admin", Worker secret LAB_PASSWORD)
// and fails closed when no password is configured. Clearing the log also needs a custom
// header, so a cross-site form post cannot trigger it.
import { HttpError, Router, html, safeEqual, text } from "../common/http.js";

export const LAB_USER = "admin";
const CHALLENGE = { "WWW-Authenticate": 'Basic realm="Champions Agent Lab", charset="UTF-8"' };

/** True when an Authorization header carries exactly this user and password. */
export function credentialsOk(header, user, password) {
  const [scheme, encoded = ""] = String(header ?? "").split(" ", 2);
  let given = "";
  try {
    given = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    given = "";
  }
  const i = given.indexOf(":");
  const [u, p] = i >= 0 ? [given.slice(0, i), given.slice(i + 1)] : [given, ""];
  // Compare both parts every time so timing does not reveal which one was wrong.
  const userOk = safeEqual(u, user);
  const passwordOk = safeEqual(p, password);
  return scheme.toLowerCase() === "basic" && userOk && passwordOk;
}

export function createLab({ log, page, password }) {
  const router = new Router();
  router
    .get("/lab", () => html(page))
    .get("/lab/api/stats", () => log.stats())
    .get("/lab/api/recent", (_r, _p, url) => {
      const asked = parseInt(url.searchParams.get("limit") ?? "50", 10);
      return { queries: log.recent(Math.min(Math.max(Number.isNaN(asked) ? 50 : asked, 1), 500)) };
    })
    .get("/lab/api/export.{fmt}", (_r, { fmt }) => {
      if (fmt !== "csv" && fmt !== "jsonl") throw new HttpError(404, "use export.csv or export.jsonl");
      return text(log.export(fmt), 200, fmt === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson", {
        "Content-Disposition": `attachment; filename="champions_queries.${fmt}"`,
      });
    })
    .post("/lab/api/clear", (request) => {
      if (request.headers.get("x-requested-with") !== "lab") throw new HttpError(403, "missing X-Requested-With: lab");
      log.clear();
      return { cleared: true };
    });

  return {
    async fetch(request) {
      if (!password) throw new HttpError(403, "the Agent Lab needs LAB_PASSWORD when hosted");
      if (!credentialsOk(request.headers.get("authorization"), LAB_USER, password)) {
        throw new HttpError(401, "log in to the Agent Lab", CHALLENGE);
      }
      return router.handle(request);
    },
  };
}
