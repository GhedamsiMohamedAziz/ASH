"""OAuth connect flow + refresh sweep (instructions.md §13.2, §15.7, §8.2).

The user connects a provider (GitHub/Notion/MS Graph/Slack); tokens are stored
SEALED in the Vault and injected only at the gateway (§13.2). This models the
flow's security-critical parts, verifiable offline:
  • start()   — build the authorize URL with an unguessable, single-use `state`
                (CSRF defense) bound to the user.
  • callback()— verify `state` (single-use), exchange the code, store the token.
  • refresh_sweep() — the Trigger.dev job `oauth-refresh-sweep` (§15.7): refresh
                tokens expiring within 24h; a token that cannot refresh is marked
                for reconnection (E_CONN_TOKEN_EXPIRED → reconnect card, §21).
The real HTTP token exchange is injected (a TokenExchanger) so tests need no network.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from typing import Callable, Protocol


def _new_state() -> str:
    return hashlib.sha256(os.urandom(32)).hexdigest()


@dataclass
class Token:
    provider: str
    access_token: str
    refresh_token: str | None
    expires_at: float  # epoch seconds


class TokenExchanger(Protocol):
    def exchange_code(self, provider: str, code: str) -> Token: ...
    def refresh(self, provider: str, refresh_token: str) -> Token: ...


@dataclass
class OAuthFlows:
    exchanger: TokenExchanger
    authorize_base: dict[str, str] = field(default_factory=lambda: {
        "github": "https://github.com/login/oauth/authorize",
        "notion": "https://api.notion.com/v1/oauth/authorize",
    })
    # pending state -> user_id  (Redis with short TTL in prod)
    _pending: dict[str, tuple[str, str]] = field(default_factory=dict)  # state -> (user, provider)
    tokens: dict[tuple[str, str], Token] = field(default_factory=dict)  # (user, provider) -> Token

    def start(self, user_id: str, provider: str) -> str:
        """Return the provider authorize URL carrying a single-use CSRF state."""
        state = _new_state()
        self._pending[state] = (user_id, provider)
        base = self.authorize_base.get(provider, f"https://{provider}/oauth/authorize")
        return f"{base}?state={state}&scope=read"

    def callback(self, state: str, code: str) -> Token:
        """Verify state (single-use, CSRF), exchange the code, store the token."""
        binding = self._pending.pop(state, None)  # single-use: pop
        if binding is None:
            raise OAuthError("invalid or reused state (CSRF)")
        user_id, provider = binding
        token = self.exchanger.exchange_code(provider, code)
        self.tokens[(user_id, provider)] = token
        return token

    def refresh_sweep(self, now: float, horizon: float = 86400) -> dict:
        """Refresh tokens expiring within `horizon` (default 24h, §15.7)."""
        refreshed, needs_reconnect = [], []
        for key, tok in list(self.tokens.items()):
            if tok.expires_at - now > horizon:
                continue  # not expiring soon
            if not tok.refresh_token:
                needs_reconnect.append(key)  # → E_CONN_TOKEN_EXPIRED reconnect card
                continue
            try:
                self.tokens[key] = self.exchanger.refresh(tok.provider, tok.refresh_token)
                refreshed.append(key)
            except OAuthError:
                needs_reconnect.append(key)
        return {"refreshed": refreshed, "needs_reconnect": needs_reconnect}


class OAuthError(Exception):
    code = "E_CONN_TOKEN_EXPIRED"
