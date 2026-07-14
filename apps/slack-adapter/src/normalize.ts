// Normalize a Slack event into the canonical InboundMessage (instructions.md §7.4).
// The identity resolution (slack_user_id + team_id → canonical user via the
// identities table) is stubbed here; an unlinked user returns null so the adapter
// can reply with an account-linking prompt instead of processing (§7.2).

export interface SlackEvent {
  team_id: string;
  event: {
    type: string; // "app_mention" | "message"
    user: string; // slack_user_id
    text: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  };
  event_id: string;
}

export interface InboundMessage {
  schema_version: "1.2";
  message_id: string;
  user_id: string;
  org_id: string;
  channel: "slack";
  channel_ref: { conversation_id: string; thread_ts?: string };
  conversation_id: string;
  text: string;
  locale: string;
  idempotency_key: string;
  ts: string;
}

export interface Identity {
  userId: string;
  orgId: string;
  locale: string;
}

// Identity resolver: (team_id, slack_user_id) → canonical identity, or null if
// the Slack user is not yet linked. Prod queries the identities table.
export type IdentityResolver = (teamId: string, slackUserId: string) => Identity | null;

export function normalize(
  evt: SlackEvent,
  resolve: IdentityResolver,
  isoTime: string, // caller supplies the timestamp (deterministic in tests)
): InboundMessage | null {
  const identity = resolve(evt.team_id, evt.event.user);
  if (!identity) return null; // unlinked → adapter sends the OIDC linking prompt (§7.2)

  const convId = `slack:${evt.event.channel}:${evt.event.thread_ts ?? evt.event.ts}`;
  // Strip a leading bot mention (<@U…>) from app_mention text.
  const text = evt.event.text.replace(/^\s*<@[^>]+>\s*/, "").trim();

  return {
    schema_version: "1.2",
    message_id: `msg_${evt.event_id}`,
    user_id: identity.userId,
    org_id: identity.orgId,
    channel: "slack",
    channel_ref: { conversation_id: evt.event.channel, thread_ts: evt.event.thread_ts },
    conversation_id: convId,
    text,
    locale: identity.locale,
    idempotency_key: evt.event_id, // Slack event_id is the natural idempotency key
    ts: isoTime,
  };
}
