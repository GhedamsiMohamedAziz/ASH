// Notion MCP (instructions.md §14): create/read minutes, specs, wikis. Writes are
// approval-gated by tool_policies where the org requires it. Gateway injects the token.
export interface Ctx { credential: string }
export interface NotionBackend {
  createPage(title: string, content: string, ctx: Ctx): Promise<{ id: string; url: string }>;
  readPage(id: string, ctx: Ctx): Promise<{ title: string; content: string }>;
  search(query: string, ctx: Ctx): Promise<Array<{ id: string; title: string }>>;
}
export class StubNotion implements NotionBackend {
  async createPage(title: string) { return { id: "pg_1", url: "https://notion.so/pg_1" }; }
  async readPage(id: string) { return { title: "Spec", content: "…" }; }
  async search(q: string) { return [{ id: "pg_1", title: "Q3 Spec" }]; }
}
export class NotionMcp {
  private b: NotionBackend;
  constructor(backend: NotionBackend = new StubNotion()) { this.b = backend; }
  tools(): Record<string, (a: any, ctx: Ctx) => Promise<unknown>> {
    return {
      "notion.create_page": (a, ctx) => this.b.createPage(String(a.title), String(a.content ?? ""), ctx),
      "notion.read_page": (a, ctx) => this.b.readPage(String(a.id), ctx),
      "notion.search": (a, ctx) => this.b.search(String(a.query ?? ""), ctx),
    };
  }
}
