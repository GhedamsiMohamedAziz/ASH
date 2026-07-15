// Package orchestrator implements the sandbox lifecycle + scheduling
// (instructions.md §10, ADR 008 — Go for massive concurrency, low latency).
package orchestrator

import (
	"fmt"
	"sync"
	"time"
)

// State is a sandbox lifecycle state (§10.1).
type State string

const (
	Cold       State = "COLD"
	Warming    State = "WARMING"
	Active     State = "ACTIVE"
	Idle       State = "IDLE"
	Hibernated State = "HIBERNATED"
	Failed     State = "FAILED"
	Destroyed  State = "DESTROYED"
)

// transitions is the from -> allowed-target set used by the guarded To()/Touch()
// path. It is DERIVED from lifecycleEdges (the pure §10.1 machine in lifecycle.go)
// so the stateful wrappers and the pure Next() function are the same single source
// of truth and can never diverge into two contradictory machines.
var transitions = buildTransitions()

// buildTransitions projects lifecycleEdges (state, event → to) down to the
// state → {reachable states} form the guarded To() transition check needs.
func buildTransitions() map[State]map[State]bool {
	t := make(map[State]map[State]bool, len(lifecycleEdges))
	for from, events := range lifecycleEdges {
		targets := make(map[State]bool, len(events))
		for _, e := range events {
			targets[e.to] = true
		}
		t[from] = targets
	}
	return t
}

// Sandbox is one user's isolated OpenCode container (§11). Zero secrets live here;
// the orchestrator only tracks lifecycle + placement, never credentials.
type Sandbox struct {
	UserID     string
	OrgID      string
	Node       string
	VolumeID   string
	state      State
	lastActive time.Time
	failedAt   time.Time // when the sandbox entered FAILED (drives the reap timer)
	failures   int       // consecutive healthcheck failures (§10.2)
	mu         sync.Mutex
}

// NewSandbox creates a COLD sandbox record.
func NewSandbox(userID, orgID string) *Sandbox {
	return &Sandbox{UserID: userID, OrgID: orgID, state: Cold, VolumeID: "vol_" + userID}
}

func (s *Sandbox) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// To performs a guarded transition, rejecting moves not in the §10.1 machine.
func (s *Sandbox) To(next State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.toLocked(next)
}

// toLocked is the guarded transition assuming s.mu is already held. Callers that must
// read-then-transition atomically (Touch) go through this to avoid a TOCTOU race.
func (s *Sandbox) toLocked(next State) error {
	if !transitions[s.state][next] {
		return fmt.Errorf("illegal transition %s -> %s", s.state, next)
	}
	s.state = next
	if next == Active {
		s.lastActive = clockNow()
		s.failures = 0
	}
	return nil
}

// Touch marks activity (a new message/cron), waking an IDLE sandbox (§10.1: <200ms).
// The Idle check and the Idle->Active transition happen under ONE lock acquisition, so two
// concurrent Touches don't both read Idle and race — the loser just refreshes lastActive.
func (s *Sandbox) Touch() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == Idle {
		return s.toLocked(Active)
	}
	s.lastActive = clockNow()
	return nil
}

// Healthcheck records a probe result; 3 consecutive failures fail the sandbox (§10.2).
// Every state change is driven THROUGH the pure Next() machine (fail-closed) so this
// runtime path can never reach an edge the §10.1 machine forbids.
func (s *Sandbox) Healthcheck(ok bool) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ok {
		s.failures = 0
		// A probe flapping back healthy recovers a FAILED sandbox by requeuing it for
		// re-provision: FAILED→COLD (EvClaim, the only legal exit from FAILED, §10.1),
		// after which the warmer takes it COLD→WARMING→ACTIVE. Never a dead-end.
		if s.state == Failed {
			if next, err := Next(s.state, EvClaim, 0, DefaultThresholds); err == nil {
				s.state = next // FAILED → COLD
			}
		}
		return s.state
	}
	s.failures++
	if s.failures >= 3 {
		// Drive to FAILED through the guard: only ACTIVE and WARMING have an EvFail
		// edge (§10.1), so a probe against any other state is a guarded no-op instead
		// of a raw assignment onto a forbidden edge.
		if next, err := Next(s.state, EvFail, 0, DefaultThresholds); err == nil && next == Failed {
			s.state = next
			s.failedAt = clockNow()
		}
	}
	return s.state
}

// Sweep applies the idle/hibernate/destroy timers AND reaps stuck FAILED sandboxes
// (§10.1/§10.2). Called periodically. Every move goes through the pure Next() machine
// with DefaultThresholds, so the running machine matches Next() exactly — including
// the >= transition boundary (Next stays put while elapsed < threshold).
func (s *Sandbox) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Reap: a sandbox stuck in FAILED longer than FailedReapAfter is killed + recreated
	// (FAILED→COLD via EvClaim) so it re-provisions instead of leaking forever. This is
	// the exit that keeps FAILED from being a permanent wedge.
	if s.state == Failed {
		if now.Sub(s.failedAt) >= DefaultThresholds.FailedReapAfter {
			if next, err := Next(s.state, EvClaim, 0, DefaultThresholds); err == nil {
				s.state = next // FAILED → COLD (reap)
			}
		}
		return
	}

	// Idle/hibernate/destroy timers, all measured from lastActive.
	var ev Event
	switch s.state {
	case Active:
		ev = EvIdleTick
	case Idle:
		ev = EvHibernate
	case Hibernated:
		ev = EvDestroy
	default:
		return
	}
	if next, err := Next(s.state, ev, now.Sub(s.lastActive), DefaultThresholds); err == nil {
		s.state = next
	}
}

// clockNow is overridable in tests for deterministic timers.
var clockNow = time.Now
