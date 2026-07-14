import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import run, GOLDEN, ADVERSARIAL

def test_all_golden_and_adversarial_pass():
    r = run()
    assert r["gate"] == "PASS", f"eval gate failed: {r['failures']}"
    assert r["passed"] == r["total"]

def test_corpus_nonempty():
    assert len(GOLDEN) >= 4 and len(ADVERSARIAL) >= 5
