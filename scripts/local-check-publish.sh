#!/usr/bin/env bash
# Local demo: attest fixtures → mock GitHub Check Run (no network / token).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${OUT:-$ROOT/veriforge-out}"
mkdir -p "$OUT"
npm run build >/dev/null

SHA="$(git rev-parse HEAD 2>/dev/null || echo 0123456789abcdef0123456789abcdef01234567)"

echo "==> Attest + mock Check Run publish"
node dist/cli.js \
  --otel fixtures/claude-otel.json \
  --ci fixtures/ci-results.json \
  --policy fixtures/policy.yaml \
  --head-sha "$SHA" \
  --repository "${GITHUB_REPOSITORY:-local/veriforge-attest}" \
  --wedge migration \
  --sign-key fixtures/signing/dev.key.pem \
  --sign-method node_dsse \
  --out "$OUT" \
  --publish-check \
  --check-mock

echo
echo "==> Publish-only re-run (PATCH-shaped mock with stable external flow)"
node dist/cli.js \
  --publish-only \
  --out "$OUT" \
  --check-mock \
  --check-name "VeriForge Attest" \
  --check-run-id 100001

echo
echo "Artifacts:"
ls -la "$OUT/github-check-summary.md" "$OUT/github-check-run.json"
echo
node -e '
const a=require(process.argv[1]);
console.log(JSON.stringify({
  mode: a.mode,
  conclusion: a.request.conclusion,
  head_sha: a.request.head_sha,
  title: a.request.output.title,
  check_run_id: a.check_run_id,
}, null, 2));
' "$OUT/github-check-run.json"

echo
echo "Done. Mock Check Run at $OUT/github-check-run.json"
echo "Live: omit --check-mock and set GITHUB_TOKEN + permissions.checks: write"
