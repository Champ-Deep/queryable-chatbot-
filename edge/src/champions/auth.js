// OAuth2 client-credentials tokens (short-lived, scoped HS256 JWTs). Port of common/auth.py.
//
// The signing key and the internal REST API key are random per Durable Object start unless
// configured: tokens live 5 minutes, so a restart only means callers fetch a new one.
import { randomHex, randomToken, safeEqual } from "../common/http.js";
import { JwtError, sign, verify } from "../common/jwt.js";

export const ISSUER = "https://champions.example/oauth";
export const AUDIENCE = "champions-agent";
export const TOKEN_TTL_SECONDS = 300;
export const DEMO_CLIENT_SECRET = "demo-secret-change-me";
export const CLIENT_SCOPES = ["catalog:read", "insights:read", "audit:read"];

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param clients  {clientId: secret}
 * @param hosted   refuse the published demo secret
 */
export function createAuth({ clients = {}, hosted = false, signingKey, apiKey } = {}) {
  const key = signingKey || randomToken(32);
  const internalKey = apiKey || randomToken(32);

  async function issueToken(clientId, clientSecret, requestedScopes) {
    const secret = Object.hasOwn(clients, clientId) ? clients[clientId] : null;
    if (!secret || !safeEqual(secret, clientSecret ?? "")) throw new AuthError(401, "invalid_client");
    if (hosted && secret === DEMO_CLIENT_SECRET) {
      throw new AuthError(401, "invalid_client: the public demo secret is disabled when hosted");
    }
    const requested = requestedScopes ? [...new Set(requestedScopes.split(/\s+/).filter(Boolean))] : [...CLIENT_SCOPES];
    const denied = requested.filter((s) => !CLIENT_SCOPES.includes(s)).sort();
    if (denied.length) throw new AuthError(400, `invalid_scope: ${denied.join(" ")}`);

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER, aud: AUDIENCE, sub: clientId, scope: requested.sort().join(" "),
      iat: now, exp: now + TOKEN_TTL_SECONDS, jti: randomHex(8),
    };
    return { access_token: await sign(claims, key), token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: claims.scope };
  }

  /** Claims for a valid "Bearer ..." header, else AuthError(401). */
  async function verifyHeader(header) {
    if (!header || !header.startsWith("Bearer ")) throw new AuthError(401, "missing bearer token");
    try {
      const claims = await verify(header.slice(7).trim(), key, { audience: AUDIENCE, issuer: ISSUER });
      for (const required of ["exp", "iat", "sub", "scope"]) {
        if (!(required in claims)) throw new JwtError(`invalid token: Token is missing the "${required}" claim`);
      }
      return claims;
    } catch (err) {
      if (err instanceof JwtError) throw new AuthError(401, err.message);
      throw new AuthError(401, "invalid token");
    }
  }

  return { issueToken, verifyHeader, apiKey: internalKey };
}

export function requireScope(claims, scope) {
  if (!String(claims?.scope ?? "").split(" ").includes(scope)) throw new AuthError(403, `insufficient_scope: needs ${scope}`);
}
