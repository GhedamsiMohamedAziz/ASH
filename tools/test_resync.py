import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from resync_schedules import ScheduleClient, resync

JOBS = [
    {"id": "job_1", "status": "active", "cron": "0 9 * * 1"},
    {"id": "job_2", "status": "paused", "cron": "0 8 * * *"},
    {"id": "job_3", "status": "active", "cron": "*/30 * * * *", "timezone": "Europe/Paris"},
]

def test_resync_creates_active_only():
    c = ScheduleClient()
    r = resync(JOBS, c)
    assert r["created"] == 2 and r["updated"] == 0  # job_2 paused → skipped

def test_resync_is_idempotent():
    c = ScheduleClient()
    resync(JOBS, c)
    r = resync(JOBS, c)  # DR re-run
    assert r["created"] == 0 and r["updated"] == 2  # no duplicates
