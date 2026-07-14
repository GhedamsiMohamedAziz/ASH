#!/usr/bin/env python3
"""platctl — the solo-ops CLI (instructions.md §24.4).

Scriptable, usable in an incident, versioned with the platform. It consumes the
admin API (same controls, same audit). This is the command parser + dispatch; each
command maps to an admin-API call (injected as a client so it is testable and the
real HTTP client drops in for prod). Destructive commands require confirmation.

Usage:  platctl status | sandbox list|kill|drain | jobs pause --org acme |
        budget set --org acme --monthly 500 | user offboard usr_x | audit tail ...
"""

from __future__ import annotations

import argparse
from typing import Protocol


class AdminClient(Protocol):
    def status(self) -> dict: ...
    def sandbox(self, action: str, target: str | None) -> dict: ...
    def jobs_pause(self, org: str | None, all_orgs: bool) -> dict: ...
    def budget_set(self, org: str, monthly: float) -> dict: ...
    def offboard(self, user_id: str) -> dict: ...
    def audit_tail(self, filter_expr: str | None) -> list: ...
    def schedules_resync(self) -> dict: ...
    def connectors(self, action: str, cid: str | None) -> dict: ...


DESTRUCTIVE = {"sandbox:kill", "sandbox:drain", "user:offboard"}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="platctl")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")

    sb = sub.add_parser("sandbox")
    sb.add_argument("action", choices=["list", "kill", "drain"])
    sb.add_argument("target", nargs="?")

    jb = sub.add_parser("jobs")
    jb.add_argument("action", choices=["pause"])
    jb.add_argument("--org")
    jb.add_argument("--all", action="store_true")

    bg = sub.add_parser("budget")
    bg.add_argument("action", choices=["set"])
    bg.add_argument("--org", required=True)
    bg.add_argument("--monthly", type=float, required=True)

    us = sub.add_parser("user")
    us.add_argument("action", choices=["offboard"])
    us.add_argument("user_id")

    au = sub.add_parser("audit")
    au.add_argument("action", choices=["tail"])
    au.add_argument("--filter")

    sc = sub.add_parser("schedules")
    sc.add_argument("action", choices=["resync"])

    cn = sub.add_parser("connectors")
    cn.add_argument("action", choices=["health", "probe"])
    cn.add_argument("id", nargs="?")
    return p


def dispatch(args: argparse.Namespace, client: AdminClient,
             confirm: bool = False):
    """Run a parsed command against the admin client. Destructive → needs confirm=True."""
    key = f"{args.cmd}:{getattr(args, 'action', '')}".rstrip(":")
    if key in DESTRUCTIVE and not confirm:
        return {"error": "confirmation required", "needs_confirm": True, "command": key}

    if args.cmd == "status":
        return client.status()
    if args.cmd == "sandbox":
        return client.sandbox(args.action, args.target)
    if args.cmd == "jobs":
        return client.jobs_pause(args.org, args.all)
    if args.cmd == "budget":
        return client.budget_set(args.org, args.monthly)
    if args.cmd == "user":
        return client.offboard(args.user_id)
    if args.cmd == "audit":
        return client.audit_tail(args.filter)
    if args.cmd == "schedules":
        return client.schedules_resync()
    if args.cmd == "connectors":
        return client.connectors(args.action, getattr(args, "id", None))
    return {"error": "unknown command"}


def run(argv: list[str], client: AdminClient, confirm: bool = False):
    return dispatch(build_parser().parse_args(argv), client, confirm=confirm)
