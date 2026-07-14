# P4 — Intelligence

> Memory, planning, model routing, budgets, profiles.  ·  _3 wk_  ·  13 tickets

## ✅ AX-042 — Working memory (Redis)

30-turn window + rolling summary (TTL 7d, re-summary every 15 turns).

- **Estimate:** M  ·  **Labels:** memory  ·  **Spec:** §9.1 (type 1)
- **Depends on:** AX-012
- **Acceptance:**
  - [ ] Window persisted per conversation
  - [ ] summary regenerated
  - [ ] TTL enforced

## ✅ AX-043 — Semantic memory (pgvector) + extraction

Durable facts in pgvector with dedup (cosine>0.92); async memory-extraction job.

- **Estimate:** L  ·  **Labels:** memory  ·  **Spec:** §9.1 (type 2)
- **Depends on:** AX-012
- **Acceptance:**
  - [ ] Facts embedded + stored
  - [ ] dedup enforced
  - [ ] extraction job runs async

## ✅ AX-044 — Memory MCP (save/search/update/forget)

Audited memory tool behind the gateway; versioned update; user self-serve forget.

- **Estimate:** M  ·  **Labels:** memory, mcp-server  ·  **Spec:** §9.1.1
- **Depends on:** AX-043, AX-017
- **Acceptance:**
  - [ ] 4 ops work
  - [ ] writes audited (args_hash)
  - [ ] forget purges + audits

## ✅ AX-045 — Procedural notes in workspace

NOTES.md + per-project notes as the learned how-to; injected as <procedural_notes>.

- **Estimate:** M  ·  **Labels:** memory  ·  **Spec:** §9.1 (type 3)
- **Depends on:** AX-021
- **Acceptance:**
  - [ ] Notes read/written by agent
  - [ ] injected into context
  - [ ] compaction >2000 lines

## ✅ AX-046 — Corrections memory

Capture explicit corrections/thumbs-down/repeated approval refusals with reinforced weight.

- **Estimate:** M  ·  **Labels:** memory  ·  **Spec:** §9.1 (type 4)
- **Depends on:** AX-043
- **Acceptance:**
  - [ ] Corrections stored kind=correction
  - [ ] weight bonus in ranking
  - [ ] 3-refusal pattern learned

## ✅ AX-047 — Hybrid retrieval ranking

top-k=8 hybrid score (cosine+recency+frequency, correction bonus), threshold 0.55, expires_at purge.

- **Estimate:** M  ·  **Labels:** memory  ·  **Spec:** §9.1
- **Depends on:** AX-043, AX-046
- **Acceptance:**
  - [ ] Ranking formula implemented
  - [ ] expired facts purged
  - [ ] 3-section context injection

## ✅ AX-048 — Planning (plan decomposition)

Decompose task_agentique into a 3-7 step plan; detect automation intent; drive progress UI.

- **Estimate:** M  ·  **Labels:** prompt-layer, planning  ·  **Spec:** §9.2
- **Depends on:** AX-013
- **Acceptance:**
  - [ ] 3-7 step plan produced
  - [ ] automation intent detected
  - [ ] budget estimate emitted

## ✅ AX-049 — Multi-model routing + fallback

llm-proxy routes eco/frontier by role, org-configurable, auto-fallback on quota/incident.

- **Estimate:** M  ·  **Labels:** llm-proxy, routing  ·  **Spec:** §9.5, Annexe H
- **Depends on:** AX-020
- **Acceptance:**
  - [ ] Role-based routing
  - [ ] fallback on failure
  - [ ] per-model usage tracked

## ✅ AX-050 — Budgets + kill-switch

Per-turn/per-run/per-month/per-org budgets with enforcement and an org kill-switch.

- **Estimate:** L  ·  **Labels:** budgets, cost  ·  **Spec:** §10.2, §15.6, §25
- **Depends on:** AX-049
- **Acceptance:**
  - [ ] Budgets enforced at each level
  - [ ] kill-switch halts spend
  - [ ] usage_daily by origin

## ✅ AX-051 — Prompt-cache context structure

Structure the LLM context for prompt caching; report cache hit rate.

- **Estimate:** M  ·  **Labels:** llm-proxy, cost  ·  **Spec:** §9.6
- **Depends on:** AX-049
- **Acceptance:**
  - [ ] Stable prefix for caching
  - [ ] hit rate measured
  - [ ] cost drop visible

## ✅ AX-052 — Agent profile selection

Select OpenCode profile by classification + user preference (dev/data/ops/generalist).

- **Estimate:** S  ·  **Labels:** agent, prompt-layer  ·  **Spec:** §9.5
- **Depends on:** AX-016, AX-048
- **Acceptance:**
  - [ ] Profile chosen automatically
  - [ ] user override respected
  - [ ] job can pin a profile

## ✅ AX-053 — Memory UI + hygiene guards

Memories page (view/edit/delete by type) + write-forbidden guards (secrets, sensitive, third-party facts).

- **Estimate:** M  ·  **Labels:** memory, web, privacy  ·  **Spec:** §9.1.3, §4.4
- **Depends on:** AX-044, AX-040
- **Acceptance:**
  - [ ] Memories page live
  - [ ] adversarial hygiene tests pass
  - [ ] user-erasure wired

## ✅ AX-054 — P4 exit: personalization + cost tracking

Show personalization influencing answers and per-org cost tracking.

- **Estimate:** S  ·  **Labels:** milestone  ·  **Spec:** §29 P4
- **Depends on:** AX-047, AX-050
- **Acceptance:**
  - [ ] Personalization visible
  - [ ] costs tracked per org
  - [ ] P4 exit gate green
