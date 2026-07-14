"""AX-002 schema + codegen tests: valid schemas, generated modules, tolerant reader."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMAS = ["inbound_message.schema.json", "agent_event.schema.json",
           "agent_task.schema.json", "scheduled_job.schema.json"]


def test_all_schemas_valid_json():
    for f in SCHEMAS:
        schema = json.loads((HERE / f).read_text())
        assert schema["$schema"].startswith("https://json-schema.org")
        assert "title" in schema and "properties" in schema


def test_codegen_emits_both_targets():
    subprocess.run([sys.executable, str(HERE / "gen.py")], check=True)
    ts = (HERE / "dist" / "typescript" / "events.ts").read_text()
    py = (HERE / "dist" / "python" / "events.py").read_text()
    for title in ("InboundMessage", "AgentEvent", "AgentTask", "ScheduledJob"):
        assert f"interface {title}" in ts
        # either class-form or functional-form (keyword field names force functional)
        assert (f"class {title}" in py) or (f'{title} = TypedDict("{title}"' in py)


def test_generated_python_typeddicts_importable():
    subprocess.run([sys.executable, str(HERE / "gen.py")], check=True)
    path = HERE / "dist" / "python" / "events.py"
    spec = importlib.util.spec_from_file_location("events", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    # a well-formed InboundMessage is accepted (TypedDict is structural)
    msg: mod.InboundMessage = {"schema_version": "1.2", "message_id": "m1",
                               "user_id": "u", "org_id": "o", "channel": "slack",
                               "conversation_id": "c", "text": "hi", "ts": "t"}
    assert msg["channel"] == "slack"


def test_tolerant_reader_additive_field():
    """Additive evolution only (§7.4): an unknown extra field must not break readers."""
    for f in SCHEMAS:
        schema = json.loads((HERE / f).read_text())
        # every schema allows extra properties (tolerant reader)
        assert schema.get("additionalProperties", True) is not False, f


def test_required_fields_present_in_inbound():
    schema = json.loads((HERE / "inbound_message.schema.json").read_text())
    req = set(schema["required"])
    assert {"schema_version", "message_id", "user_id", "org_id", "channel",
            "conversation_id", "text", "ts"} <= req
