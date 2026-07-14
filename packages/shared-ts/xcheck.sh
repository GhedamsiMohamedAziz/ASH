#!/usr/bin/env bash
# Cross-language wire-compatibility check for shared-py <-> shared-ts (AX-007).
# Proves a JWT / traceparent minted in one language is honored in the other.
set -euo pipefail
cd "$(dirname "$0")/../.."
SECRET="dev-shared-secret"

command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }

# --- JWT: py signs -> ts verifies -> ts signs -> py verifies ---
PYTOK=$(PYTHONPATH=packages/shared-py python3 -c \
  "from olma_shared import jwt; print(jwt.sign({'sub':'usr_py','exp':2000}, '$SECRET'))")
TSOUT=$(node packages/shared-ts/src/xcheck.ts "$PYTOK" "$SECRET")
echo "$TSOUT" | grep -q 'usr_py' || { echo "FAIL: TS could not verify py JWT"; exit 1; }
TSTOK=$(echo "$TSOUT" | grep '^TS_TOKEN=' | cut -d= -f2-)
PYTHONPATH=packages/shared-py python3 -c \
  "from olma_shared import jwt; assert jwt.verify('$TSTOK','$SECRET')['sub']=='usr_ts'" \
  || { echo "FAIL: py could not verify ts JWT"; exit 1; }

# --- traceparent: py generates -> ts parses/childs -> py confirms ---
PYTP=$(PYTHONPATH=packages/shared-py python3 -c \
  "from olma_shared import telemetry as t; print(t.new_trace().to_traceparent())")
CHILD=$(node --input-type=module -e \
  "import {child,toTraceparent} from './packages/shared-ts/src/telemetry.ts'; console.log('C='+toTraceparent(child('$PYTP')))" \
  | grep '^C=' | cut -d= -f2-)
PYTHONPATH=packages/shared-py python3 -c \
  "from olma_shared import telemetry as t; assert t.parse('$CHILD').trace_id==t.parse('$PYTP').trace_id" \
  || { echo "FAIL: traceparent trace_id not preserved across langs"; exit 1; }

echo "OK: JWT + traceparent wire-compatible across shared-py and shared-ts"
