#!/usr/bin/env python3
"""
Migration linter (AX-004, instructions.md §22.3, §16.3).

Delivers the CI guarantee the blueprint assigns to Atlas — "destructive change in
a release = STOP" (expand/contract) — without requiring the atlas binary:

  1. naming/order    files match NNNN_name.sql and are gap-free, ascending;
  2. destructive lint DROP TABLE/COLUMN, ALTER..DROP, TRUNCATE, RENAME → STOP
                      (expand/contract migrations add, never destroy, in a release);
  3. apply-clean     (optional, --dsn) applies every migration to a fresh DB.

Exit non-zero on any violation so CI blocks the merge. Atlas remains the prod
tool; this is the dependency-free gate for this repo.

Run:  python3 tools/migrate_lint.py [--dsn postgresql://…]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG_DIR = ROOT / "db" / "migrations"

NAME_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
# Destructive DDL that breaks expand/contract in a single release (§16.3).
DESTRUCTIVE = [
    (re.compile(r"\bDROP\s+TABLE\b", re.I), "DROP TABLE"),
    (re.compile(r"\bDROP\s+COLUMN\b", re.I), "DROP COLUMN"),
    (re.compile(r"\bALTER\s+TABLE\b[^;]*\bDROP\b", re.I | re.S), "ALTER … DROP"),
    (re.compile(r"\bTRUNCATE\b", re.I), "TRUNCATE"),
    (re.compile(r"\bDROP\s+(?:NOT\s+NULL|CONSTRAINT)\b", re.I), "DROP constraint/not-null"),
    (re.compile(r"\bRENAME\s+(?:TO|COLUMN)\b", re.I), "RENAME (breaks readers)"),
]


def _strip_sql_comments(sql: str) -> str:
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"/\*.*?\*/", "", sql, flags=re.S)


def lint_files() -> list[str]:
    errors: list[str] = []
    files = sorted(MIG_DIR.glob("*.sql"))
    if not files:
        return [f"no migrations in {MIG_DIR}"]

    seq_prev = 0
    for f in files:
        m = NAME_RE.match(f.name)
        if not m:
            errors.append(f"{f.name}: bad name (want NNNN_snake_case.sql)")
            continue
        seq = int(m.group(1))
        if seq != seq_prev + 1:
            errors.append(f"{f.name}: sequence gap/dup (expected {seq_prev + 1:04d})")
        seq_prev = seq

        body = _strip_sql_comments(f.read_text())
        for rx, label in DESTRUCTIVE:
            if rx.search(body):
                errors.append(f"{f.name}: destructive statement [{label}] — "
                              f"use expand/contract (§16.3), do not destroy in a release")
    return errors


def apply_clean(dsn: str) -> list[str]:
    import asyncio
    import asyncpg

    async def go() -> list[str]:
        con = await asyncpg.connect(dsn)
        errs: list[str] = []
        try:
            for f in sorted(MIG_DIR.glob("*.sql")):
                try:
                    await con.execute(f.read_text())
                except Exception as e:  # noqa: BLE001
                    errs.append(f"{f.name}: failed to apply — {e}")
        finally:
            await con.close()
        return errs

    return asyncio.run(go())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", help="apply migrations to this DB (clean/empty) as a check")
    args = ap.parse_args()

    errors = lint_files()
    if not errors:
        print(f"✓ lint: {len(list(MIG_DIR.glob('*.sql')))} migrations, naming + no destructive DDL")
    if args.dsn and not errors:
        applied = apply_clean(args.dsn)
        errors += applied
        if not applied:
            print("✓ apply-clean: all migrations applied to the target DB")

    if errors:
        print("\nMIGRATION LINT FAILED (CI would STOP):", file=sys.stderr)
        for e in errors:
            print(f"  ✗ {e}", file=sys.stderr)
        sys.exit(1)
    print("✓ migrations OK")


if __name__ == "__main__":
    main()
