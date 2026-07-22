#!/usr/bin/env bash
# Run the SQLLogic (haybarn) suite in test/sql/ against the TypeScript worker, using the
# haybarn DuckDB distribution's unittest runner (which loads the `vgi` extension from the
# community repository).
#
# Prerequisites (one-time):
#   uv tool install haybarn-unittest                      # the DuckDB unittest binary
#   echo "INSTALL vgi FROM community;" | uvx haybarn-cli  # install the vgi extension
#   echo "INSTALL icu;" | uvx haybarn-cli                 # CURRENT_DATE (history.test)
#   bun install                                           # the worker's deps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

UNITTEST="${VGI_UNITTEST:-$(command -v haybarn-unittest || true)}"
if [[ -z "$UNITTEST" || ! -x "$UNITTEST" ]]; then
    echo "ERROR: haybarn-unittest not found. Install it with:" >&2
    echo "       uv tool install haybarn-unittest" >&2
    exit 1
fi

# Ensure the vgi community extension is installed for this haybarn version.
if ! echo "LOAD vgi;" | uvx haybarn-cli >/dev/null 2>&1; then
    echo "==> Installing vgi extension from community repository"
    echo "INSTALL vgi FROM community;" | uvx haybarn-cli
fi

# history.test needs CURRENT_DATE, which lives in icu. The unittest binary neither bundles
# nor autoloads it (the DuckDB CLI and client libraries do, so the worker's own doc examples
# need no LOAD), so install it into the shared extension dir for `LOAD icu;` to resolve.
# INSTALL is a no-op when the extension is already present, so this is safe to run always —
# don't guard it on `LOAD icu` through haybarn-cli, which autoloads and would report success
# even with nothing installed for the unittest binary to find.
echo "INSTALL icu;" | uvx haybarn-cli >/dev/null

# NOTE: the last arg is a Catch2 test-name filter, not a shell glob. Catch2 only honors a
# trailing `*` wildcard, so use `test/sql/*` (not `test/sql/*.test`).
WORKER="$REPO_ROOT/bin/vgi-etf-vanguard-worker"
TEST_GLOB="${1:-test/sql/*}"

echo "==> Running SQLLogic tests"
echo "    worker:   $WORKER"
echo "    unittest: $UNITTEST"
echo "    tests:    $TEST_GLOB"

VGI_TEST_WORKER="$WORKER" \
VGI_WORKER_CATALOG_NAME="vanguard" \
    "$UNITTEST" --test-dir "$REPO_ROOT" "$TEST_GLOB"
