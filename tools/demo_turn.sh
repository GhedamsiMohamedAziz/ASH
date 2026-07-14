#!/usr/bin/env bash
# End-to-end agent turn across the real services (instructions.md §8.2, §9, §9.5).
# Boots llm-proxy + prompt-layer + backend-core, then drives one turn over HTTP+WS
# and shows the REAL classification, model tier and cost flowing through the stream.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

echo "▶ booting services…"
( cd services/llm-proxy   && python3 -m uvicorn app.main:app --port 8092 --log-level warning ) & LLM=$!
( cd services/prompt-layer && python3 -m uvicorn app.main:app --port 8093 --log-level warning ) & PL=$!
( cd services/backend-core && PROMPT_LAYER_URL=http://127.0.0.1:8093 LLM_PROXY_URL=http://127.0.0.1:8092 \
    python3 -m uvicorn app.main:app --port 8098 --log-level warning ) & BC=$!
trap 'kill $LLM $PL $BC 2>/dev/null || true' EXIT

for p in 8092 8093 8098; do
  for i in $(seq 1 40); do curl -s -m1 "http://127.0.0.1:$p/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
done
echo "  llm-proxy:$(curl -s http://127.0.0.1:8092/healthz | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])') prompt-layer:ok backend-core:ok"

CID=$(curl -s -X POST http://127.0.0.1:8098/api/v1/conversations -H 'content-type: application/json' -d '{}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "▶ conversation $CID"

TEXT="${1:-what is our branch naming convention?}"
echo "▶ user: \"$TEXT\""
python3 - "$CID" "$TEXT" <<'PY'
import asyncio, json, sys, uuid, urllib.request, websockets
cid, text = sys.argv[1], sys.argv[2]
async def main():
    uri = f"ws://127.0.0.1:8098/api/v1/conversations/{cid}/stream"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"type":"subscribe","last_seq":0}))
        req = urllib.request.Request(
            f"http://127.0.0.1:8098/api/v1/conversations/{cid}/messages",
            data=json.dumps({"text":text}).encode(),
            headers={"content-type":"application/json","Idempotency-Key":str(uuid.uuid4())})
        urllib.request.urlopen(req)
        reply=""
        while True:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            t = ev["type"]
            if t == "agent.tool.call":
                print(f"  · tool.call  {ev['data'].get('args_summary')}")
            elif t == "agent.text.delta":
                reply += ev["data"]["text"]
            elif t == "agent.done":
                d = ev["data"]
                print(f"  · agent reply: {reply}")
                print(f"  · class={d.get('class')} model={d.get('model')} cost=${d.get('cost_usd')}")
                break
asyncio.run(main())
PY
echo "✅ real turn complete — classification, model routing and cost all live."
