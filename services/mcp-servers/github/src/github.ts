// GitHub MCP server (instructions.md §14, wave-1 connector).
//
// Exposes GitHub tools behind one interface; the MCP Gateway (§13) injects the
// credential and enforces AuthZ, so this layer never sees a raw user token except
// via the ctx passed in. Ships a StubBackend (offline, deterministic) so the whole
// chain runs without network; a real backend using the GitHub REST API / Octokit
// drops in behind GithubBackend with no change to the tool surface.

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // injected by the gateway from Vault (§13.2)
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface GithubBackend {
  searchCode(query: string, ctx: ToolContext): Promise<string[]>;
  readFile(repo: string, path: string, ctx: ToolContext): Promise<string>;
  createPr(repo: string, head: string, base: string, title: string, ctx: ToolContext): Promise<PullRequest>;
  mergePr(repo: string, number: number, ctx: ToolContext): Promise<{ merged: boolean; sha: string }>;
  listIssues(repo: string, ctx: ToolContext): Promise<Array<{ number: number; title: string }>>;
}

// Deterministic offline backend — same input yields the same output. Stands in
// for the real GitHub API on the dev/test path (no token, no network).
export class StubBackend implements GithubBackend {
  private prSeq = 41;

  async searchCode(query: string): Promise<string[]> {
    return [`src/${query}.ts`, `test/${query}.test.ts`];
  }
  async readFile(repo: string, path: string): Promise<string> {
    return `// ${repo}:${path}\nexport const stub = true;\n`;
  }
  async createPr(repo: string, head: string, base: string, title: string): Promise<PullRequest> {
    const number = ++this.prSeq;
    return { number, title, url: `https://github.com/${repo}/pull/${number}`, state: "open" };
  }
  async mergePr(_repo: string, number: number): Promise<{ merged: boolean; sha: string }> {
    return { merged: true, sha: `sha_${number.toString(16)}` };
  }
  async listIssues(_repo: string): Promise<Array<{ number: number; title: string }>> {
    return [
      { number: 12, title: "flaky login test" },
      { number: 15, title: "add rate limiting" },
    ];
  }
}

// The MCP tool surface: maps tool names (as they appear in tool_policies and the
// TASK JWT allowed_tools) to backend calls. Every commit/PR gets a
// "Requested by"/"Co-authored-by" trailer in team mode (§3.2) — added here so the
// Git history is not blind to who actually asked (the audit is, the history isn't).
export class GithubMcp {
  private backend: GithubBackend;
  constructor(backend: GithubBackend = new StubBackend()) {
    this.backend = backend;
  }

  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      "github.search": (a, ctx) => this.backend.searchCode(String(a.query ?? ""), ctx),
      "github.read": (a, ctx) => this.backend.readFile(String(a.repo), String(a.path), ctx),
      "github.create_pr": async (a, ctx) => {
        const pr = await this.backend.createPr(
          String(a.repo), String(a.head), String(a.base ?? "main"), String(a.title), ctx);
        return { ...pr, trailer: trailerFor(ctx) };
      },
      "github.merge_pr": (a, ctx) => this.backend.mergePr(String(a.repo), Number(a.number), ctx),
      "github.list_issues": (a, ctx) => this.backend.listIssues(String(a.repo), ctx),
    };
  }
}

export function trailerFor(ctx: ToolContext): string {
  // In team mode the commit author is the bot; name the human who requested it.
  return `Requested-by: ${ctx.userId}\nCo-authored-by: olma-agent <agent@olma.dev>`;
}
