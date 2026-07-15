package orchestrator

// lifecycle.go holds the PURE, deterministic core of the sandbox lifecycle and
// scheduler (instructions.md §3.7 / §10.4): a table-driven state machine, the
// pool-warmer sizing formula, the bin-packing placement score, and the two-class
// priority comparator. Everything here is side-effect free and unit-testable —
// no containers, no clocks, no I/O. The stateful wrappers (sandbox.go,
// orchestrator.go) drive these functions.

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// ---------------------------------------------------------------- state machine (§10.1)

// Event drives a lifecycle transition. These are the only inputs the pure state
// machine accepts; anything else is an illegal transition (fail-closed).
type Event string

const (
	EvClaim     Event = "claim"     // COLD→WARMING (provision) and FAILED→COLD (kill + recreate)
	EvActivate  Event = "activate"  // WARMING→ACTIVE (task assigned)
	EvIdleTick  Event = "idle_tick" // ACTIVE→IDLE once IdleAfter elapsed
	EvHibernate Event = "hibernate" // IDLE→HIBERNATED once HibernateAfter elapsed
	EvDestroy   Event = "destroy"   // HIBERNATED→DESTROYED once DestroyAfter elapsed
	EvFail      Event = "fail"      // WARMING/ACTIVE→FAILED (healthcheck KO / incident)
	EvWake      Event = "wake"      // IDLE/HIBERNATED→ACTIVE (new message or cron fire)
)

// Thresholds are the idle/hibernate/destroy/reap timers. They are injectable so
// tests can use small values while production uses the §10.1 defaults.
type Thresholds struct {
	IdleAfter       time.Duration // ACTIVE→IDLE (spec: 10 min)
	HibernateAfter  time.Duration // IDLE→HIBERNATED (spec: 60 min)
	DestroyAfter    time.Duration // HIBERNATED→DESTROYED (spec: 30 days, volume archived to S3)
	FailedReapAfter time.Duration // FAILED→COLD reap delay: recycle (kill + recreate) a stuck sandbox
}

// DefaultThresholds encodes the §10.1 production timers.
var DefaultThresholds = Thresholds{
	IdleAfter:       10 * time.Minute,
	HibernateAfter:  60 * time.Minute,
	DestroyAfter:    30 * 24 * time.Hour,
	FailedReapAfter: 5 * time.Minute,
}

// edge is one legal transition; after (when non-nil) gates the move behind an
// elapsed-time threshold so a timer poll that fires early is a no-op, not a jump.
type edge struct {
	to    State
	after func(Thresholds) time.Duration
}

// lifecycleEdges is the §10.1 state machine as (state, event) → edge. A missing
// entry is an illegal transition. This is the single source of truth for the
// pure machine.
var lifecycleEdges = map[State]map[Event]edge{
	Cold: {EvClaim: {to: Warming}},
	Warming: {
		EvActivate: {to: Active},
		EvFail:     {to: Failed},
	},
	Active: {
		EvIdleTick: {to: Idle, after: func(c Thresholds) time.Duration { return c.IdleAfter }},
		EvFail:     {to: Failed},
	},
	Idle: {
		EvWake:      {to: Active},
		EvHibernate: {to: Hibernated, after: func(c Thresholds) time.Duration { return c.HibernateAfter }},
	},
	Hibernated: {
		EvWake:    {to: Active},
		EvDestroy: {to: Destroyed, after: func(c Thresholds) time.Duration { return c.DestroyAfter }},
	},
	Failed:    {EvClaim: {to: Cold}}, // kill + recreate: recycle to COLD, then EvClaim again to WARMING
	Destroyed: {},                    // terminal
}

// Next is the pure sandbox state transition function (§3.7 / §10.1). Given the
// current state, an event, and how long the sandbox has been idle/dormant, it
// returns the next state. An event the state cannot handle is an illegal
// transition and returns an error (fail-closed). A threshold-gated event whose
// time has not yet elapsed is a valid no-op: it returns the same state with no
// error (a timer poll that is simply not due yet).
func Next(state State, event Event, elapsed time.Duration, cfg Thresholds) (State, error) {
	events, ok := lifecycleEdges[state]
	if !ok {
		return state, fmt.Errorf("orchestrator: unknown state %q", state)
	}
	e, ok := events[event]
	if !ok {
		return state, fmt.Errorf("orchestrator: illegal transition: %s cannot handle %q", state, event)
	}
	if e.after != nil {
		if threshold := e.after(cfg); elapsed < threshold {
			return state, nil // valid event, not yet due — stay put
		}
	}
	return e.to, nil
}

// ---------------------------------------------------------------- pool warmer (§10.4)

// pool_min defaults: 5 during business hours, 2 at night (§10.4). The warm pool
// never drops below these regardless of the arrival-rate estimate.
const (
	BusinessPoolMin = 5
	NightPoolMin    = 2

	businessStartHour = 9  // inclusive
	businessEndHour   = 18 // exclusive
)

// PoolMinForHour returns the floor for the warm pool given the local hour-of-day
// (0–23): business hours get 5, nights get 2 (§10.4).
func PoolMinForHour(hour int) int {
	if hour >= businessStartHour && hour < businessEndHour {
		return BusinessPoolMin
	}
	return NightPoolMin
}

// PoolTarget implements the §10.4 pool-warmer sizing formula, recomputed every
// tick: target = max(pool_min, ceil(λ_p95 × T_cold) + margin), where λ_p95 is the
// p95 arrival rate of newly-active users per minute and tColdMin is the cold-start
// time in minutes (~0.13). margin absorbs the 09:00 burst (cron jitter, §15.6).
func PoolTarget(lambdaP95, tColdMin float64, margin, poolMin int) int {
	computed := int(math.Ceil(lambdaP95*tColdMin)) + margin
	if computed < poolMin {
		return poolMin
	}
	return computed
}

// ---------------------------------------------------------------- placement (§10.4)

// Node is a worker node candidate for bin-packing placement. Reservations are
// fractions in [0,1]; HeavyUsers is the count of historically CPU-heavy users
// (p95 from usage_daily, §10.4) already co-located there — the spread-penalty
// source that keeps greedy users apart.
type Node struct {
	Name        string
	CPUReserved float64
	MemReserved float64
	HeavyUsers  int
}

// spreadPenaltyPerHeavyUser weights each co-located heavy user; the penalty
// saturates at 1 so it can never invert the score's sign contribution beyond -0.2.
const spreadPenaltyPerHeavyUser = 0.5

// SpreadPenalty derives the §10.4 spread penalty from the number of co-located
// heavy users, clamped to [0,1].
func SpreadPenalty(heavyUsers int) float64 {
	p := float64(heavyUsers) * spreadPenaltyPerHeavyUser
	if p > 1 {
		return 1
	}
	if p < 0 {
		return 0
	}
	return p
}

// PlacementScore implements the §10.4 bin-packing score:
// score = 0.5×(1−cpu_reserved) + 0.3×(1−mem_reserved) − 0.2×spread_penalty.
// Higher is better (packs onto the emptiest node while spreading heavy users).
func PlacementScore(n Node) float64 {
	return 0.5*(1-n.CPUReserved) + 0.3*(1-n.MemReserved) - 0.2*SpreadPenalty(n.HeavyUsers)
}

// ChooseNode returns the highest-scoring node (§10.4). Ties break toward the
// first node in input order (deterministic). ok is false when no nodes are given.
func ChooseNode(nodes []Node) (best Node, ok bool) {
	bestScore := math.Inf(-1)
	for _, n := range nodes {
		if s := PlacementScore(n); s > bestScore {
			bestScore, best, ok = s, n, true
		}
	}
	return best, ok
}

// ---------------------------------------------------------------- priority (§10.2)

// DefaultReplanWindow is the §10.2 threshold past which a queued scheduled run is
// flagged for replan (Trigger.dev retry) instead of growing the queue.
const DefaultReplanWindow = 15 * time.Minute

// LessTask is the two-class priority comparator (§10.2): interactive dequeues
// before scheduled; within a class it is FIFO by enqueue time. A scheduled run
// therefore can never make an interactive turn wait.
func LessTask(a, b *Task) bool {
	if a.Priority != b.Priority {
		return a.Priority < b.Priority
	}
	return a.enqueuedAt.Before(b.enqueuedAt)
}

// NeedsReplan reports whether a queued scheduled task has waited past the window
// and should be signalled for replan (§10.2). It returns a signal only — it never
// reschedules. Interactive tasks are never flagged.
func NeedsReplan(t *Task, now time.Time, window time.Duration) bool {
	return t.Priority == Scheduled && now.Sub(t.enqueuedAt) > window
}

// PriorityQueue is a small ordered dispatch queue keeping interactive tasks ahead
// of scheduled ones (§10.2). Pop always returns the highest-priority waiting task.
//
// It is a standalone, self-contained reference implementation of the §10.2 ordering
// (proved by TestPriorityQueueDequeueOrder); the running Orchestrator sorts its
// per-org o.queues slices directly via the same LessTask comparator, so the two can
// never diverge on ordering. PriorityQueue is intentionally not wired into the
// runtime — it exists as the canonical, testable ordering spec.
type PriorityQueue struct{ items []*Task }

// Len reports the number of queued tasks.
func (pq *PriorityQueue) Len() int { return len(pq.items) }

// Push inserts a task, keeping the queue ordered by LessTask (stable within class).
func (pq *PriorityQueue) Push(t *Task) {
	pq.items = append(pq.items, t)
	sort.SliceStable(pq.items, func(i, j int) bool { return LessTask(pq.items[i], pq.items[j]) })
}

// Pop removes and returns the highest-priority task, or nil when empty.
func (pq *PriorityQueue) Pop() *Task {
	if len(pq.items) == 0 {
		return nil
	}
	t := pq.items[0]
	pq.items = pq.items[1:]
	return t
}
