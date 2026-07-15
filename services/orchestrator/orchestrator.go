package orchestrator

import (
	"errors"
	"sort"
	"sync"
	"time"
)

// Priority: interactive turns preempt scheduled runs — a cron never makes a human
// wait (§10.2). Lower value = higher priority.
type Priority int

const (
	Interactive Priority = 0
	Scheduled   Priority = 1
)

// Task is a unit of work for a sandbox (a validated AgentTask, §9). Budgets are
// enforced by the orchestrator (§10.2).
type Task struct {
	TaskID         string
	UserID         string
	OrgID          string
	Priority       Priority
	MaxSeconds     int
	MaxCostUSD     float64
	enqueuedAt     time.Time
}

// ErrOrgAtCapacity is returned when an org has hit its concurrent-sandbox quota.
var ErrOrgAtCapacity = errors.New("org at sandbox capacity")

// Orchestrator manages sandboxes, a warm pool, and per-org FIFO priority queues.
type Orchestrator struct {
	mu           sync.Mutex
	sandboxes    map[string]*Sandbox // by userID
	warmPool     []*Sandbox          // pre-started, identity-less (§10.2)
	queues       map[string][]*Task  // per-org pending, priority-ordered
	maxPerOrg    int
	activeByOrg  map[string]int
}

func New(maxPerOrg, warmTarget int) *Orchestrator {
	o := &Orchestrator{
		sandboxes:   map[string]*Sandbox{},
		queues:      map[string][]*Task{},
		maxPerOrg:   maxPerOrg,
		activeByOrg: map[string]int{},
	}
	for i := 0; i < warmTarget; i++ {
		// Drive the warm sandbox through the guarded §10.1 machine (Warming→Active→Idle)
		// rather than assigning s.state raw, so the state machine stays the single source of truth.
		sb := &Sandbox{state: Warming, VolumeID: ""}
		_ = sb.To(Active) // warm pool holds ready containers (no identity yet)
		_ = sb.To(Idle)   // ready, unassigned
		o.warmPool = append(o.warmPool, sb)
	}
	return o
}

// Assign binds a warm sandbox to a user in <500ms (§10.2), or cold-creates one.
func (o *Orchestrator) assignLocked(userID, orgID string) *Sandbox {
	if sb, ok := o.sandboxes[userID]; ok {
		return sb
	}
	var sb *Sandbox
	if len(o.warmPool) > 0 {
		sb = o.warmPool[len(o.warmPool)-1]
		o.warmPool = o.warmPool[:len(o.warmPool)-1]
		sb.UserID, sb.OrgID, sb.VolumeID = userID, orgID, "vol_"+userID
		// Idle→Active through the guard (also stamps lastActive + clears failures). Called
		// under o.mu; To() takes the sandbox lock — consistent orch→sandbox ordering, no deadlock.
		_ = sb.To(Active) // warm → assigned
	} else {
		sb = NewSandbox(userID, orgID)
		_ = sb.To(Warming)
		_ = sb.To(Active)
	}
	o.sandboxes[userID] = sb
	o.activeByOrg[orgID]++
	return sb
}

// Submit enqueues a task. If the org is under capacity it is scheduled immediately
// (returns the sandbox); otherwise it waits in the priority queue.
func (o *Orchestrator) Submit(t *Task) (*Sandbox, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	t.enqueuedAt = clockNow()

	// An existing sandbox for this user always takes its own task (wake if idle).
	if sb, ok := o.sandboxes[t.UserID]; ok {
		_ = sb.Touch()
		return sb, nil
	}
	if o.activeByOrg[t.OrgID] >= o.maxPerOrg {
		o.enqueueLocked(t)
		return nil, ErrOrgAtCapacity
	}
	return o.assignLocked(t.UserID, t.OrgID), nil
}

// enqueueLocked inserts a task keeping the per-org queue priority-ordered
// (interactive first), then FIFO within a priority (§10.2).
func (o *Orchestrator) enqueueLocked(t *Task) {
	q := append(o.queues[t.OrgID], t)
	sort.SliceStable(q, func(i, j int) bool { return LessTask(q[i], q[j]) })
	o.queues[t.OrgID] = q
}

// Release frees a user's sandbox slot and pulls the next queued task for that org.
func (o *Orchestrator) Release(userID string) *Task {
	o.mu.Lock()
	defer o.mu.Unlock()
	sb, ok := o.sandboxes[userID]
	if !ok {
		return nil
	}
	orgID := sb.OrgID
	delete(o.sandboxes, userID)
	o.activeByOrg[orgID]--
	q := o.queues[orgID]
	if len(q) == 0 {
		return nil
	}
	next := q[0]
	o.queues[orgID] = q[1:]
	o.assignLocked(next.UserID, next.OrgID)
	return next
}

// StaleScheduled returns queued SCHEDULED tasks waiting > 15min — the caller
// re-plans them via Trigger.dev retry rather than growing the queue (§10.2).
func (o *Orchestrator) StaleScheduled(now time.Time) []*Task {
	o.mu.Lock()
	defer o.mu.Unlock()
	var stale []*Task
	for org, q := range o.queues {
		kept := q[:0]
		for _, t := range q {
			if NeedsReplan(t, now, DefaultReplanWindow) {
				stale = append(stale, t)
			} else {
				kept = append(kept, t)
			}
		}
		o.queues[org] = kept
	}
	return stale
}

// BudgetExceeded reports whether a running task has blown its budget (§10.2) →
// the caller cuts the sandbox and emits agent.error(E_BUDGET_EXCEEDED).
func (t *Task) BudgetExceeded(elapsedSeconds int, costUSD float64) bool {
	if t.MaxSeconds > 0 && elapsedSeconds > t.MaxSeconds {
		return true
	}
	if t.MaxCostUSD > 0 && costUSD > t.MaxCostUSD {
		return true
	}
	return false
}
