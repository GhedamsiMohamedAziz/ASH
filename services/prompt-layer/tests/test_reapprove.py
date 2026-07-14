"""Approval re-mint loop (§13.3): once a human approves a gated tool, the re-minted TASK JWT
must promote exactly that tool into allowed_tools and pass a gateway-style verify."""

import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.pipeline import (  # noqa: E402
    TASK_JWT_AUD, TASK_JWT_ISS, TASK_JWT_SECRET, reapprove_task_jwt,
)
from olma_shared import jwt  # noqa: E402

client = TestClient(app)


def test_reapprove_promotes_tool_and_verifies_gateway_side():
    token = reapprove_task_jwt(
        "usr_1", "org_1", "github.merge_pr",
        allowed=["github.search", "github.create_pr"],
        approval=["github.merge_pr"],
    )
    # Verify the way the gateway does: iss/aud enforced, exp required.
    claims = jwt.verify(token, TASK_JWT_SECRET, iss=TASK_JWT_ISS, aud=TASK_JWT_AUD)
    assert "github.merge_pr" in claims["allowed_tools"]      # promoted in
    assert "github.merge_pr" not in claims["approval_tools"]  # and out of approval
    assert "github.create_pr" in claims["allowed_tools"]      # others untouched
    assert claims["exp"] > claims["iat"]                      # short-lived, has expiry


def test_reapprove_is_idempotent_if_already_allowed():
    token = reapprove_task_jwt("u", "o", "t", allowed=["t"], approval=[])
    claims = jwt.verify(token, TASK_JWT_SECRET)
    assert claims["allowed_tools"] == ["t"]  # no duplicate


def test_internal_reapprove_endpoint():
    r = client.post("/internal/reapprove", json={
        "user_id": "usr_1", "org_id": "org_1", "tool": "github.merge_pr",
        "allowed_tools": ["github.search"], "approval_tools": ["github.merge_pr"],
    })
    assert r.status_code == 200
    claims = jwt.verify(r.json()["task_jwt"], TASK_JWT_SECRET, iss=TASK_JWT_ISS, aud=TASK_JWT_AUD)
    assert "github.merge_pr" in claims["allowed_tools"]
