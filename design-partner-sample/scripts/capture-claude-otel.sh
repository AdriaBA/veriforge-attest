#!/usr/bin/env bash
# Capture Claude Code OTEL into design-partner-sample/.veriforge/otel-export.json
#
# Preferred: start the tiny local OTLP HTTP capture server and point Claude Code at it.
# CI/local attest can also copy a prior real/session-shaped OTLP dump via VERIFORGE_OTEL_SOURCE.
set -euo pipefail
SAMPLE="$(cd "$(dirname "$0")/.." && pwd)"
VF="$(cd "$SAMPLE/.." && pwd)"
OUT="${OTEL_OUT:-$SAMPLE/.veriforge/otel-export.json}"
mkdir -p "$(dirname "$OUT")"

echo "VeriForge design-partner OTEL capture"
echo "  sample: $SAMPLE"
echo "  out:    $OUT"
echo

if [[ "${START_OTLP_CAPTURE:-0}" == "1" ]]; then
  exec node "$VF/scripts/capture-otlp-session.mjs" --out "$OUT" --host "${OTEL_CAPTURE_HOST:-127.0.0.1}" --port "${OTEL_CAPTURE_PORT:-4318}"
fi

if [[ -n "${VERIFORGE_OTEL_SOURCE:-}" && -f "$VERIFORGE_OTEL_SOURCE" ]]; then
  cp "$VERIFORGE_OTEL_SOURCE" "$OUT"
  echo "Copied VERIFORGE_OTEL_SOURCE → $OUT"
  exit 0
fi

if [[ "${USE_DEMO_OTLP:-0}" == "1" ]]; then
  cp "$VF/fixtures/otel/claude-code-otlp-migration.json" "$OUT"
  echo "Installed committed OTLP migration demo → $OUT"
  echo "(Set USE_DEMO_OTLP=0 and capture a live Claude Code session for production.)"
  exit 0
fi

cat <<'EOF'
Live capture (Claude Code + OTLP):

  1. Start the built-in local OTLP HTTP receiver:

       START_OTLP_CAPTURE=1 bash design-partner-sample/scripts/capture-claude-otel.sh

     It listens on http://127.0.0.1:4318/v1/traces and writes the exact received
     OTLP JSON requests to .veriforge/otel-export.json.

  2. Export env before starting Claude Code:

       export CLAUDE_CODE_ENABLE_TELEMETRY=1
       export OTEL_TRACES_EXPORTER=otlp
       export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
       export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
       export OTEL_METRICS_EXPORTER=none
       export OTEL_LOGS_EXPORTER=none

  3. In this sample repo, run a migration edit session with Claude Code
     (touch db/migrations/*). End the session so spans flush.

  4. Copy the collector dump:

       VERIFORGE_OTEL_SOURCE=/path/to/traces.json \
         bash design-partner-sample/scripts/capture-claude-otel.sh

  Offline demo (no Claude Code):

       USE_DEMO_OTLP=1 bash design-partner-sample/scripts/capture-claude-otel.sh

EOF

if [[ ! -f "$OUT" ]]; then
  echo
  echo "No OTEL export created. Start live capture with START_OTLP_CAPTURE=1,"
  echo "copy a real dump with VERIFORGE_OTEL_SOURCE, or opt into offline demo with USE_DEMO_OTLP=1."
  exit 2
fi
