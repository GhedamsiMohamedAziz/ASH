#!/usr/bin/env bash
# Offline governance-chain demo (instructions.md §9, §13.3) — the whole moat, no API key.
# Boots llm-proxy + prompt-layer + backend-core + mcp-gateway (all stub backends) and drives:
#   1. a real model-routed turn (classify → tier → cost), and
#   2. the APPROVAL RE-MINT LOOP: raise a gated tool → approve → backend-core re-mints a TASK
#      JWT with the tool promoted (prompt-layer /internal/reapprove) → re-invokes it through the
#      gateway → the gateway verifies the re-minted JWT and executes it.
# This exercises the exact cross-service wiring end-to-end that unit tests only cover per hop.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ booting services (stub backends, no key)…"
( cd services/llm-proxy    && python3 -m uvicorn app.main:app --port 8092 --log-level warning ) & LLM=$!
( cd services/prompt-layer && python3 -m uvicorn app.main:app --port 8093 --log-level warning ) & PL=$!
( PORT=8099 node services/mcp-gateway/src/server.ts ) & GW=$!
( cd services/backend-core && \
    PROMPT_LAYER_URL=http://127.0.0.1:8093 LLM_PROXY_URL=http://127.0.0.1:8092 \
    MCP_GATEWAY_URL=http://127.0.0.1:8099 \
    python3 -m uvicorn app.main:app --port 8098 --log-level warning ) & BC=$!
trap 'kill $LLM $PL $GW $BC 2>/dev/null || true' EXIT

for p in 8092 8093 8098 8099; do
  ok=""
  for i in $(seq 1 60); do curl -s -m1 "http://127.0.0.1:$p/healthz" >/dev/null 2>&1 && { ok=1; break; }; sleep 0.25; done
  [ -n "$ok" ] || { echo "  ✗ service on :$p did not come up"; exit 1; }
done
echo "  llm-proxy:ok prompt-layer:ok gateway:ok backend-core:ok"

CID=$(curl -s -X POST http://127.0.0.1:8098/api/v1/conversations -H 'content-type: application/json' -d '{}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "▶ conversation $CID"

# ---- 1. a real model-routed turn (stub LLM, real classification/routing/cost) --------------
echo "▶ turn: \"déploie fix/login sur staging\""
python3 - "$CID" <<'PY'
import asyncio, json, sys, uuid, urllib.request, websockets
cid = sys.argv[1]
async def main():
    async with websockets.connect(f"ws://127.0.0.1:8098/api/v1/conversations/{cid}/stream") as ws:
        await ws.send(json.dumps({"type":"subscribe","last_seq":0}))
        urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:8098/api/v1/conversations/{cid}/messages",
            data=json.dumps({"text":"déploie fix/login sur staging"}).encode(),
            headers={"content-type":"application/json","Idempotency-Key":str(uuid.uuid4())}))
        while True:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if ev["type"] == "agent.done":
                d = ev["data"]; print(f"  · class={d.get('class')} model={d.get('model')} cost=${d.get('cost_usd')}"); break
asyncio.run(main())
PY

# ---- 2. the approval re-mint loop --------------------------------------------------------
echo "▶ raise a gated tool (github.merge_pr requires approval)…"
APPR=$(curl -s -X POST "http://127.0.0.1:8098/api/v1/conversations/$CID/request-approval" \
  -H 'content-type: application/json' -d '{
    "tool":"github.merge_pr","args_summary":"PR #42","requester":"usr_dev",
    "user_id":"usr_dev","org_id":"org_1","args":{"repo":"acme/x","number":42},
    "allowed_tools":["github.search","github.create_pr"],"approval_tools":["github.merge_pr"]
  }' | python3 -c 'import sys,json;print(json.load(sys.stdin)["approval_id"])')
echo "  · approval raised: $APPR (gateway would return needs_approval for this tool)"

echo "▶ human approves → backend re-mints (tool promoted) → re-invokes via gateway…"
curl -s -X POST "http://127.0.0.1:8098/api/v1/conversations/$CID/approve" \
  -H 'content-type: application/json' -d "{\"approval_id\":\"$APPR\",\"decision\":\"approve\"}" \
  | python3 -c '
import sys, json
r = json.load(sys.stdin)
print("  . approval status: " + str(r.get("status")) + " by " + str(r.get("approver")))
replay = r.get("replay")
if not replay:
    print("  x no replay - loop not wired"); sys.exit(1)
print("  . gateway re-invoke: status=" + str(replay.get("status")) + " result=" + repr(replay.get("result")))
if replay.get("status") != "ok":
    print("  x gateway did not execute the promoted tool: " + json.dumps(replay)); sys.exit(1)
print("  OK re-mint loop closed: approved tool ran through the gateway on a freshly-minted JWT")
'
echo "✅ governance chain complete offline — turn + approval re-mint loop, no API key."
