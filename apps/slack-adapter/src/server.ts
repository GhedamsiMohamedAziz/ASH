// Slack adapter HTTP surface (instructions.md §7.2, §7.2.1).
//
// Temps 1 — ACK instantané (< 3 s): verify signature, dedupe, publish the
// InboundMessage to the bus, respond 200 immediately (Slack re-sends if we're
// slow — hence the dedup). The agent turn runs asynchronously; results come back
// via chat.update in the thread. Slack url_verification challenge is echoed.
import { createServer } from "node:http";
import { EventDedup, verifySlackSignature } from "./verify.ts";
import { normalize, type Identity, type IdentityResolver } from "./normalize.ts";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "slack-signing-secret";

// Dev identity resolver — one linked user. Prod queries the identities table.
const resolve: IdentityResolver = (_team, user): Identity | null =>
  user.startsWith("U") ? { userId: "usr_dev", orgId: "org_1", locale: "fr-FR" } : null;

export function createSlackServer(publish: (inbound: object) => void) {
  const dedup = new EventDedup();
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (req.method !== "POST" || req.url !== "/webhooks/slack") {
      res.writeHead(404);
      return res.end();
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    const verdict = verifySlackSignature(req.headers as any, raw, SIGNING_SECRET);
    if (!verdict.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "E_AUTH_INVALID_TOKEN", reason: verdict.reason } }));
    }

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end();
    }

    // Slack URL verification handshake.
    if (body.type === "url_verification") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ challenge: body.challenge }));
    }

    // ACK instantly (< 3 s). Do the work after responding.
    res.writeHead(200);
    res.end();

    if (dedup.isDuplicate(body.event_id)) return; // Slack retry — already handled
    const inbound = normalize(body, resolve, new Date().toISOString());
    if (inbound) publish(inbound);
    // else: unlinked user → prod posts an ephemeral account-linking prompt.
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8085);
  const published: object[] = [];
  createSlackServer((m) => {
    published.push(m);
    console.log("published InboundMessage:", JSON.stringify(m));
  }).listen(port, () => console.log(`slack-adapter on :${port}`));
}
