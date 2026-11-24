"""HTTP Basic login shared by the Agent Lab and the demo page (production: the company's SSO)."""

import base64
import binascii
import secrets


def credentials_ok(authorization, user, password):
    """True when an Authorization header carries exactly this user and password."""
    scheme, _, encoded = (authorization or "").partition(" ")
    try:
        given_user, _, given_password = base64.b64decode(encoded, validate=True).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError):
        given_user, given_password = "", ""
    # Compare both parts every time so timing does not reveal which one was wrong.
    user_ok = secrets.compare_digest(given_user.encode(), user.encode())
    password_ok = secrets.compare_digest(given_password.encode(), password.encode())
    return scheme.lower() == "basic" and user_ok and password_ok


def challenge(realm):
    return {"WWW-Authenticate": f'Basic realm="{realm}", charset="UTF-8"'}
