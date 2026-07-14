// Slack MCP (instructions.md §14): read channels, post recaps. Distinct from the
// inbound slack-adapter (apps/slack-adapter). Gateway injects the bot token.
export interface Ctx { credential: string }
export interface SlackBackend {
  readChannel(channel: string, limit: number, ctx: Ctx): Promise<Array<{ user: string; text: string }>>;
  postMessage(channel: string, text: string, ctx: Ctx): Promise<{ ts: string }>;
}
export class StubSlack implements SlackBackend {
  async readChannel(channel: string, limit: number) {
    return [{ user: "U1", text: "deploy done" }].slice(0, limit);
  }
  async postMessage(channel: string, text: string) { return { ts: "1699.1" }; }
}
export class SlackMcp {
  private b: SlackBackend;
  constructor(backend: SlackBackend = new StubSlack()) { this.b = backend; }
  tools(): Record<string, (a: any, ctx: Ctx) => Promise<unknown>> {
    return {
      "slack.read_channel": (a, ctx) => this.b.readChannel(String(a.channel), Number(a.limit ?? 20), ctx),
      "slack.post_recap": (a, ctx) => this.b.postMessage(String(a.channel), String(a.text), ctx),
    };
  }
}
