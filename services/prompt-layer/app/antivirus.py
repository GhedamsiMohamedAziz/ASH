"""Attachment antivirus scan (instructions.md §17 security renforts).

Inbound attachments are scanned before storage/use. Real deployment shells out to
ClamAV (or a cloud AV); this module is the scan contract + a deterministic
signature check (incl. the EICAR test string) so the gate is testable in CI. An
infected file is rejected and logged (never stored, never handed to the agent).
"""

from __future__ import annotations

from dataclasses import dataclass

# The standard EICAR antivirus test signature (harmless, universally detected).
EICAR = r"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

# Extra heuristic signatures for the dev scanner (prod uses a real engine).
_SIGNATURES = [EICAR, "TVqQAAMAAAAEAAAA"]  # EICAR + a base64 PE header marker


@dataclass
class ScanResult:
    clean: bool
    signature: str | None = None


def scan(content: bytes | str) -> ScanResult:
    """Scan bytes/text; ScanResult.clean False → reject the upload (§17)."""
    text = content.decode("utf-8", "ignore") if isinstance(content, bytes) else content
    for sig in _SIGNATURES:
        if sig in text:
            return ScanResult(clean=False, signature="EICAR" if sig == EICAR else "pe_header")
    return ScanResult(clean=True)


class AttachmentRejected(Exception):
    code = "E_GUARD_INPUT_BLOCKED"


def guard_attachment(name: str, content: bytes | str) -> None:
    """Raise AttachmentRejected if the attachment is infected (fail-closed)."""
    r = scan(content)
    if not r.clean:
        raise AttachmentRejected(f"{name}: infected ({r.signature})")
