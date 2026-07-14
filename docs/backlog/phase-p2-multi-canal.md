# P2 — Multi-canal

> Teams + Slack adapters with SSO, cards, approvals, escalation.  ·  _3 wk_  ·  9 tickets

## ✅ AX-023 — Teams adapter

Bot Framework SDK v4: normalize activities → InboundMessage, SSO token exchange, Adaptive Cards, proactive.

- **Estimate:** L  ·  **Labels:** teams  ·  **Spec:** §7.1
- **Depends on:** AX-011
- **Acceptance:**
  - [ ] Mention/DM handled
  - [ ] SSO account linking
  - [ ] proactive run result delivered

## ✅ AX-024 — Teams webhook JWT validation

Validate Bot Framework JWT on every activity (aud/iss, 5-min clock skew), fail-closed.

- **Estimate:** S  ·  **Labels:** teams, security  ·  **Spec:** §7.1
- **Depends on:** AX-023
- **Acceptance:**
  - [ ] Valid activity accepted
  - [ ] forged/expired rejected
  - [ ] OpenID metadata cached

## ✅ AX-025 — Slack adapter ⭐M0

Bolt app: <3s ACK + 👀 reaction, InboundMessage publish, Block Kit cards, slash commands.

- **Estimate:** L  ·  **Labels:** slack  ·  **Spec:** §7.2
- **Depends on:** AX-011
- **Acceptance:**
  - [ ] ACK <3s then async
  - [ ] Block Kit approval cards
  - [ ] /agent commands wired

## ✅ AX-026 — Slack signature verify + retry dedup ⭐M0

HMAC signature check (5-min anti-replay) and dedup of Slack retries via event_id in Redis.

- **Estimate:** S  ·  **Labels:** slack, security  ·  **Spec:** §7.2
- **Depends on:** AX-025
- **Acceptance:**
  - [ ] Bad signature rejected
  - [ ] retries deduped
  - [ ] replay window enforced

## ✅ AX-027 — Simple vs complex routing

Fast classification path: chat_simple (no sandbox, eco LLM) vs task_agentique with milestones.

- **Estimate:** M  ·  **Labels:** prompt-layer, routing  ·  **Spec:** §7.2.1, §9.2
- **Depends on:** AX-013
- **Acceptance:**
  - [ ] Simple mention answered without sandbox
  - [ ] complex shows plan+milestones
  - [ ] cost path per §25

## ✅ AX-028 — Mid-turn escalation

chat_simple → task_agentique escalation emitting agent.escalated and waking the sandbox.

- **Estimate:** M  ·  **Labels:** prompt-layer  ·  **Spec:** §7.2.1
- **Depends on:** AX-027, AX-014
- **Acceptance:**
  - [ ] Escalation event emitted
  - [ ] sandbox woken on demand
  - [ ] UI shows 'looking in <tool>'

## ✅ AX-029 — Account linking for unknown users

Unlinked mention → ephemeral OIDC linking prompt; no processing before linkage.

- **Estimate:** M  ·  **Labels:** auth  ·  **Spec:** §7.2, §7.1
- **Depends on:** AX-006
- **Acceptance:**
  - [ ] Unknown user gets link
  - [ ] no action pre-link
  - [ ] identity persisted after link

## ✅ AX-030 — Proactive notifications

Store conversationReference (Teams) / channel refs; deliver async/long-task and scheduled results.

- **Estimate:** M  ·  **Labels:** teams, slack  ·  **Spec:** §7.1, §7.2
- **Depends on:** AX-023, AX-025
- **Acceptance:**
  - [ ] Proactive message sent
  - [ ] long-task '@user' ping on completion
  - [ ] refs persisted

## ✅ AX-031 — P2 exit: same task from Teams & Slack

Run the P1 task identically from Teams and Slack.

- **Estimate:** S  ·  **Labels:** milestone  ·  **Spec:** §29 P2
- **Depends on:** AX-023, AX-025, AX-027
- **Acceptance:**
  - [ ] Task works from Teams
  - [ ] task works from Slack
  - [ ] P2 exit gate green
