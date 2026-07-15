package orchestrator

import (
	"testing"
	"time"
)

// ---------------------------------------------------------------- state machine (§10.1)
func TestLegalTransitions(t *testing.T) {
	sb := NewSandbox("usr_1", "org_1")
	if sb.State() != Cold {
		t.Fatalf("want COLD, got %s", sb.State())
	}
	for _, next := range []State{Warming, Active, Idle, Hibernated} {
		if err := sb.To(next); err != nil {
			t.Fatalf("legal transition failed: %v", err)
		}
	}
}

func TestIllegalTransitionRejected(t *testing.T) {
	sb := NewSandbox("usr_1", "org_1")
	if err := sb.To(Active); err == nil { // COLD -> ACTIVE is illegal (must WARM first)
		t.Fatal("expected illegal transition to be rejected")
	}
}

func TestHealthcheckFailsAfterThree(t *testing.T) {
	sb := NewSandbox("usr_1", "org_1")
	_ = sb.To(Warming)
	_ = sb.To(Active)
	sb.Healthcheck(false)
	sb.Healthcheck(false)
	if sb.State() == Failed {
		t.Fatal("should not fail before 3 failures")
	}
	sb.Healthcheck(false)
	if sb.State() != Failed {
		t.Fatalf("want FAILED after 3 failures, got %s", sb.State())
	}
}

func TestSweepIdleThenHibernate(t *testing.T) {
	base := time.Date(2026, 7, 13, 9, 0, 0, 0, time.UTC)
	clockNow = func() time.Time { return base }
	defer func() { clockNow = time.Now }()

	sb := NewSandbox("usr_1", "org_1")
	_ = sb.To(Warming)
	_ = sb.To(Active)

	sb.Sweep(base.Add(5 * time.Minute))
	if sb.State() != Active {
		t.Fatalf("should stay ACTIVE at 5min, got %s", sb.State())
	}
	sb.Sweep(base.Add(11 * time.Minute))
	if sb.State() != Idle {
		t.Fatalf("want IDLE after 10min, got %s", sb.State())
	}
	sb.Sweep(base.Add(70 * time.Minute))
	if sb.State() != Hibernated {
		t.Fatalf("want HIBERNATED after 60min, got %s", sb.State())
	}
}

func TestTouchWakesIdle(t *testing.T) {
	sb := NewSandbox("usr_1", "org_1")
	_ = sb.To(Warming)
	_ = sb.To(Active)
	_ = sb.To(Idle)
	if err := sb.Touch(); err != nil {
		t.Fatalf("touch failed: %v", err)
	}
	if sb.State() != Active {
		t.Fatalf("touch should wake IDLE -> ACTIVE, got %s", sb.State())
	}
}

// ---------------------------------------------------------------- scheduling (§10.2)
func TestWarmPoolAssignsFast(t *testing.T) {
	o := New(10, 2)
	sb, err := o.Submit(&Task{TaskID: "t1", UserID: "usr_1", OrgID: "org_1", Priority: Interactive})
	if err != nil || sb == nil {
		t.Fatalf("submit failed: %v", err)
	}
	if sb.UserID != "usr_1" || sb.State() != Active {
		t.Fatalf("warm sandbox not assigned+active: %+v", sb.State())
	}
}

func TestOrgCapacityQueuesOverflow(t *testing.T) {
	o := New(1, 0) // 1 sandbox per org
	if _, err := o.Submit(&Task{TaskID: "t1", UserID: "usr_1", OrgID: "org_1"}); err != nil {
		t.Fatalf("first submit should succeed: %v", err)
	}
	_, err := o.Submit(&Task{TaskID: "t2", UserID: "usr_2", OrgID: "org_1"})
	if err != ErrOrgAtCapacity {
		t.Fatalf("second submit should hit capacity, got %v", err)
	}
}

func TestInteractivePreemptsScheduledInQueue(t *testing.T) {
	o := New(1, 0)
	_, _ = o.Submit(&Task{TaskID: "busy", UserID: "usr_0", OrgID: "org_1"})
	// queue a scheduled then an interactive; interactive must come out first
	_, _ = o.Submit(&Task{TaskID: "cron", UserID: "usr_c", OrgID: "org_1", Priority: Scheduled})
	_, _ = o.Submit(&Task{TaskID: "human", UserID: "usr_h", OrgID: "org_1", Priority: Interactive})
	next := o.Release("usr_0")
	if next == nil || next.TaskID != "human" {
		t.Fatalf("interactive should preempt scheduled, got %+v", next)
	}
}

func TestStaleScheduledReplanned(t *testing.T) {
	base := time.Date(2026, 7, 13, 9, 0, 0, 0, time.UTC)
	clockNow = func() time.Time { return base }
	defer func() { clockNow = time.Now }()

	o := New(1, 0)
	_, _ = o.Submit(&Task{TaskID: "busy", UserID: "usr_0", OrgID: "org_1"})
	_, _ = o.Submit(&Task{TaskID: "cron", UserID: "usr_c", OrgID: "org_1", Priority: Scheduled})

	stale := o.StaleScheduled(base.Add(16 * time.Minute))
	if len(stale) != 1 || stale[0].TaskID != "cron" {
		t.Fatalf("scheduled task > 15min should be replanned, got %+v", stale)
	}
}

func TestBudgetEnforcement(t *testing.T) {
	task := &Task{MaxSeconds: 60, MaxCostUSD: 0.10}
	if task.BudgetExceeded(30, 0.05) {
		t.Fatal("within budget should not trip")
	}
	if !task.BudgetExceeded(61, 0.05) {
		t.Fatal("over time budget should trip")
	}
	if !task.BudgetExceeded(30, 0.11) {
		t.Fatal("over cost budget should trip")
	}
}
