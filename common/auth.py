"""OAuth2 client-credentials tokens (short-lived, scoped JWTs) for the demo.

Champions Group registers each partner agent as a client with the scopes it
may request. The Personal Agent exchanges its client id and secret for a token
and sends it as ``Authorization: Bearer ...`` on every A2A and MCP call.

Demo note: tokens are HS256 with a shared secret from the environment. A
production deployment would use an identity provider and asymmetric keys
(RS256/ES256, published via JWKS) so partners never hold the signing key.
"""

import os
import secrets
import time

import jwt

ISSUER = "https://champions.example/oauth"
AUDIENCE = "champions-agent"
TOKEN_TTL_SECONDS = 300

# Signing key: from the environment, else random per process (tokens then
# simply expire on restart, which is fine for a demo).
SIGNING_KEY = os.getenv("CHAMPIONS_SIGNING_KEY") or secrets.token_urlsafe(32)

# Internal key for the Champions REST API (/api/v1). Held only by Champions'
# own services, e.g. the MCP server that wraps the API: MCP callers never see it.
# No hard-coded default: random per process unless set (only this process needs it).
API_KEY = os.getenv("CHAMPIONS_API_KEY") or secrets.token_urlsafe(32)

# The local demo's client secret. It is in the public repo, so a hosted deployment
# (CHAMPIONS_PUBLIC_URL set) refuses it: set PERSONAL_AGENT_CLIENT_SECRET there.
DEMO_CLIENT_SECRET = "demo-secret-change-me"

# Registered partner clients: id -> (secret, scopes it may be granted).
CLIENTS = {
    "personal-agent-demo": {
        "secret": os.getenv("PERSONAL_AGENT_CLIENT_SECRET") or DEMO_CLIENT_SECRET,
        "scopes": {"catalog:read", "insights:read", "audit:read"},
    },
}


class AuthError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def issue_token(client_id, client_secret, requested_scopes):
    client = CLIENTS.get(client_id)
    if not client or not secrets.compare_digest(client["secret"], client_secret or ""):
        raise AuthError(401, "invalid_client")
    if os.getenv("CHAMPIONS_PUBLIC_URL") and client["secret"] == DEMO_CLIENT_SECRET:
        raise AuthError(401, "invalid_client: the public demo secret is disabled when hosted")

    requested = set(requested_scopes.split()) if requested_scopes else set(client["scopes"])
    denied = requested - client["scopes"]
    if denied:
        raise AuthError(400, f"invalid_scope: {' '.join(sorted(denied))}")

    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": client_id,
        "scope": " ".join(sorted(requested)),
        "iat": now,
        "exp": now + TOKEN_TTL_SECONDS,
        "jti": secrets.token_hex(8),
    }
    return {
        "access_token": jwt.encode(claims, SIGNING_KEY, algorithm="HS256"),
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_SECONDS,
        "scope": claims["scope"],
    }


def verify_token(authorization_header):
    """Claims for a valid bearer token, else AuthError(401)."""

    if not authorization_header or not authorization_header.startswith("Bearer "):
        raise AuthError(401, "missing bearer token")
    token = authorization_header[len("Bearer "):].strip()
    try:
        return jwt.decode(
            token,
            SIGNING_KEY,
            algorithms=["HS256"],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["exp", "iat", "sub", "scope"]},
        )
    except jwt.ExpiredSignatureError as error:
        raise AuthError(401, "token expired") from error
    except jwt.InvalidTokenError as error:
        raise AuthError(401, f"invalid token: {error}") from error


def require_scope(claims, scope):
    if scope not in set(claims.get("scope", "").split()):
        raise AuthError(403, f"insufficient_scope: needs {scope}")
