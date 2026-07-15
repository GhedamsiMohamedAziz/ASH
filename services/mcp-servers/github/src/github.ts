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

// Read-tool return shapes (wave-1 read surface, mirroring the mcpmarket github toolset). All are
// GitHub-metadata projections — no raw token ever appears — so the gateway can DLP-scrub + cap them.
export interface Repo {
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  html_url: string;
}

export interface IssueRef {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

export interface IssueDetail extends IssueRef {
  body: string;
  user: string;
}

export interface PullRef {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

export interface PullDetail extends PullRef {
  body: string;
  merged: boolean;
  head: string;
  base: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  html_url: string;
}

export interface GithubBackend {
  searchCode(query: string, ctx: ToolContext): Promise<string[]>;
  readFile(repo: string, path: string, ctx: ToolContext): Promise<string>;
  createPr(repo: string, head: string, base: string, title: string, ctx: ToolContext): Promise<PullRequest>;
  mergePr(repo: string, number: number, ctx: ToolContext): Promise<{ merged: boolean; sha: string }>;
  // state is optional + trailing so the pre-existing listIssues(repo, ctx) call sites stay valid.
  listIssues(repo: string, ctx: ToolContext, state?: string): Promise<Array<{ number: number; title: string }>>;
  // Read surface (all read-only, egressClass "none"): the caller's real OAuth token, injected per
  // call via ctx.credential, is what RestBackend authenticates with.
  listRepos(ctx: ToolContext): Promise<Repo[]>;
  getIssue(repo: string, number: number, ctx: ToolContext): Promise<IssueDetail>;
  listPullRequests(repo: string, ctx: ToolContext, state?: string): Promise<PullRef[]>;
  getPullRequest(repo: string, number: number, ctx: ToolContext): Promise<PullDetail>;
  searchRepositories(query: string, ctx: ToolContext): Promise<Repo[]>;
  searchIssues(query: string, ctx: ToolContext): Promise<IssueRef[]>;
  listCommits(repo: string, ctx: ToolContext): Promise<Commit[]>;
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
  async listIssues(_repo: string, _ctx?: ToolContext, _state?: string): Promise<Array<{ number: number; title: string }>> {
    return [
      { number: 12, title: "flaky login test" },
      { number: 15, title: "add rate limiting" },
    ];
  }
  async listRepos(): Promise<Repo[]> {
    return [
      { full_name: "acme/checkout", private: false, description: "Checkout service", updated_at: "2026-07-01T10:00:00Z", html_url: "https://github.com/acme/checkout" },
      { full_name: "acme/api", private: true, description: "Internal API", updated_at: "2026-06-20T09:00:00Z", html_url: "https://github.com/acme/api" },
      { full_name: "acme/docs", private: false, description: null, updated_at: "2026-05-15T08:00:00Z", html_url: "https://github.com/acme/docs" },
    ];
  }
  async getIssue(repo: string, number: number): Promise<IssueDetail> {
    return { number, title: "flaky login test", state: "open", html_url: `https://github.com/${repo}/issues/${number}`, body: "Login test is flaky under load.", user: "octocat" };
  }
  async listPullRequests(repo: string): Promise<PullRef[]> {
    return [
      { number: 42, title: "fix login", state: "open", html_url: `https://github.com/${repo}/pull/42` },
      { number: 40, title: "bump deps", state: "closed", html_url: `https://github.com/${repo}/pull/40` },
    ];
  }
  async getPullRequest(repo: string, number: number): Promise<PullDetail> {
    return { number, title: "fix login", state: "open", html_url: `https://github.com/${repo}/pull/${number}`, body: "Fixes the login regression.", merged: false, head: "fix/login", base: "main" };
  }
  async searchRepositories(query: string): Promise<Repo[]> {
    return [
      { full_name: `acme/${query}`, private: false, description: `Repo matching ${query}`, updated_at: "2026-07-01T10:00:00Z", html_url: `https://github.com/acme/${query}` },
      { full_name: `octo/${query}-lib`, private: false, description: null, updated_at: "2026-06-10T10:00:00Z", html_url: `https://github.com/octo/${query}-lib` },
    ];
  }
  async searchIssues(query: string): Promise<IssueRef[]> {
    return [
      { number: 12, title: `bug: ${query}`, state: "open", html_url: "https://github.com/acme/x/issues/12" },
      { number: 15, title: `feat: ${query}`, state: "closed", html_url: "https://github.com/acme/x/issues/15" },
    ];
  }
  async listCommits(repo: string): Promise<Commit[]> {
    return [
      { sha: "a1b2c3d", message: "fix login regression", author: "octocat", html_url: `https://github.com/${repo}/commit/a1b2c3d` },
      { sha: "e4f5a6b", message: "add rate limiting", author: "hubot", html_url: `https://github.com/${repo}/commit/e4f5a6b` },
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
      "github.list_issues": (a, ctx) => this.backend.listIssues(ghRepo(a), ctx, ghState(a)),
      // Read surface — each uses the caller's real OAuth token (ctx.credential) on the RestBackend path.
      "github.list_repos": (_a, ctx) => this.backend.listRepos(ctx),
      "github.get_issue": (a, ctx) => this.backend.getIssue(ghRepo(a), Number(a.number), ctx),
      "github.list_pull_requests": (a, ctx) => this.backend.listPullRequests(ghRepo(a), ctx, ghState(a)),
      "github.get_pull_request": (a, ctx) => this.backend.getPullRequest(ghRepo(a), Number(a.number), ctx),
      "github.search_repositories": (a, ctx) => this.backend.searchRepositories(String(a.q ?? ""), ctx),
      "github.search_issues": (a, ctx) => this.backend.searchIssues(String(a.q ?? ""), ctx),
      "github.list_commits": (a, ctx) => this.backend.listCommits(ghRepo(a), ctx),
    };
  }
}

// Accept either { owner, repo } (the read tools) or { repo: "owner/name" } (the pre-existing tools)
// and produce the canonical "owner/name" the RestBackend path validates + path-encodes.
function ghRepo(a: any): string {
  return a?.owner ? `${a.owner}/${a.repo}` : String(a?.repo ?? "");
}

// Optional issue/PR state filter (open|closed|all); undefined lets the backend default to "open".
function ghState(a: any): string | undefined {
  return a?.state ? String(a.state) : undefined;
}

export function trailerFor(ctx: ToolContext): string {
  // In team mode the commit author is the bot; name the human who requested it.
  return `Requested-by: ${ctx.userId}\nCo-authored-by: olma-agent <agent@olma.dev>`;
}
