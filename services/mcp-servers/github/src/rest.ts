// Real GitHub backend (instructions.md §14) — the money/blast-radius edge.
//
// Implements the identical GithubBackend interface as StubBackend, so `new GithubMcp(new
// RestBackend())` makes every tool call real with zero change to the tool surface. Uses the
// native fetch in Node >=23 (no @octokit dependency, matches the no-build type-stripping
// runtime). The token is NEVER read from source: it comes per-call from ctx.credential, which
// the gateway injects from Vault (§13.2) — the real user/org token, scoped by policy. A
// GITHUB_TOKEN env fallback exists only for the standalone demo.
//
// Every GitHub failure is mapped to the §21 error taxonomy so the layers above surface a named
// error, never a silent 200-that-wasn't: 401 -> E_CONN_TOKEN_EXPIRED (reconnect), secondary
// rate limit / 403 -> E_RATE_LIMITED (back off), 404 -> E_CONN_NEEDS_CONNECTION.

import type {
  Commit, GithubBackend, IssueDetail, IssueRef, PullDetail, PullRef, PullRequest, Repo, ToolContext,
} from "./github.ts";

// §14 "règles communes": responses truncated to 256 KB. github metadata payloads are small, but a
// token-holder's repo/commit/search list (or a giant issue/PR body) can still exceed the cap — never
// hand an over-limit blob to the gateway.
const MAX_RESPONSE_BYTES = 256 * 1024;

// Drop trailing items until the serialized array fits the 256 KB cap (n <= 30 here, so linear is fine).
function cap<T>(items: T[]): T[] {
  let n = items.length;
  while (n > 0 && Buffer.byteLength(JSON.stringify(items.slice(0, n)), "utf8") > MAX_RESPONSE_BYTES) n--;
  return n === items.length ? items : items.slice(0, n);
}

// Hard-cap a single large free-text field (issue/PR body) to the same 256 KB budget.
function capStr(s: string): string {
  return Buffer.byteLength(s, "utf8") > MAX_RESPONSE_BYTES ? s.slice(0, MAX_RESPONSE_BYTES) : s;
}

// A typed error carrying a taxonomy code so the gateway/prompt-layer can map it (§21).
export class GithubApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.code = code;
    this.status = status;
  }
}

function mapStatus(status: number, body: string): GithubApiError {
  if (status === 401) return new GithubApiError("E_CONN_TOKEN_EXPIRED", status, "GitHub token invalid or expired");
  // Secondary rate limits and primary rate limits both surface as 403 (or 429).
  if (status === 403 || status === 429) return new GithubApiError("E_RATE_LIMITED", status, "GitHub rate limit hit");
  if (status === 404) return new GithubApiError("E_CONN_NEEDS_CONNECTION", status, "GitHub resource not found or no access");
  if (status === 409) return new GithubApiError("E_TOOL_CONFLICT", status, `GitHub conflict: ${body.slice(0, 200)}`);
  return new GithubApiError("E_TOOL_UPSTREAM_ERROR", status, `GitHub error ${status}: ${body.slice(0, 200)}`);
}

export class RestBackend implements GithubBackend {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { base?: string; fetchImpl?: typeof fetch } = {}) {
    this.base = opts.base ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private token(ctx: ToolContext): string {
    // Prod: the per-user/org token comes ONLY from ctx.credential (gateway-injected from
    // Vault). No ambient-env fallback — an empty credential must fail closed, never silently
    // escalate every requester to one shared token (confused deputy). The GITHUB_TOKEN env
    // fallback is allowed solely for the standalone demo, gated behind an explicit flag.
    if (ctx.credential) return ctx.credential;
    if (process.env.OLMA_STANDALONE_DEMO === "1" && process.env.GITHUB_TOKEN) {
      return process.env.GITHUB_TOKEN;
    }
    throw new GithubApiError("E_CONN_NEEDS_CONNECTION", 401, "no GitHub credential for this user");
  }

  // repo must be "owner/name"; path segments are encoded. Prevents an agent-supplied repo/path
  // from injecting extra path/query segments and pivoting the injected token past the tool's intent.
  private static repoPath(repo: string): string {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new GithubApiError("E_VALIDATION", 400, `invalid repo: ${repo}`);
    }
    return repo;
  }
  private static encPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  private async call(method: string, path: string, ctx: ToolContext, body?: unknown): Promise<any> {
    const token = this.token(ctx); // resolve first — a missing credential is its own named error
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "olma-mcp-github",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/DNS/timeout before any HTTP status — a real failure, named not swallowed.
      throw new GithubApiError("E_TOOL_UPSTREAM_ERROR", 0, `GitHub request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapStatus(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  async searchCode(query: string, ctx: ToolContext): Promise<string[]> {
    const data = await this.call("GET", `/search/code?q=${encodeURIComponent(query)}`, ctx);
    return (data.items ?? []).map((i: any) => `${i.repository?.full_name ?? ""}:${i.path}`);
  }

  async readFile(repo: string, path: string, ctx: ToolContext): Promise<string> {
    const data = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/contents/${RestBackend.encPath(path)}`, ctx);
    if (data.encoding === "base64" && typeof data.content === "string") {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return typeof data.content === "string" ? data.content : "";
  }

  async createPr(repo: string, head: string, base: string, title: string, ctx: ToolContext): Promise<PullRequest> {
    const pr = await this.call("POST", `/repos/${RestBackend.repoPath(repo)}/pulls`, ctx, { head, base, title });
    return { number: pr.number, title: pr.title, url: pr.html_url, state: pr.state };
  }

  async mergePr(repo: string, number: number, ctx: ToolContext): Promise<{ merged: boolean; sha: string }> {
    const data = await this.call("PUT", `/repos/${RestBackend.repoPath(repo)}/pulls/${encodeURIComponent(String(number))}/merge`, ctx);
    return { merged: !!data.merged, sha: data.sha ?? "" };
  }

  async listIssues(repo: string, ctx: ToolContext, state = "open"): Promise<Array<{ number: number; title: string }>> {
    const data = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/issues?state=${encodeURIComponent(state)}`, ctx);
    // The issues endpoint returns PRs too; drop them (real issues have no pull_request field).
    return (data as any[])
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title }));
  }

  async listRepos(ctx: ToolContext): Promise<Repo[]> {
    const data = await this.call("GET", `/user/repos?per_page=30&sort=updated`, ctx);
    return cap((data as any[]).map((r) => ({
      full_name: r.full_name, private: !!r.private, description: r.description ?? null,
      updated_at: r.updated_at, html_url: r.html_url,
    })));
  }

  async getIssue(repo: string, number: number, ctx: ToolContext): Promise<IssueDetail> {
    const d = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/issues/${encodeURIComponent(String(number))}`, ctx);
    return { number: d.number, title: d.title, state: d.state, html_url: d.html_url,
      body: capStr(d.body ?? ""), user: d.user?.login ?? "" };
  }

  async listPullRequests(repo: string, ctx: ToolContext, state = "open"): Promise<PullRef[]> {
    const d = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=30`, ctx);
    return cap((d as any[]).map((p) => ({ number: p.number, title: p.title, state: p.state, html_url: p.html_url })));
  }

  async getPullRequest(repo: string, number: number, ctx: ToolContext): Promise<PullDetail> {
    const p = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/pulls/${encodeURIComponent(String(number))}`, ctx);
    return { number: p.number, title: p.title, state: p.state, html_url: p.html_url,
      body: capStr(p.body ?? ""), merged: !!p.merged, head: p.head?.ref ?? "", base: p.base?.ref ?? "" };
  }

  async searchRepositories(query: string, ctx: ToolContext): Promise<Repo[]> {
    const d = await this.call("GET", `/search/repositories?q=${encodeURIComponent(query)}&per_page=30`, ctx);
    return cap((d.items ?? []).map((r: any) => ({
      full_name: r.full_name, private: !!r.private, description: r.description ?? null,
      updated_at: r.updated_at, html_url: r.html_url,
    })));
  }

  async searchIssues(query: string, ctx: ToolContext): Promise<IssueRef[]> {
    const d = await this.call("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=30`, ctx);
    return cap((d.items ?? []).map((i: any) => ({ number: i.number, title: i.title, state: i.state, html_url: i.html_url })));
  }

  async listCommits(repo: string, ctx: ToolContext): Promise<Commit[]> {
    const d = await this.call("GET", `/repos/${RestBackend.repoPath(repo)}/commits?per_page=30`, ctx);
    return cap((d as any[]).map((c) => ({
      sha: c.sha, message: c.commit?.message ?? "",
      author: c.author?.login ?? c.commit?.author?.name ?? "", html_url: c.html_url,
    })));
  }
}
