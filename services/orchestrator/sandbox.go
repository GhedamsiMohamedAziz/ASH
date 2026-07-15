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
	Error      State = "ERROR"
	Failed     State = "FAILED"
	Destroyed  State = "DESTROYED"
)

// transitions encodes the §10.1 state machine: from -> allowed set.
var transitions = map[State]map[State]bool{
	Cold:       {Warming: true},
	Warming:    {Active: true, Failed: true},
	Active:     {Idle: true, Error: true},
	Idle:       {Active: true, Hibernated: true},
	Hibernated: {Active: true, Destroyed: true},
	Error:      {Active: true},
	Failed:     {Cold: true}, // kill + recreate
	Destroyed:  {},
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
	failures   int // consecutive healthcheck failures (§10.2)
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
func (s *Sandbox) Healthcheck(ok bool) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ok {
		s.failures = 0
		return s.state
	}
	s.failures++
	if s.failures >= 3 && (s.state == Active || s.state == Warming) {
		s.state = Error
	}
	return s.state
}

// Sweep applies the idle/hibernate/destroy timers (§10.1). Called periodically.
// idle > IdleAfter → IDLE; idle > HibernateAfter → HIBERNATED; dormant >
// DestroyAfter → DESTROYED (volume archived to S3). Thresholds come from
// DefaultThresholds so the running machine matches the pure Next() function.
func (s *Sandbox) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idleFor := now.Sub(s.lastActive)
	switch s.state {
	case Active:
		if idleFor > DefaultThresholds.IdleAfter {
			s.state = Idle
		}
	case Idle:
		if idleFor > DefaultThresholds.HibernateAfter {
			s.state = Hibernated
		}
	case Hibernated:
		if idleFor > DefaultThresholds.DestroyAfter {
			s.state = Destroyed
		}
	}
}

// clockNow is overridable in tests for deterministic timers.
var clockNow = time.Now
