#!/usr/bin/env bash
# E2E: OTLP OTEL (migration) + CI → signed receipt → mock GitHub Check Run
set -euo pipefail
SAMPLE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SAMPLE/.." && pwd)"
cd "$ROOT"

OUT="${OUT:-$SAMPLE/.veriforge/out}"
mkdir -p "$OUT" "$SAMPLE/.veriforge"

echo "==> 1/4 Capture / install OTEL export (OTLP)"
USE_DEMO_OTLP="${USE_DEMO_OTLP:-1}" bash "$SAMPLE/scripts/capture-claude-otel.sh"
OTEL="$SAMPLE/.veriforge/otel-export.json"
test -f "$OTEL"

echo
echo "==> 2/4 Migration CI facts"
bash "$SAMPLE/scripts/run-migration-ci.sh"

echo
echo "==> 3/4 Build veriforge-attest"
npm run build >/dev/null

SHA="$(git rev-parse HEAD 2>/dev/null || echo 0123456789abcdef0123456789abcdef01234567)"
REPO="${GITHUB_REPOSITORY:-local/design-partner-migration}"

echo
echo "==> 4/4 Attest + mock Check Run (wedge=migration)"
node dist/cli.js \
  --otel "$OTEL" \
  --ci "$SAMPLE/.veriforge/ci-results.json" \
  --policy "$SAMPLE/.veriforge/policy.yaml" \
  --head-sha "$SHA" \
  --repository "$REPO" \
  --wedge migration \
  --agent-name claude-code \
  --sign-key fixtures/signing/dev.key.pem \
  --sign-method node_dsse \
  --out "$OUT" \
  --publish-check \
  --check-mock

echo
echo "==> Verify acceptance facts"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const out = process.argv[1];
const stmt = JSON.parse(readFileSync(out + "/execution-receipt.json", "utf8"));
const check = JSON.parse(readFileSync(out + "/github-check-run.json", "utf8"));
const p = stmt.predicate;
const files = p.execution?.files_touched ?? [];
const otelEv = (p.evidence ?? []).find((e) => e.id === "agent_otel_trace");
const migF = (p.evidence ?? []).find((e) => e.id === "migration_forward");
const migR = (p.evidence ?? []).find((e) => e.id === "migration_rollback");
const fail = [];
if (p.task?.wedge !== "migration") fail.push("wedge!=migration");
if (!p.agent?.session_id) fail.push("missing session_id");
if (!files.some((f) => String(f).includes("migrations"))) fail.push("no migration paths in files_touched");
if (!otelEv || otelEv.source !== "otlp-json") fail.push("agent_otel_trace not otlp-json");
if (!migF || migF.outcome === "failed") fail.push("migration_forward bad");
if (!migR || migR.outcome === "failed") fail.push("migration_rollback bad");
if (!check.request?.conclusion) fail.push("no check conclusion");
if (p.provenance?.signing !== "node_dsse") fail.push("not signed");
const summary = {
  ok: fail.length === 0,
  wedge: p.task?.wedge,
  session_id: p.agent?.session_id,
  model: p.agent?.model_identifier?.value,
  files_touched: files,
  otel: otelEv?.detail,
  policy: p.policy?.decision,
  check_conclusion: check.request?.conclusion,
  check_run_id: check.check_run_id,
  failures: fail,
};
console.log(JSON.stringify(summary, null, 2));
if (fail.length) process.exit(1);
' "$OUT"

echo
echo "PASS: design-partner migration wedge E2E"
echo "Artifacts: $OUT"
ls -la "$OUT/execution-receipt.json" "$OUT/github-check-run.json" "$OUT/github-check-summary.md"
