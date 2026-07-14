import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from slo_check import check
GREEN = {"availability":0.9995,"first_token_p95_s":4.2,"cron_failure_rate_1h":0.01,
         "cron_fire_delay_p95_s":43,"cache_hit_ratio":0.78}
def test_all_green_meets_slo():
    assert check(GREEN)["met"] is True
def test_availability_below_999_fails():
    m=dict(GREEN, availability=0.998); r=check(m)
    assert r["met"] is False and "availability" in r["failing"]
def test_slow_first_token_fails():
    assert check(dict(GREEN, first_token_p95_s=35))["met"] is False
def test_missing_metric_fails_closed():
    m=dict(GREEN); del m["cache_hit_ratio"]
    assert check(m)["met"] is False
