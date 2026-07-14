// Teams adapter: normalize Bot Framework activities → InboundMessage (§7.1, §7.4).
// Identity: the activity's aadObjectId maps to the canonical user via `identities`
// (same as Slack's slack_user_id). Unlinked → null so the adapter runs the SSO
// account-linking flow (§7.1). The Bot Framework JWT validation is in verify.ts.

export interface TeamsActivity {
  type: string; // "message"
  id: string; // activity id
  text: string;
  from: { aadObjectId: string; name?: string };
  conversation: { id: string };
  channelData?: { tenant?: { id: string } };
  locale?: string;
}

export interface Identity {
  userId: string;
  orgId: string;
  locale: string;
}

export type IdentityResolver = (aadObjectId: string, tenantId?: string) => Identity | null;

export interface InboundMessage {
  schema_version: "1.2";
  message_id: string;
  user_id: string;
  org_id: string;
  channel: "teams";
  channel_ref: { conversation_id: string; activity_id: string };
  conversation_id: string;
  text: string;
  locale: string;
  idempotency_key: string;
  ts: string;
}

export function normalize(
  act: TeamsActivity,
  resolve: IdentityResolver,
  isoTime: string,
): InboundMessage | null {
  if (act.type !== "message") return null;
  const identity = resolve(act.from.aadObjectId, act.channelData?.tenant?.id);
  if (!identity) return null; // unlinked → SSO/account-linking flow (§7.1)

  // Strip a leading <at>bot</at> mention that Teams includes in text.
  const text = act.text.replace(/^\s*<at>[^<]*<\/at>\s*/i, "").trim();

  return {
    schema_version: "1.2",
    message_id: `msg_${act.id}`,
    user_id: identity.userId,
    org_id: identity.orgId,
    channel: "teams",
    channel_ref: { conversation_id: act.conversation.id, activity_id: act.id },
    conversation_id: `teams:${act.conversation.id}`,
    text,
    locale: act.locale ?? identity.locale,
    idempotency_key: act.id, // Bot Framework activity id is the idempotency key
    ts: isoTime,
  };
}
