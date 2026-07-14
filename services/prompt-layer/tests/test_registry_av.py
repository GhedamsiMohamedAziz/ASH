import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest
from app.prompt_registry import Feedback, PromptRegistry
from app.antivirus import EICAR, AttachmentRejected, guard_attachment, scan

# --- prompt registry (AX-101) ---
def test_register_and_active():
    r = PromptRegistry()
    r.register("system", "v1 text")
    v2 = r.register("system", "v2 text")
    assert r.active("system").version == 2 == v2.version

def test_pin_rollback():
    r = PromptRegistry(); r.register("s","v1"); r.register("s","v2")
    r.pin("s", 1)
    assert r.active("s").version == 1

def test_regression_signal():
    r = PromptRegistry()
    r.register("s","v1"); r.register("s","v2")  # active=2
    # v1: 1 down / 4 = 0.25 ; v2: 3 down / 4 = 0.75 → regressed
    for v,sig in [(1,"up"),(1,"up"),(1,"up"),(1,"down"),(2,"down"),(2,"down"),(2,"down"),(2,"up")]:
        r.record_feedback(Feedback("s", v, sig))
    sig = r.regression_signal("s")
    assert sig["regressed"] is True and sig["current_bad_rate"] > sig["previous_bad_rate"]

def test_no_comparison_for_first_version():
    r = PromptRegistry(); r.register("s","v1")
    assert r.regression_signal("s")["comparable"] is False

# --- antivirus (AX-099) ---
def test_clean_file_passes():
    assert scan("hello world normal content").clean
    guard_attachment("doc.txt", b"safe content")

def test_eicar_detected():
    r = scan(EICAR)
    assert r.clean is False and r.signature == "EICAR"

def test_infected_attachment_rejected():
    with pytest.raises(AttachmentRejected):
        guard_attachment("virus.txt", EICAR.encode())
