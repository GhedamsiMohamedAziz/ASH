// Proactive notifications (instructions.md §7.1, §7.2). Store the conversation
// reference so scheduled-run/long-task results can be delivered async into the
// right thread; a long task pings @user on completion to trigger the native notif.
export interface ConversationRef { channel: string; threadTs?: string; userId: string; }
export class ProactiveDelivery {
  private refs = new Map<string, ConversationRef>();
  remember(convId: string, ref: ConversationRef) { this.refs.set(convId, ref); }
  // Build a proactive message; a long task mentions the user to fire their notif.
  deliver(convId: string, text: string, mentionUser = false): { channel: string; text: string } | null {
    const ref = this.refs.get(convId);
    if (!ref) return null;
    const body = mentionUser ? `<@${ref.userId}> ${text}` : text;
    return { channel: ref.channel, text: body };
  }
}
