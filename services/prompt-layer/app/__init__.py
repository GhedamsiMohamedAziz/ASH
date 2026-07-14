"""prompt-layer package bootstrap.

Put the monorepo shared packages on sys.path without an install step (AX-008
codegen/CI replaces this). Runs on any `import app.*`, so both pytest and uvicorn
pick up olma_shared and olma_errors.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
for _pkg in (
    _ROOT / "packages" / "shared-py",
    _ROOT / "packages" / "errors" / "dist" / "python",
):
    _p = str(_pkg)
    if _p not in sys.path:
        sys.path.insert(0, _p)
