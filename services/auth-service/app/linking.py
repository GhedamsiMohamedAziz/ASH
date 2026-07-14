"""Account linking for unknown users (instructions.md §7.1, §7.2).

An unlinked Slack/Teams mention gets an ephemeral OIDC linking prompt; no
processing happens before linkage. This mints a signed, short-lived, single-use
linking token that binds a channel identity (provider + external_id) to the OIDC
round-trip, so the callback can attach it to the resolved canonical user. Reusing
a token (or a forged/expired one) is rejected fail-closed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time


class LinkingError(Exception):
    code = "E_AUTH_INVALID_TOKEN"


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


class LinkingService:
    def __init__(self, secret: str, ttl: int = 900) -> None:
        self._secret = secret
        self._ttl = ttl
        self._used: set[str] = set()  # single-use nonces (Redis TTL in prod)

    def start(self, provider: str, external_id: str, now: float | None = None) -> str:
        """Mint a linking token for an unlinked (provider, external_id) → returns a
        state string to carry through the OIDC authorize URL."""
        ts = int(now if now is not None else time.time())
        nonce = os.urandom(8).hex()
        body = {"provider": provider, "external_id": external_id, "exp": ts + self._ttl,
                "nonce": nonce}
        payload = json.dumps(body, separators=(",", ":"), sort_keys=True)
        sig = _sign(payload, self._secret)
        return f"{payload}|{sig}"

    def complete(self, state: str, canonical_user_id: str, now: float | None = None) -> dict:
        """Verify the state (signature, expiry, single-use) and produce the identity
        row binding (provider, external_id) → canonical_user_id."""
        try:
            payload, sig = state.rsplit("|", 1)
            body = json.loads(payload)
        except Exception as e:
            raise LinkingError("malformed linking token") from e

        if not hmac.compare_digest(_sign(payload, self._secret), sig):
            raise LinkingError("bad signature")
        ts = time.time() if now is None else now
        if ts > body["exp"]:
            raise LinkingError("linking token expired")
        if body["nonce"] in self._used:
            raise LinkingError("linking token already used")
        self._used.add(body["nonce"])

        # The identities-table binding (§16.1).
        return {"provider": body["provider"], "external_id": body["external_id"],
                "user_id": canonical_user_id}
