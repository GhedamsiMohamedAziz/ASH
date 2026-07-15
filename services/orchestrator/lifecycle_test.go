package orchestrator

import (
	"math"
	"testing"
	"time"
)

// ---------------------------------------------------------------- pure state machine (§3.7)

// small, injectable thresholds so tests read as seconds, not minutes/days.
var testThresholds = Thresholds{
	IdleAfter:      10 * time.Second,
	HibernateAfter: 60 * time.Second,
	DestroyAfter:   30 * time.Second,
}

func TestNextTransitions(t *testing.T) {
	cases := []struct {
		name    string
		state   State
		event   Event
		elapsed time.Duration
		want    State
		wantErr bool
	}{
		// legal, un-gated
		{"cold claim warms", Cold, EvClaim, 0, Warming, false},
		{"warming activates", Warming, EvActivate, 0, Active, false},
		{"warming fails", Warming, EvFail, 0, Failed, false},
		{"active fails", Active, EvFail, 0, Failed, false},
		{"failed recycles to cold", Failed, EvClaim, 0, Cold, false},
		{"idle wakes to active", Idle, EvWake, 0, Active, false},
		{"hibernated wakes to active", Hibernated, EvWake, 0, Active, false},

		// legal, threshold-gated — due
		{"active idles after threshold", Active, EvIdleTick, 11 * time.Second, Idle, false},
		{"idle hibernates after threshold", Idle, EvHibernate, 61 * time.Second, Hibernated, false},
		{"hibernated destroyed after threshold", Hibernated, EvDestroy, 31 * time.Second, Destroyed, false},

		// legal, threshold-gated — not yet due → no-op, no error
		{"active stays active before idle threshold", Active, EvIdleTick, 5 * time.Second, Active, false},
		{"idle stays idle before hibernate threshold", Idle, EvHibernate, 5 * time.Second, Idle, false},
		{"hibernated stays before destroy threshold", Hibernated, EvDestroy, 5 * time.Second, Hibernated, false},

		// illegal transitions → error, state unchanged (fail-closed)
		{"cold cannot activate", Cold, EvActivate, 0, Cold, true},
		{"active cannot wake", Active, EvWake, 0, Active, true},
		{"idle cannot activate directly", Idle, EvActivate, 0, Idle, true},
		{"warming cannot idle", Warming, EvIdleTick, time.Hour, Warming, true},
		{"destroyed is terminal", Destroyed, EvWake, 0, Destroyed, true},
		{"hibernated cannot fail", Hibernated, EvFail, 0, Hibernated, true},
		{"unknown event rejected", Active, Event("bogus"), 0, Active, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Next(c.state, c.event, c.elapsed, testThresholds)
			if (err != nil) != c.wantErr {
				t.Fatalf("err=%v, wantErr=%v", err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("Next(%s,%s,%v) = %s, want %s", c.state, c.event, c.elapsed, got, c.want)
			}
		})
	}
}

// TestNextFullLifecycle walks a sandbox COLD→…→DESTROYED plus the FAILED recovery
// path through the pure machine end to end.
func TestNextFullLifecycle(t *testing.T) {
	steps := []struct {
		event   Event
		elapsed time.Duration
		want    State
	}{
		{EvClaim, 0, Warming},
		{EvActivate, 0, Active},
		{EvIdleTick, 11 * time.Second, Idle},
		{EvWake, 0, Active},              // IDLE→ACTIVE on wake
		{EvIdleTick, 11 * time.Second, Idle},
		{EvHibernate, 61 * time.Second, Hibernated},
		{EvDestroy, 31 * time.Second, Destroyed},
	}
	state := Cold
	for i, s := range steps {
		next, err := Next(state, s.event, s.elapsed, testThresholds)
		if err != nil {
			t.Fatalf("step %d %s: unexpected err %v", i, s.event, err)
		}
		if next != s.want {
			t.Fatalf("step %d %s: got %s want %s", i, s.event, next, s.want)
		}
		state = next
	}

	// FAILED → (kill) → COLD → WARMING recovery loop.
	state = Active
	state, _ = Next(state, EvFail, 0, testThresholds)
	if state != Failed {
		t.Fatalf("expected FAILED, got %s", state)
	}
	state, _ = Next(state, EvClaim, 0, testThresholds) // kill + recreate → COLD
	if state != Cold {
		t.Fatalf("expected COLD after recreate, got %s", state)
	}
	state, _ = Next(state, EvClaim, 0, testThresholds) // provision again
	if state != Warming {
		t.Fatalf("expected WARMING after re-claim, got %s", state)
	}
}

// ---------------------------------------------------------------- pool warmer (§10.4)

func TestPoolTarget(t *testing.T) {
	cases := []struct {
		name      string
		lambdaP95 float64
		tColdMin  float64
		margin    int
		poolMin   int
		want      int
	}{
		{"floor dominates when demand tiny", 1, 0.13, 1, 5, 5},   // ceil(0.13)=1, +1=2, floor 5
		{"formula dominates over floor", 40, 0.13, 2, 5, 8},      // ceil(5.2)=6, +2=8 > 5
		{"night floor", 0, 0.13, 0, 2, 2},                        // ceil(0)=0 → floor 2
		{"exact ceil boundary", 10, 0.1, 0, 0, 1},                // ceil(1.0)=1
		{"margin absorbs 9am burst", 30, 0.13, 5, 5, 9},          // ceil(3.9)=4, +5=9
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := PoolTarget(c.lambdaP95, c.tColdMin, c.margin, c.poolMin); got != c.want {
				t.Fatalf("PoolTarget = %d, want %d", got, c.want)
			}
		})
	}
}

func TestPoolMinForHour(t *testing.T) {
	cases := []struct {
		hour int
		want int
	}{
		{0, NightPoolMin}, {8, NightPoolMin}, {9, BusinessPoolMin},
		{13, BusinessPoolMin}, {17, BusinessPoolMin}, {18, NightPoolMin}, {23, NightPoolMin},
	}
	for _, c := range cases {
		if got := PoolMinForHour(c.hour); got != c.want {
			t.Fatalf("PoolMinForHour(%d) = %d, want %d", c.hour, got, c.want)
		}
	}
}

// ---------------------------------------------------------------- placement (§10.4)

func TestPlacementScoreFormula(t *testing.T) {
	// empty node: 0.5*1 + 0.3*1 - 0 = 0.8
	if got := PlacementScore(Node{}); math.Abs(got-0.8) > 1e-9 {
		t.Fatalf("empty node score = %v, want 0.8", got)
	}
	// half-full cpu+mem, no heavy user: 0.5*0.5 + 0.3*0.5 = 0.4
	if got := PlacementScore(Node{CPUReserved: 0.5, MemReserved: 0.5}); math.Abs(got-0.4) > 1e-9 {
		t.Fatalf("half node score = %v, want 0.4", got)
	}
}

func TestChooseNodeBestScore(t *testing.T) {
	nodes := []Node{
		{Name: "busy", CPUReserved: 0.9, MemReserved: 0.9},
		{Name: "empty", CPUReserved: 0.1, MemReserved: 0.1},
		{Name: "mid", CPUReserved: 0.5, MemReserved: 0.5},
	}
	best, ok := ChooseNode(nodes)
	if !ok || best.Name != "empty" {
		t.Fatalf("expected 'empty' to win, got %q (ok=%v)", best.Name, ok)
	}
	if _, ok := ChooseNode(nil); ok {
		t.Fatal("empty node list must return ok=false")
	}
}

func TestChooseNodeTieBreakFirstWins(t *testing.T) {
	nodes := []Node{
		{Name: "a", CPUReserved: 0.3, MemReserved: 0.3},
		{Name: "b", CPUReserved: 0.3, MemReserved: 0.3}, // identical score
	}
	best, _ := ChooseNode(nodes)
	if best.Name != "a" {
		t.Fatalf("tie must break toward first node, got %q", best.Name)
	}
}

func TestSpreadPenaltyDemotesHeavyColocation(t *testing.T) {
	// Two otherwise-identical nodes; the one already hosting a heavy user must
	// score lower and lose placement (§10.4 spread penalty).
	clean := Node{Name: "clean", CPUReserved: 0.4, MemReserved: 0.4}
	heavy := Node{Name: "heavy", CPUReserved: 0.4, MemReserved: 0.4, HeavyUsers: 1}

	if PlacementScore(heavy) >= PlacementScore(clean) {
		t.Fatalf("heavy-colocated node should score lower: heavy=%v clean=%v",
			PlacementScore(heavy), PlacementScore(clean))
	}
	best, _ := ChooseNode([]Node{heavy, clean}) // heavy listed first, must still lose
	if best.Name != "clean" {
		t.Fatalf("spread penalty should send the sandbox to 'clean', got %q", best.Name)
	}
	// penalty saturates at 1.
	if SpreadPenalty(10) != 1 {
		t.Fatalf("spread penalty must clamp to 1, got %v", SpreadPenalty(10))
	}
}

// ---------------------------------------------------------------- priority (§10.2)

func TestLessTaskInteractiveFirst(t *testing.T) {
	base := time.Date(2026, 7, 15, 9, 0, 0, 0, time.UTC)
	// interactive enqueued LATER still outranks an earlier scheduled run.
	inter := &Task{TaskID: "human", Priority: Interactive, enqueuedAt: base.Add(time.Minute)}
	sched := &Task{TaskID: "cron", Priority: Scheduled, enqueuedAt: base}
	if !LessTask(inter, sched) {
		t.Fatal("interactive must dequeue before scheduled regardless of enqueue time")
	}
	if LessTask(sched, inter) {
		t.Fatal("scheduled must never precede interactive")
	}
	// FIFO within the same class.
	early := &Task{TaskID: "e", Priority: Interactive, enqueuedAt: base}
	late := &Task{TaskID: "l", Priority: Interactive, enqueuedAt: base.Add(time.Second)}
	if !LessTask(early, late) {
		t.Fatal("within a class, earlier enqueue must come first (FIFO)")
	}
}

func TestPriorityQueueDequeueOrder(t *testing.T) {
	base := time.Date(2026, 7, 15, 9, 0, 0, 0, time.UTC)
	pq := &PriorityQueue{}
	pq.Push(&Task{TaskID: "cron1", Priority: Scheduled, enqueuedAt: base})
	pq.Push(&Task{TaskID: "human1", Priority: Interactive, enqueuedAt: base.Add(2 * time.Minute)})
	pq.Push(&Task{TaskID: "human2", Priority: Interactive, enqueuedAt: base.Add(time.Minute)})
	pq.Push(&Task{TaskID: "cron2", Priority: Scheduled, enqueuedAt: base.Add(30 * time.Second)})

	want := []string{"human2", "human1", "cron1", "cron2"} // interactive FIFO, then scheduled FIFO
	for i, id := range want {
		got := pq.Pop()
		if got == nil || got.TaskID != id {
			t.Fatalf("pop %d = %+v, want %s", i, got, id)
		}
	}
	if pq.Pop() != nil || pq.Len() != 0 {
		t.Fatal("queue should be drained")
	}
}

func TestNeedsReplanFlag(t *testing.T) {
	base := time.Date(2026, 7, 15, 9, 0, 0, 0, time.UTC)
	sched := &Task{TaskID: "cron", Priority: Scheduled, enqueuedAt: base}
	inter := &Task{TaskID: "human", Priority: Interactive, enqueuedAt: base}

	if NeedsReplan(sched, base.Add(14*time.Minute), DefaultReplanWindow) {
		t.Fatal("scheduled task under 15min must not be flagged")
	}
	if !NeedsReplan(sched, base.Add(16*time.Minute), DefaultReplanWindow) {
		t.Fatal("scheduled task over 15min must be flagged for replan")
	}
	if NeedsReplan(inter, base.Add(2*time.Hour), DefaultReplanWindow) {
		t.Fatal("interactive tasks must never be flagged for replan")
	}
}
