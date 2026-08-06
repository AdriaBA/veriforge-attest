#!/usr/bin/env bash
# Local signed attest demo: Node DSSE (default) and optional Cosign.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${OUT:-$ROOT/veriforge-out}"
SIGNING_DIR="$ROOT/fixtures/signing"
mkdir -p "$SIGNING_DIR" "$OUT"

if [[ ! -f "$SIGNING_DIR/dev.key.pem" ]]; then
  echo "Generating dev ECDSA P-256 keypair in fixtures/signing/ (NOT for production)"
  node --import tsx -e '
    import { writeFileSync } from "node:fs";
    import { generateDevKeyPair } from "./src/sign.ts";
    const { privateKeyPem, publicKeyPem } = generateDevKeyPair();
    writeFileSync("fixtures/signing/dev.key.pem", privateKeyPem);
    writeFileSync("fixtures/signing/dev.pub.pem", publicKeyPem);
    console.log("wrote fixtures/signing/dev.{key,pub}.pem");
  '
fi

npm run build >/dev/null

echo "==> Node DSSE signed attest"
node dist/cli.js \
  --otel fixtures/claude-otel.json \
  --ci fixtures/ci-results.json \
  --policy fixtures/policy.yaml \
  --head-sha "$(git rev-parse HEAD 2>/dev/null || echo localdev)" \
  --wedge migration \
  --sign-key "$SIGNING_DIR/dev.key.pem" \
  --sign-method node_dsse \
  --out "$OUT"

echo
echo "Bundle signatures:"
node -e 'const b=require(process.argv[1]); console.log(JSON.stringify(b.signatures,null,2))' "$OUT/execution-receipt.bundle.json"

echo
echo "==> Verify DSSE with public key"
node --import tsx -e '
  import { readFileSync } from "node:fs";
  import { verifyDsseEnvelope } from "./src/sign.ts";
  const env = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const pub = readFileSync(process.argv[2], "utf8");
  const ok = verifyDsseEnvelope(env, pub);
  console.log(ok ? "VERIFY OK" : "VERIFY FAIL");
  process.exit(ok ? 0 : 1);
' "$OUT/execution-receipt.bundle.json" "$SIGNING_DIR/dev.pub.pem"

if command -v cosign >/dev/null 2>&1; then
  if [[ -f "$SIGNING_DIR/cosign.key" ]]; then
    echo
    echo "==> Cosign attest-blob path"
    export COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"
    node dist/cli.js \
      --otel fixtures/claude-otel.json \
      --ci fixtures/ci-results.json \
      --policy fixtures/policy.yaml \
      --head-sha "$(git rev-parse HEAD 2>/dev/null || echo localdev)" \
      --wedge migration \
      --cosign-key "$SIGNING_DIR/cosign.key" \
      --sign-method cosign \
      --out "$OUT/cosign"
    echo "Sigstore bundle: $OUT/cosign/execution-receipt.sigstore.json"
  else
    echo
    echo "(optional) Generate Cosign keys: COSIGN_PASSWORD= cosign generate-key-pair -d fixtures/signing"
    echo "Then re-run this script for the Cosign path."
  fi
else
  echo
  echo "cosign not on PATH — Node DSSE path only (install: brew install cosign)"
fi

echo
echo "Done. Outputs under $OUT"
