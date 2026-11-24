// HS256 JSON Web Tokens with WebCrypto (works in Workers and Node 20+).

const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

function fromB64url(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function key(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(claims, secret) {
  const data = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export class JwtError extends Error {}

/** Verified claims, or throws JwtError("token expired" | "invalid token: ..."). */
export async function verify(token, secret, { audience, issuer, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new JwtError("invalid token: Not enough segments");
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw new JwtError("invalid token: Invalid header padding");
  }
  if (header.alg !== "HS256") throw new JwtError("invalid token: The specified alg value is not allowed");
  const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new JwtError("invalid token: Signature verification failed");
  if (typeof claims.exp === "number" && now >= claims.exp) throw new JwtError("token expired");
  if (audience !== undefined && claims.aud !== audience) throw new JwtError("invalid token: Audience doesn't match");
  if (issuer !== undefined && claims.iss !== issuer) throw new JwtError("invalid token: Invalid issuer");
  return claims;
}
