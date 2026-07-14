import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.job_memory import JobMemory
from app.workspace import VolumeRegistry, Workspace

def test_job_memory_dedups():
    m = JobMemory()
    assert m.is_new("SENTRY-123") is True
    assert m.is_new("SENTRY-123") is False  # already reported
    assert m.is_new("SENTRY-999") is True

def test_job_memory_json_roundtrip():
    m = JobMemory(); m.is_new("a"); m.mark_no_op(True)
    back = JobMemory.from_json(m.to_json())
    assert back.is_new("a") is False and back.last_no_op is True

def test_workspace_persists_across_restart():
    ws = Workspace("usr_1", "vol_1")
    ws.write("NOTES.md", "deploy via argocd")
    restarted = ws.survives_restart()
    assert restarted.read("NOTES.md") == "deploy via argocd"

def test_volume_reattaches_same_user():
    reg = VolumeRegistry()
    a = reg.attach("usr_1"); a.write("f", "x")
    b = reg.attach("usr_1")  # sandbox killed + recreated
    assert b.read("f") == "x" and b.volume_id == "vol_usr_1"
