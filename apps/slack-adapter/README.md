# Slack Adapter

> **Status:** Phase 2 (AX-025/026, runnable + tested) · **Spec:** instructions.md §7.2, §7.2.1, §7.4

Entry channel: turns Slack events into the canonical InboundMessage and publishes
them to the bus. The demo's front door.

| Piece | File | Spec |
|---|---|---|
| Signature verify (HMAC-SHA256, 5-min anti-replay) + retry dedup | `verify.ts` (AX-026) | §7.2 |
| Event → InboundMessage, bot-mention strip, identity resolve, unlinked→null | `normalize.ts` (AX-025) | §7.4 |
| HTTP surface, **<3 s ACK** then async, url_verification handshake | `server.ts` | §7.2.1 |

```bash
npm test     # 9 tests: signature valid/tampered/wrong-secret/stale/missing, dedup, normalize
npm start    # :8085 — POST /webhooks/slack, GET /healthz
```

Verified live: a properly signed request → 200 + a normalized InboundMessage
published (`déploie …` with the `<@bot>` stripped, identity resolved, `event_id`
as the idempotency key); a tampered signature → 401; a stale timestamp → 401.

## Next
- Block Kit approval cards (renders `agent.approval.needed`, §4.3) + `chat.update` pseudo-streaming.
- Real identity resolution against the `identities` table; ephemeral OIDC linking prompt for unlinked users.
- Publish to real NATS `inbound.messages` (currently an injected `publish` fn); slash commands (`/agent …`).
