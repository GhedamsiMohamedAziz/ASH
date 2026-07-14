# packages/errors (AX-003)

Shared error taxonomy — one source of truth for TS + Python (instructions.md §21,
Principle #6). Services never hand-roll error codes; they consume the generated
modules and emit the unified envelope `{error:{code,message,trace_id,retry_after}}`
(§8.3).

| File | Role |
|---|---|
| `errors.json` | Canonical taxonomy: code, HTTP status, retry semantics, fr/en/ar messages. |
| `gen.py` | Emits `dist/python/olma_errors.py` + `dist/typescript/errors.ts`. |
| `dist/` | Generated modules (do not edit). |
| `test_errors.py` | 7 tests: §21 completeness, HTTP/locale validity, generated module, retry flags, interpolation, envelope shape. |

**Codes:** the 16 canonical §21 codes (`group: agent`) plus 4 HTTP-layer additions
(`group: api`: `E_VALIDATION`, `E_NOT_FOUND`, `E_IDEMPOTENCY_KEY_REQUIRED`,
`E_CONV_NOT_FOUND`) that backend-core already emits.

**Retry semantics** are an enum (`no`, `auto_refresh`, `backoff_3x`, `once`, `queue`,
`after_retry_after`, `idempotent_only`, `na`); `retryable`/`isRetryable` derive a
boolean. Messages support `{provider}`-style interpolation and locale fallback
(`fr-FR` → `fr`, unknown → `en`).

```bash
python3 packages/errors/gen.py          # regenerate after editing errors.json
python3 -m pytest packages/errors       # 7 tests
```

**Follow-up (AX-008):** wire codegen into CI and have services import from `dist/`
instead of local constants. Today backend-core's codes are kept consistent with
this taxonomy by a test here, not yet a shared import.
