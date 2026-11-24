// Tiny HTTP helpers shared by both agents (no dependencies).

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function text(body, status = 200, contentType = "text/plain; charset=utf-8", headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": contentType, ...headers } });
}

export function html(body) {
  return text(body, 200, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
}

/** FastAPI-style error body: {"detail": "..."} */
export function error(status, detail, headers = {}) {
  return json({ detail }, status, headers);
}

export class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/**
 * Minimal router: add(method, "/path/{param}", handler).
 * handler(request, params, url, context) returns a Response (or a plain object, sent as JSON).
 * Throwing HttpError returns {"detail": ...} with its status.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const names = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\w+)\\?\}/g, (_, name) => {
          names.push(name);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({ method, regex, names, handler });
    return this;
  }

  get(p, h) { return this.add("GET", p, h); }
  post(p, h) { return this.add("POST", p, h); }
  delete(p, h) { return this.add("DELETE", p, h); }

  /** Returns a Response, or null when no route matches the path. */
  async handle(request, context = null) {
    const url = new URL(request.url);
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        const result = await route.handler(request, params, url, context);
        return result instanceof Response ? result : json(result);
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.detail, err.headers);
        throw err;
      }
    }
    return pathMatched ? error(405, "Method Not Allowed") : null;
  }
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, "body must be JSON");
  }
}

export async function readForm(request) {
  const body = await request.text();
  return Object.fromEntries(new URLSearchParams(body));
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomHex(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
