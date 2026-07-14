#!/usr/bin/env python3
"""
Idempotent NATS JetStream provisioner (AX-010, instructions.md §8.2).

Reads infra/nats/streams.json and creates-or-updates each stream. Safe to run
repeatedly: an existing stream is updated in place (subjects/retention/limits),
a missing one is added. scheduled_jobs-style "our config is the source of truth"
applies — re-running reconciles NATS to streams.json.

Run:  NATS_URL=nats://localhost:4222 python3 tools/provision_nats.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import nats
from nats.js.api import RetentionPolicy, StorageType, StreamConfig

ROOT = Path(__file__).resolve().parent.parent
STREAMS_FILE = ROOT / "infra" / "nats" / "streams.json"

_RETENTION = {
    "limits": RetentionPolicy.LIMITS,
    "interest": RetentionPolicy.INTEREST,
    "workqueue": RetentionPolicy.WORK_QUEUE,
}
_STORAGE = {"file": StorageType.FILE, "memory": StorageType.MEMORY}


def _to_config(spec: dict) -> StreamConfig:
    return StreamConfig(
        name=spec["name"],
        subjects=spec["subjects"],
        retention=_RETENTION[spec.get("retention", "limits")],
        storage=_STORAGE[spec.get("storage", "file")],
        max_age=float(spec.get("max_age_seconds", 0)),  # seconds; 0 = unlimited
        max_msgs=int(spec.get("max_msgs", -1)),
        num_replicas=int(spec.get("num_replicas", 1)),
    )


async def provision(url: str) -> int:
    specs = json.loads(STREAMS_FILE.read_text())["streams"]
    nc = await nats.connect(url)
    js = nc.jetstream()

    existing = set()
    try:
        for info in await js.streams_info():
            existing.add(info.config.name)
    except Exception:
        pass  # empty server

    summary = []
    for spec in specs:
        cfg = _to_config(spec)
        if cfg.name in existing:
            await js.update_stream(config=cfg)
            summary.append((cfg.name, "updated"))
        else:
            await js.add_stream(config=cfg)
            summary.append((cfg.name, "created"))

    print(f"NATS JetStream @ {url} — provisioned {len(summary)} streams:")
    for name, action in summary:
        subjects = next(s["subjects"] for s in specs if s["name"] == name)
        print(f"  [{action:>7}] {name:<13} subjects={subjects}")

    await nc.drain()
    return 0


def main() -> None:
    url = os.environ.get("NATS_URL", "nats://localhost:4222")
    try:
        sys.exit(asyncio.run(provision(url)))
    except Exception as e:  # noqa: BLE001
        print(f"provisioning failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
