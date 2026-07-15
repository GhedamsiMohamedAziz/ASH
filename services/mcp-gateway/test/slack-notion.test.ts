// Slack + Notion connector wiring tests (§13, §14, §17.6). Proves buildGateway() now mounts the REAL
// Slack and Notion MCP surfaces through the SAME gateway path github.*/m365.* use: StubSlack/StubNotion
// offline by default (keyless), the full auth chain (TASK_JWT verify → allowed_tools → approval → taint
// → DLP → audit) runs unchanged, and the newly-registered tools participate in the taint/egress
// reclassification (§17.6). The security crux: a Slack read taints and a later Slack WRITE (public
// egress) is reclassified, while a Notion WRITE (egress "internal") is NEVER taint-gated. MCP tools/list
// gating is covered too. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildGateway, createGatewayServer } from "../src/server.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";

// A TASK JWT valid against real wall-clock (buildGateway uses requireExp + real time, no `now`).
function taskJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "usr_1", org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: [], approval_tools: [],
    ...overrides,
  }, SECRET);
}

// GITHUB_TOKEN must be unset for buildGateway to serve stubs; guard it around each test.
function withEnv(fn: () => Promise<void>) {
  return async () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
    }
  };
}

// ---------------------------------------------------------------- registration + round-trip
test("slack.read_channel round-trips via StubSlack through the gateway (audit row produced)", withEnv(async () => {
  const gw = buildGateway();
  const before = gw.audit.length;
  const r = await gw.call({
    tool: "slack.read_channel",
    args: { channel: "C0123456789" },
    taskJwt: taskJwt({ allowed_tools: ["slack.read_channel"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /stub message 0 in #C0123456789/); // deterministic StubSlack output
  assert.equal(gw.audit.length, before + 1);
  assert.equal(gw.audit.at(-1)?.tool, "slack.read_channel");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("slack.send_message round-trips via StubSlack through the gateway (audit row produced)", withEnv(async () => {
  const gw = buildGateway();
  const r = await gw.call({
    tool: "slack.send_message",
    args: { channel: "C1", text: "hello" },
    taskJwt: taskJwt({ allowed_tools: ["slack.send_message"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /"channel":"C1"/); // deterministic StubSlack post result
  assert.equal(gw.audit.at(-1)?.tool, "slack.send_message");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("notion.read_page round-trips via StubNotion through the gateway (audit row produced)", withEnv(async () => {
  const gw = buildGateway();
  const r = await gw.call({
    tool: "notion.read_page",
    args: { id: "pg_1" },
    taskJwt: taskJwt({ allowed_tools: ["notion.read_page"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /Q3 roadmap/); // deterministic StubNotion page content
  assert.equal(gw.audit.at(-1)?.tool, "notion.read_page");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("notion.create_page round-trips via StubNotion through the gateway (audit row produced)", withEnv(async () => {
  const gw = buildGateway();
  const r = await gw.call({
    tool: "notion.create_page",
    args: { parentId: "pg_1", title: "New spec", content: "body" },
    taskJwt: taskJwt({ allowed_tools: ["notion.create_page"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /notion\.so\/pg_/); // deterministic StubNotion create result
  assert.equal(gw.audit.at(-1)?.tool, "notion.create_page");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("a token NOT allowing a slack/notion tool is denied (E_PERM_TOOL_DENIED)", withEnv(async () => {
  const gw = buildGateway();
  const jwt = taskJwt({ allowed_tools: ["slack.read_channel"] }); // notion.search / slack.send_message NOT allowed
  const n = await gw.call({ tool: "notion.search", args: { query: "spec" }, taskJwt: jwt });
  assert.equal(n.status, "denied");
  assert.equal(n.code, "E_PERM_TOOL_DENIED");
  const s = await gw.call({ tool: "slack.send_message", args: { channel: "C1", text: "x" }, taskJwt: jwt });
  assert.equal(s.status, "denied");
  assert.equal(s.code, "E_PERM_TOOL_DENIED");
}));

// ---------------------------------------------------------------- taint reclassification (§17.6) — the crux
test("slack.read_channel taints the turn; a later slack.send_message is forced to approval (interactive)", withEnv(async () => {
  const gw = buildGateway();
  const jwt = taskJwt({
    task_id: "task_slack_taint",
    allowed_tools: ["slack.read_channel", "slack.send_message"],
  });
  // 1. read_channel ingests untrusted channel messages → taints the task (non-empty stringified result).
  const read = await gw.call({ tool: "slack.read_channel", args: { channel: "C1" }, taskJwt: jwt });
  assert.equal(read.status, "ok");
  // 2. send_message (egressClass public) on the now-tainted turn is reclassified BEFORE it runs — forced
  //    to human approval even though policy allows it, so ingested untrusted content cannot exfil out.
  const send = await gw.call({ tool: "slack.send_message", args: { channel: "C2", text: "b" }, taskJwt: jwt });
  assert.equal(send.status, "needs_approval");
  assert.equal(send.code, "E_GUARD_TAINTED_EGRESS");
}));

test("tainted SCHEDULED run: slack.upload_file fails outright (E_GUARD_TAINTED_EGRESS)", withEnv(async () => {
  const gw = buildGateway();
  const jwt = taskJwt({
    task_id: "task_slack_taint_sched",
    origin: "scheduled",
    allowed_tools: ["slack.search_messages", "slack.upload_file"],
  });
  await gw.call({ tool: "slack.search_messages", args: { query: "leak" }, taskJwt: jwt }); // taints
  const up = await gw.call({
    tool: "slack.upload_file",
    args: { channel: "C1", filename: "dump.txt", content: "secrets" },
    taskJwt: jwt,
  });
  assert.equal(up.status, "denied");
  assert.equal(up.code, "E_GUARD_TAINTED_EGRESS");
}));

test("notion.read_page taints the turn; a later notion.create_page (egress internal) is NOT gated", withEnv(async () => {
  const gw = buildGateway();
  const jwt = taskJwt({
    task_id: "task_notion_internal",
    allowed_tools: ["notion.read_page", "notion.create_page", "notion.update_page"],
  });
  // 1. read_page ingests untrusted page content → taints the turn.
  const read = await gw.call({ tool: "notion.read_page", args: { id: "pg_1" }, taskJwt: jwt });
  assert.equal(read.status, "ok");
  // 2. create_page writes to the org's OWN workspace (egress "internal", not "public") → NEVER taint-gated.
  const create = await gw.call({
    tool: "notion.create_page",
    args: { parentId: "pg_1", title: "Minutes", content: "notes" },
    taskJwt: jwt,
  });
  assert.equal(create.status, "ok");
  // update_page is likewise internal → not gated even on the tainted turn.
  const update = await gw.call({
    tool: "notion.update_page",
    args: { id: "pg_1", appendContent: "addendum" },
    taskJwt: jwt,
  });
  assert.equal(update.status, "ok");
}));

// ---------------------------------------------------------------- MCP tools/list catalog gating
async function listen(server: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function toolsList(server: ReturnType<typeof createGatewayServer>, jwt: string): Promise<string[]> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const json = (await res.json()) as any;
  return (json.result?.tools ?? []).map((t: any) => t.name).sort();
}

test("MCP tools/list surfaces slack/notion tools ONLY when the token allows them", withEnv(async () => {
  const gw = buildGateway();
  const server = createGatewayServer(gw);
  await listen(server);
  try {
    const names = await toolsList(server, taskJwt({ allowed_tools: ["slack.read_channel", "notion.create_page"] }));
    assert.deepEqual(names, ["notion_create_page", "slack_read_channel"]);

    const all = await toolsList(server, taskJwt({
      allowed_tools: [
        "slack.read_channel", "slack.read_thread", "slack.search_messages",
        "slack.send_message", "slack.post_recap", "slack.upload_file",
        "notion.search", "notion.read_page", "notion.create_page", "notion.update_page",
      ],
    }));
    assert.deepEqual(all, [
      "notion_create_page", "notion_read_page", "notion_search", "notion_update_page",
      "slack_post_recap", "slack_read_channel", "slack_read_thread",
      "slack_search_messages", "slack_send_message", "slack_upload_file",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
