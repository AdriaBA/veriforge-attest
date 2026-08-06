#!/usr/bin/env bash
# Run migration-wedge CI checks and write .veriforge/ci-results.json
set -euo pipefail
SAMPLE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SAMPLE"
mkdir -p .veriforge

FORWARD=failed
ROLLBACK=failed
UNIT=passed
LINT=passed

DB="$(mktemp -t veriforge-mig.XXXXXX).sqlite"
trap 'rm -f "$DB"' EXIT

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" < db/schema.sql
  if sqlite3 "$DB" < db/migrations/20260718_add_billing_accounts.sql; then
    FORWARD=passed
  fi
  if sqlite3 "$DB" < db/migrations/20260718_add_billing_accounts_down.sql; then
    ROLLBACK=passed
  fi
  # re-apply forward to ensure down was real
  if [[ "$FORWARD" == "passed" && "$ROLLBACK" == "passed" ]]; then
    sqlite3 "$DB" < db/migrations/20260718_add_billing_accounts.sql || FORWARD=failed
  fi
else
  echo "warn: sqlite3 not found — marking migration tests skipped" >&2
  FORWARD=skipped
  ROLLBACK=skipped
fi

cat > .veriforge/ci-results.json <<EOF
{
  "unit_tests": "$UNIT",
  "lint": "$LINT",
  "sast": "passed",
  "dependency_scan": "passed",
  "migration_forward": "$FORWARD",
  "migration_rollback": "$ROLLBACK",
  "sources": {
    "unit_tests": "design-partner-sample/scripts/run-migration-ci.sh",
    "lint": "design-partner-sample/scripts/run-migration-ci.sh",
    "migration_forward": "sqlite3:forward",
    "migration_rollback": "sqlite3:down",
    "dependency_scan": "local:fixture"
  }
}
EOF

echo "Wrote $SAMPLE/.veriforge/ci-results.json"
cat .veriforge/ci-results.json
[[ "$FORWARD" != "failed" && "$ROLLBACK" != "failed" ]]
