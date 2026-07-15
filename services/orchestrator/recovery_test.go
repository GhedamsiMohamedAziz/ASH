package orchestrator

import "testing"

import "time"

// activeFor counts the live sandboxes an org actually holds — the ground truth the
// activeByOrg counter must mirror for the maxPerOrg invariant to hold.
func activeFor(o *Orchestrator, org string) int {
	n := 0
	for _, sb := range o.sandboxes {
		if sb.OrgID == org {
			n++
		}
	}
	return n
}

// TestFailedSandboxRecoversAndIsReaped proves a sandbox that fails its healthcheck is
// no longer a permanent wedge: from FAILED it can EITHER recover on a passing probe OR
// be reaped by Sweep — both routed through the pure Next() machine, both exiting FAILED.
func TestFailedSandboxRecoversAndIsReaped(t *testing.T) {
	base := time.Date(2026, 7, 15, 9, 0, 0, 0, time.UTC)

	cases := []struct {
		name string
		// from is the state at which the 3 failing probes land (must have an EvFail edge).
		from State
		// recover, when set, drives the exit; otherwise the FAILED sandbox is reaped by Sweep.
		recover func(sb *Sandbox) State
		want    State
	}{
		{
			name:    "active fails then recovers on passing probe",
			from:    Active,
			recover: func(sb *Sandbox) State { return sb.Healthcheck(true) }, // FAILED→COLD (requeue)
			want:    Cold,
		},
		{
			name:    "warming fails then recovers on passing probe",
			from:    Warming,
			recover: func(sb *Sandbox) State { return sb.Healthcheck(true) },
			want:    Cold,
		},
		{
			name: "failed sandbox reaped by sweep after reap delay",
			from: Active,
			recover: func(sb *Sandbox) State {
				sb.Sweep(base.Add(DefaultThresholds.FailedReapAfter + time.Minute)) // long-FAILED → COLD
				return sb.State()
			},
			want: Cold,
		},
		{
			name: "failed sandbox not reaped before reap delay",
			from: Active,
			recover: func(sb *Sandbox) State {
				sb.Sweep(base.Add(DefaultThresholds.FailedReapAfter - time.Minute)) // too soon
				return sb.State()
			},
			want: Failed,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			clockNow = func() time.Time { return base }
			defer func() { clockNow = time.Now }()

			sb := NewSandbox("usr_1", "org_1")
			// Walk COLD→...→from through the guard.
			switch c.from {
			case Warming:
				_ = sb.To(Warming)
			case Active:
				_ = sb.To(Warming)
				_ = sb.To(Active)
			}

			// Three consecutive failing probes must land in FAILED (never the old ERROR
			// dead-end), and must reach it through a legal edge.
			sb.Healthcheck(false)
			sb.Healthcheck(false)
			if got := sb.Healthcheck(false); got != Failed {
				t.Fatalf("3 failing probes from %s: got %s, want FAILED", c.from, got)
			}

			if got := c.recover(sb); got != c.want {
				t.Fatalf("exit from FAILED: got %s, want %s", got, c.want)
			}
		})
	}
}

// TestHealthcheckOnlyFailsStatesWithFailEdge proves the guarded probe cannot force a
// forbidden transition (e.g. the old raw WARMING→ERROR): a probe against a state with
// no EvFail edge is a no-op, not a jump.
func TestHealthcheckNoOpOnStatesWithoutFailEdge(t *testing.T) {
	for _, from := range []State{Idle, Hibernated} {
		sb := NewSandbox("usr_1", "org_1")
		_ = sb.To(Warming)
		_ = sb.To(Active)
		if from == Idle {
			_ = sb.To(Idle)
		} else {
			_ = sb.To(Idle)
			_ = sb.To(Hibernated)
		}
		sb.Healthcheck(false)
		sb.Healthcheck(false)
		if got := sb.Healthcheck(false); got != from {
			t.Fatalf("probe against %s must be a guarded no-op, got %s", from, got)
		}
	}
}

// TestReleaseKeepsActiveByOrgExact proves Release + re-assign keeps activeByOrg an
// exact mirror of live sandboxes at the maxPerOrg boundary — even in the case the
// review flagged (the next queued task belongs to a user who already holds a sandbox,
// so assignLocked no-ops) — and that Submit never admits work past the cap afterward.
func TestReleaseKeepsActiveByOrgExact(t *testing.T) {
	const org = "org_1"
	o := New(2, 0) // cap 2, no warm pool

	// Fill the org to capacity: U1 and U2 each hold a sandbox.
	if _, err := o.Submit(&Task{TaskID: "t1", UserID: "U1", OrgID: org}); err != nil {
		t.Fatalf("submit U1: %v", err)
	}
	if _, err := o.Submit(&Task{TaskID: "t2", UserID: "U2", OrgID: org}); err != nil {
		t.Fatalf("submit U2: %v", err)
	}
	// Two queued tasks, both for U3 (who has no sandbox yet).
	if _, err := o.Submit(&Task{TaskID: "t3", UserID: "U3", OrgID: org}); err != ErrOrgAtCapacity {
		t.Fatalf("submit t3 should queue at capacity, got %v", err)
	}
	if _, err := o.Submit(&Task{TaskID: "t4", UserID: "U3", OrgID: org}); err != ErrOrgAtCapacity {
		t.Fatalf("submit t4 should queue at capacity, got %v", err)
	}

	assertExact := func(label string) {
		t.Helper()
		if o.activeByOrg[org] != activeFor(o, org) {
			t.Fatalf("%s: activeByOrg=%d but live sandboxes=%d", label, o.activeByOrg[org], activeFor(o, org))
		}
		if activeFor(o, org) > o.maxPerOrg {
			t.Fatalf("%s: live sandboxes=%d exceeds maxPerOrg=%d", label, activeFor(o, org), o.maxPerOrg)
		}
	}
	assertExact("after fill")

	// Release U1 → next=t3 assigns U3 a sandbox. U3 now holds a sandbox AND still has t4 queued.
	if next := o.Release("U1"); next == nil || next.TaskID != "t3" {
		t.Fatalf("release U1 should dispatch t3, got %+v", next)
	}
	assertExact("after release U1")

	// Release U2 → next=t4, but U3 already holds a sandbox so assignLocked no-ops.
	// This is the exact under-count trap: the count must still equal live sandboxes.
	if next := o.Release("U2"); next == nil || next.TaskID != "t4" {
		t.Fatalf("release U2 should dispatch t4, got %+v", next)
	}
	assertExact("after release U2")

	// Only U3 remains live (1 sandbox). The org has one free slot: exactly one Submit
	// may be admitted, the next must hit capacity — proving no over-admission from drift.
	if _, err := o.Submit(&Task{TaskID: "t5", UserID: "U4", OrgID: org}); err != nil {
		t.Fatalf("one free slot should admit U4, got %v", err)
	}
	assertExact("after admit U4")
	if _, err := o.Submit(&Task{TaskID: "t6", UserID: "U5", OrgID: org}); err != ErrOrgAtCapacity {
		t.Fatalf("org back at capacity must reject U5, got %v", err)
	}
	assertExact("after reject U5")
}
