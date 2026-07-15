# evals/golden

Golden classification set (§20.2). CI gate: regression >3% = STOP (§22.3 step 4).

Data-driven: cases live in `*.jsonl` (one JSON record per line), loaded by
`../runner.py`. Each record:

```json
{"name": "...", "kind": "classify", "inp": "...", "expect": "chat_simple", "recurrence": false}
```

- `expect` ∈ `chat_simple | task_agentique | ambigu` — asserts `classify().cls`.
- `recurrence` (optional) — asserts `classify().recurrence` (automation intent, §9.2).

`classify.jsonl` covers FR/EN across every MCP domain (github / browser / database /
slack / scheduler), recurrence detection ("chaque lundi", "every night"), and the
ambigu escalation boundary. All labels reflect the real classifier's output.
