// Event bus abstraction (instructions.md §8.2, Principle #6/#8).
// Wire-compatible contract with packages/shared-py/olma_shared/bus.py: subjects
// use a single trailing '*' wildcard; delivery is at-least-once, so a DedupeGuard
// lets consumers drop repeats by message_id. Prod is NATS JetStream.

export interface Message {
  subject: string;
  data: Record<string, unknown>;
  messageId: string;
}

export type Handler = (msg: Message) => Promise<void> | void;

function matches(pattern: string, subject: string): boolean {
  if (pattern === subject) return true;
  if (pattern.endsWith(".*")) return subject.startsWith(pattern.slice(0, -1));
  return false;
}

export class InMemoryBus {
  private subs: Array<[string, Handler]> = [];

  async publish(subject: string, data: Record<string, unknown>, messageId = ""): Promise<void> {
    const msg: Message = { subject, data, messageId };
    const handlers = this.subs.filter(([pat]) => matches(pat, subject)).map(([, h]) => h);
    await Promise.all(handlers.map((h) => h(msg)));
  }

  subscribe(pattern: string, handler: Handler): () => void {
    const entry: [string, Handler] = [pattern, handler];
    this.subs.push(entry);
    return () => {
      const i = this.subs.indexOf(entry);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }
}

// Consumer-side at-least-once dedup by message_id (§21).
export class DedupeGuard {
  private seen = new Set<string>();
  private capacity: number;
  constructor(capacity = 10000) {
    this.capacity = capacity;
  }

  isDuplicate(messageId: string): boolean {
    if (!messageId) return false;
    if (this.seen.has(messageId)) return true;
    this.seen.add(messageId);
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!);
    return false;
  }
}
