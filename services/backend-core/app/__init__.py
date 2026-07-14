"""Package bootstrap.

The shared packages (`olma_shared`, `olma_errors`) are not pip-installed in this
monorepo, so put them on `sys.path` here. Because this runs on *any* `import
app.*`, it bootstraps both pytest and uvicorn without extra wiring (§8.2).
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
