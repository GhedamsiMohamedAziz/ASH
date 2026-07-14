"""Signing-key store: generation, persistence, and rotation (instructions.md §13.4).

Two keys can be active at once — `current` (signs new tokens) and `previous`
(kept in the JWKS for an overlap window so tokens minted before a rotation still
verify). Dev keys are generated on first boot and persisted under a gitignored
`keys/` dir; they are never committed. Production would source keys from a KMS.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

from .jwt_rs256 import new_rsa_keypair, public_key_to_jwk

_STATE_FILE = "state.json"


def _new_kid() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m")
    return f"auth-{stamp}-{uuid.uuid4().hex[:8]}"


@dataclass
class SigningKey:
    kid: str
    private_key: RSAPrivateKey

    @property
    def public_key(self):
        return self.private_key.public_key()

    def jwk(self) -> dict[str, str]:
        return public_key_to_jwk(self.public_key, self.kid)


class KeyStore:
    """Holds current/previous signing keys and persists them under `keys_dir`."""

    def __init__(self, keys_dir: str | os.PathLike[str]) -> None:
        self.keys_dir = Path(keys_dir)
        self.current: SigningKey
        self.previous: SigningKey | None = None
        self._load_or_init()

    # ---------------------------------------------------------- persistence
    def _key_path(self, kid: str) -> Path:
        return self.keys_dir / f"{kid}.pem"

    def _write_key(self, key: SigningKey) -> None:
        pem = key.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        path = self._key_path(key.kid)
        path.write_bytes(pem)
        os.chmod(path, 0o600)

    def _read_key(self, kid: str) -> SigningKey:
        pem = self._key_path(kid).read_bytes()
        private_key = serialization.load_pem_private_key(pem, password=None)
        return SigningKey(kid=kid, private_key=private_key)  # type: ignore[arg-type]

    def _write_state(self) -> None:
        state = {"current": self.current.kid, "previous": self.previous.kid if self.previous else None}
        (self.keys_dir / _STATE_FILE).write_text(json.dumps(state, indent=2))

    def _load_or_init(self) -> None:
        self.keys_dir.mkdir(parents=True, exist_ok=True)
        state_path = self.keys_dir / _STATE_FILE
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text())
                self.current = self._read_key(state["current"])
                self.previous = self._read_key(state["previous"]) if state.get("previous") else None
                return
            except Exception:  # noqa: BLE001 — corrupt/partial state → regenerate fresh
                pass
        self.current = self._generate()
        self.previous = None
        self._write_state()

    def _generate(self) -> SigningKey:
        key = SigningKey(kid=_new_kid(), private_key=new_rsa_keypair())
        self._write_key(key)
        return key

    # ---------------------------------------------------------- operations
    def rotate(self) -> SigningKey:
        """Generate a new current key; demote the old current to previous.

        The old current stays in the JWKS (as `previous`) so tokens signed before
        the rotation still verify during the overlap window (§13.4).
        """
        old_previous = self.previous
        self.previous = self.current
        self.current = self._generate()
        # Drop the key that just fell out of the overlap window from disk.
        if old_previous is not None:
            self._key_path(old_previous.kid).unlink(missing_ok=True)
        self._write_state()
        return self.current

    def active_keys(self) -> list[SigningKey]:
        keys = [self.current]
        if self.previous is not None:
            keys.append(self.previous)
        return keys

    def public_keys(self) -> dict:
        """kid -> RSAPublicKey for the verifier (the active JWKS)."""
        return {k.kid: k.public_key for k in self.active_keys()}

    def jwks(self) -> dict[str, list[dict[str, str]]]:
        return {"keys": [k.jwk() for k in self.active_keys()]}
