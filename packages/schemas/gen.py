#!/usr/bin/env python3
"""
Codegen for the event contracts (AX-002, instructions.md §7.4, Principle #6).

Generates TypeScript interfaces + Python TypedDicts from the JSON Schemas so no
service hand-writes the contract twice. Deliberately a small, dependency-free
generator (a real pipeline would use quicktype/datamodel-codegen); it covers the
object/array/enum/$ref-free shapes these schemas use.

Run:  python3 packages/schemas/gen.py
"""

from __future__ import annotations

import json
import keyword
from pathlib import Path

HERE = Path(__file__).resolve().parent
TS_OUT = HERE / "dist" / "typescript" / "events.ts"
PY_OUT = HERE / "dist" / "python" / "events.py"

SCHEMAS = [
    ("InboundMessage", "inbound_message.schema.json"),
    ("AgentEvent", "agent_event.schema.json"),
    ("AgentTask", "agent_task.schema.json"),
    ("ScheduledJob", "scheduled_job.schema.json"),
]

_TS_SCALAR = {"string": "string", "integer": "number", "number": "number", "boolean": "boolean"}
_PY_SCALAR = {"string": "str", "integer": "int", "number": "float", "boolean": "bool"}


def _ts_type(spec: dict) -> str:
    if "enum" in spec:
        return " | ".join(json.dumps(v) for v in spec["enum"])
    t = spec.get("type")
    if isinstance(t, list):  # nullable union e.g. ["number","null"]
        return " | ".join(_TS_SCALAR.get(x, "unknown") if x != "null" else "null" for x in t)
    if t == "array":
        return f"{_ts_type(spec.get('items', {}))}[]"
    if t == "object":
        return "Record<string, unknown>"
    return _TS_SCALAR.get(t, "unknown")


def _py_type(spec: dict) -> str:
    if "enum" in spec:
        return "str"
    t = spec.get("type")
    if isinstance(t, list):
        inner = [_PY_SCALAR.get(x, "object") for x in t if x != "null"]
        base = inner[0] if inner else "object"
        return f"{base} | None" if "null" in t else base
    if t == "array":
        return f"list[{_py_type(spec.get('items', {}))}]"
    if t == "object":
        return "dict"
    return _PY_SCALAR.get(t, "object")


def _fields(schema: dict):
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    for name, spec in props.items():
        yield name, spec, name in required


def gen_ts() -> str:
    out = ["// Generated from *.schema.json — do not edit (AX-002). Source: §7.4.", ""]
    for title, fname in SCHEMAS:
        schema = json.loads((HERE / fname).read_text())
        out.append(f"export interface {title} {{")
        for name, spec, req in _fields(schema):
            out.append(f"  {name}{'' if req else '?'}: {_ts_type(spec)};")
        out.append("}")
        out.append("")
    return "\n".join(out)


def gen_py() -> str:
    out = ['"""Generated from *.schema.json — do not edit (AX-002). Source: §7.4."""',
           "from __future__ import annotations", "from typing import TypedDict", ""]
    for title, fname in SCHEMAS:
        schema = json.loads((HERE / fname).read_text())
        fields = list(_fields(schema))
        # A field named like a Python keyword (e.g. AgentTask.`class`) can't be a
        # class attribute → use the functional TypedDict form for the whole schema.
        # total=False so tolerant readers accept partial/additive payloads (§7.4).
        if any(keyword.iskeyword(name) for name, _, _ in fields):
            items = ", ".join(f'"{name}": {_py_type(spec)}' for name, spec, _ in fields)
            out.append(f'{title} = TypedDict("{title}", {{{items}}}, total=False)')
        else:
            out.append(f"class {title}(TypedDict, total=False):")
            out += [f"    {name}: {_py_type(spec)}" for name, spec, _ in fields] or ["    pass"]
        out.append("")
    return "\n".join(out)


def main() -> None:
    TS_OUT.parent.mkdir(parents=True, exist_ok=True)
    PY_OUT.parent.mkdir(parents=True, exist_ok=True)
    TS_OUT.write_text(gen_ts(), encoding="utf-8")
    PY_OUT.write_text(gen_py(), encoding="utf-8")
    print(f"Generated {len(SCHEMAS)} contracts →")
    print(f"  {TS_OUT.relative_to(HERE.parent.parent)}")
    print(f"  {PY_OUT.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
