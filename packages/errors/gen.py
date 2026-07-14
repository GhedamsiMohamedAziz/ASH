#!/usr/bin/env python3
"""
Generate the shared error taxonomy for Python and TypeScript from errors.json.

One source of truth (instructions.md §21, Principle #6), emitted to both runtimes
so no service hand-rolls its own codes. Run:  python3 packages/errors/gen.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "errors.json"
PY_OUT = HERE / "dist" / "python" / "olma_errors.py"
TS_OUT = HERE / "dist" / "typescript" / "errors.ts"

RETRYABLE = {"auto_refresh", "backoff_3x", "once", "queue", "after_retry_after", "idempotent_only"}


def load() -> list[dict]:
    return json.loads(SRC.read_text(encoding="utf-8"))["errors"]


def gen_python(errors: list[dict]) -> str:
    lines = [
        '"""Generated from errors.json — do not edit. Source: instructions.md §21."""',
        "# NB: no `from __future__ import annotations` — keeps the dataclass loadable",
        "# via importlib.spec (annotations stay real objects, not strings).",
        "from typing import Optional",
        "from dataclasses import dataclass",
        "",
        "@dataclass(frozen=True)",
        "class ErrorSpec:",
        "    code: str",
        "    http: int",
        "    retry: str",
        "    group: str",
        "    messages: dict[str, str]",
        "    @property",
        "    def retryable(self) -> bool:",
        f"        return self.retry in {sorted(RETRYABLE)!r}",
        "    def message(self, locale: str = 'en', **kw) -> str:",
        "        lang = (locale or 'en').split('-')[0]",
        "        tmpl = self.messages.get(lang) or self.messages['en']",
        "        return tmpl.format(**kw) if kw else tmpl",
        "",
        "ERRORS: dict[str, ErrorSpec] = {",
    ]
    for e in errors:
        lines.append(
            f"    {e['code']!r}: ErrorSpec({e['code']!r}, {e['http']}, "
            f"{e['retry']!r}, {e['group']!r}, {json.dumps(e['msg'], ensure_ascii=False)}),"
        )
    lines += [
        "}",
        "",
        "# Convenience constants: E_PERM_TOOL_DENIED == 'E_PERM_TOOL_DENIED'",
        *[f"{e['code']} = {e['code']!r}" for e in errors],
        "",
        "def envelope(code: str, *, trace_id: str | None = None, locale: str = 'en',",
        "             message: str | None = None, retry_after: int | None = None, **kw) -> dict:",
        '    """Build the unified error envelope (§8.3)."""',
        "    spec = ERRORS[code]",
        "    return {'error': {'code': code, 'message': message or spec.message(locale, **kw),",
        "                      'trace_id': trace_id, 'retry_after': retry_after}}",
        "",
    ]
    return "\n".join(lines)


def gen_typescript(errors: list[dict]) -> str:
    union = " | ".join(f'"{e["code"]}"' for e in errors)
    lines = [
        "// Generated from errors.json — do not edit. Source: instructions.md §21.",
        "export interface ErrorSpec {",
        "  code: string; http: number; retry: string; group: string;",
        "  messages: Record<string, string>;",
        "}",
        "",
        f"export type ErrorCode = {union};",
        "",
        "export const ERRORS: Record<ErrorCode, ErrorSpec> = {",
    ]
    for e in errors:
        lines.append(
            f'  {e["code"]}: {{ code: "{e["code"]}", http: {e["http"]}, '
            f'retry: "{e["retry"]}", group: "{e["group"]}", '
            f"messages: {json.dumps(e['msg'], ensure_ascii=False)} }},"
        )
    lines += [
        "};",
        "",
        f"const RETRYABLE = new Set({json.dumps(sorted(RETRYABLE))});",
        "export const isRetryable = (code: ErrorCode): boolean => RETRYABLE.has(ERRORS[code].retry);",
        "",
        "export function message(code: ErrorCode, locale = 'en', vars: Record<string,string> = {}): string {",
        "  const lang = (locale || 'en').split('-')[0];",
        "  const tmpl = ERRORS[code].messages[lang] ?? ERRORS[code].messages['en'];",
        "  return tmpl.replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? `{${k}}`);",
        "}",
        "",
        "export interface ErrorEnvelope {",
        "  error: { code: ErrorCode; message: string; trace_id?: string | null; retry_after?: number | null };",
        "}",
        "export function envelope(code: ErrorCode, opts: { traceId?: string; locale?: string;",
        "    message?: string; retryAfter?: number; vars?: Record<string,string> } = {}): ErrorEnvelope {",
        "  return { error: { code, message: opts.message ?? message(code, opts.locale, opts.vars),",
        "                    trace_id: opts.traceId ?? null, retry_after: opts.retryAfter ?? null } };",
        "}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    errors = load()
    PY_OUT.parent.mkdir(parents=True, exist_ok=True)
    TS_OUT.parent.mkdir(parents=True, exist_ok=True)
    PY_OUT.write_text(gen_python(errors), encoding="utf-8")
    TS_OUT.write_text(gen_typescript(errors), encoding="utf-8")
    print(f"Generated {len(errors)} error codes:")
    print(f"  {PY_OUT.relative_to(HERE.parent.parent)}")
    print(f"  {TS_OUT.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
