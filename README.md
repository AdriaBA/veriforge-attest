# @veriforge/attest (v0.5)

TypeScript CLI and GitHub Action for **VeriForge Attest**: compose factual evidence from Claude Code OpenTelemetry exports and CI job results into an [in-toto](https://github.com/in-toto/attestation) Statement using predicate `https://veriforge.dev/predicates/agent-execution/v0.1`, **sign** the DSSE envelope (Node ECDSA P-256 and/or Cosign) or bind it via **GitHub artifact attestations**, and **publish a GitHub Check Run** so PRs show pass/fail/review from the attest bundle.

Aligned with [[VeriForge Thesis v4.0]]: attest-only, explicit assurance classes, no invented scores.

## Design-partner path (migration wedge, v0.4)

End-to-end sample under `design-partner-sample/`: real **OTLP JSON** Claude Code–shaped OTEL + migration CI → receipt → Check Run.

```bash
npm ci && npm run build && npm test
npm run partner-e2e
# → design-partner-sample/.veriforge/out/{execution-receipt,github-check-run}.json
```

For a live/local session, start the built-in OTLP HTTP capture before launching Claude Code:

```bash
npm run capture-otlp
# in the Claude Code shell:
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none
```

The capture writes exact received OTLP requests to `design-partner-sample/.veriforge/otel-export.jsonl`; `runAttest` ingests that JSONL directly. See `design-partner-sample/README.md` for the CI/local partner flow. The committed `fixtures/otel/claude-code-otlp-migration.json` remains an offline CI demo, not a fabricated trust score.

## Policy-as-code compiler spike (Rego)

`fixtures/policy.rego` is a minimal Rego-shaped policy over the existing CI evidence fixture. The compiler intentionally supports only factual `block[...]` / `review[...]` rules that call `evidence_outcome("<evidence id>", "<outcome>")`; it lowers those rules into the existing VeriForge policy evaluator, with no statistical ranking layer.

```bash
npm run policy-demo
# → veriforge-out/policy-demo/{execution-receipt,agent-execution-predicate,github-check-summary}.json/.md
```

The committed demo fixture reviews when `dependency_scan` fails and blocks when `unit_tests` fails.

## Quick start (local, unsigned)

```bash
npm ci && npm run build && npm test
npm run attest -- \
  --otel fixtures/claude-otel.json \
  --ci fixtures/ci-results.json \
  --policy fixtures/policy.yaml \
  --head-sha $(git rev-parse HEAD) \
  --wedge migration \
  --out ./veriforge-out
```

## Signed path (local, Node DSSE)

Cryptographic assurance without Cosign — ECDSA P-256 DSSE over the full in-toto Statement:

```bash
# one-shot demo (generates fixtures/signing/dev.*.pem if missing)
bash scripts/local-signed-attest.sh

# or explicit
npm run build
node dist/cli.js \
  --otel fixtures/claude-otel.json \
  --ci fixtures/ci-results.json \
  --policy fixtures/policy.yaml \
  --head-sha $(git rev-parse HEAD) \
  --sign-key fixtures/signing/dev.key.pem \
  --sign-method node_dsse \
  --out ./veriforge-out
```

Verify:

```bash
node --import tsx -e '
  import { readFileSync } from "node:fs";
  import { verifyDsseEnvelope } from "./src/sign.ts";
  const env = JSON.parse(readFileSync("veriforge-out/execution-receipt.bundle.json","utf8"));
  console.log(verifyDsseEnvelope(env, readFileSync("fixtures/signing/dev.pub.pem","utf8")));
'
```

## Signed path (local/dev, Cosign key)

Requires [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/) on PATH. This path is for offline/local development or legacy CI only; GitHub Actions should prefer the keyless OIDC path below.

```bash
cd fixtures/signing
COSIGN_PASSWORD= cosign generate-key-pair   # writes cosign.key / cosign.pub
cd ../..
export COSIGN_PASSWORD=
node dist/cli.js \
  --ci fixtures/ci-results.json \
  --otel fixtures/claude-otel.json \
  --policy fixtures/policy.yaml \
  --head-sha $(git rev-parse HEAD) \
  --cosign-key fixtures/signing/cosign.key \
  --sign-method cosign \
  --out ./veriforge-out
# → execution-receipt.sigstore.json (Sigstore bundle with dsseEnvelope)
```

Dev keys under `fixtures/signing/` are **not** for production.

## Signed path (CI, Cosign keyless via GitHub OIDC)

In GitHub Actions, prefer keyless Cosign: grant `id-token: write`, do **not** store `cosign.key` in secrets, and let Cosign obtain the ambient GitHub OIDC identity for Sigstore/Fulcio.

```yaml
permissions:
  contents: read
  checks: write
  id-token: write        # required for Cosign keyless/OIDC
  attestations: write    # required if github_attest: "true"

- uses: ./03-Projects/veriforge-attest  # or published path
  with:
    ci_results_path: ./ci-results.json
    otel_path: ./otel-export.json
    policy_path: ./policy.yaml
    publish_check: "true"
    cosign_keyless: "true"   # cosign attest-blob without --key, via ambient OIDC
    github_attest: "true"    # optional GitHub artifact attestation over the same predicate
```

The composite action installs Cosign when `cosign_keyless` or `cosign_key` is set. For local dry-runs that cannot mint a GitHub OIDC token, use `check_mock: "true"` and either leave signing unsigned or use the local Node DSSE / Cosign key paths above.

## GitHub Checks API (v0.3)

Publish verification outcome as a [Check Run](https://docs.github.com/en/rest/checks/runs) from the attest bundle (uses `execution-receipt.json` + `github-check-summary.md`).

| Policy decision | Check conclusion   |
|-----------------|--------------------|
| `allow`         | `success`          |
| `block`         | `failure`          |
| `review`        | `action_required`  |
| (missing)       | `neutral`          |

### Local mock (no token / network)

```bash
npm run check-demo
# or
node dist/cli.js \
  --otel fixtures/claude-otel.json \
  --ci fixtures/ci-results.json \
  --policy fixtures/policy.yaml \
  --head-sha $(git rev-parse HEAD) \
  --repository local/veriforge-attest \
  --out ./veriforge-out \
  --publish-check --check-mock
# → veriforge-out/github-check-run.json
```

Publish-only from an existing out dir:

```bash
node dist/cli.js --publish-only --out ./veriforge-out --check-mock
# update existing run id (PATCH):
node dist/cli.js --publish-only --out ./veriforge-out --check-mock --check-run-id 100001
```

### Live (GitHub)

Needs `GITHUB_TOKEN` (or `GH_TOKEN`) with **`checks: write`**, plus `head_sha` and `owner/repo`.

```bash
export GITHUB_TOKEN=...   # fine-grained or GITHUB_TOKEN in Actions
node dist/cli.js --publish-only --out ./veriforge-out \
  --repository owner/repo
```

In Actions the composite action defaults `publish_check: true` and uses `github.token`.

## Outputs

| File | Purpose |
|------|---------|
| `execution-receipt.json` | in-toto Statement |
| `execution-receipt.bundle.json` | DSSE envelope (unsigned placeholder or real ECDSA/Cosign sig) |
| `agent-execution-predicate.json` | Predicate only — input for `actions/attest` |
| `execution-receipt.sigstore.json` | Cosign/Sigstore bundle (keyless OIDC or local Cosign key path) |
| `github-check-summary.md` | Factual check text for PR review |
| `github-check-run.json` | Checks API request + response (mock or live) |

When signed, predicate includes `provenance.signing` of `node_dsse` | `cosign_key` | `sigstore` and evidence item `receipt_signature` with `assurance: cryptographic`.

## GitHub Action

```yaml
permissions:
  contents: read
  checks: write
  id-token: write      # if cosign_keyless or github_attest
  attestations: write  # if github_attest

- uses: ./03-Projects/veriforge-attest  # or published path
  with:
    ci_results_path: ./ci-results.json
    otel_path: ./otel-export.json
    policy_path: ./policy.yaml
    wedge: dependency_upgrade
    publish_check: "true"
    check_name: VeriForge Attest
    # Optional Node DSSE:
    # sign_key: ${{ runner.temp }}/veriforge.key.pem
    # Preferred CI Cosign signing (OIDC, no long-lived cosign.key):
    cosign_keyless: "true"
    # GitHub artifact attestation (OIDC, actions/attest):
    github_attest: "true"
    # Dry-run Checks:
    # check_mock: "true"
```

Outputs: `receipt_dir`, `bundle_path`, `check_run_id`, `check_conclusion`.

Reference workflow fixture: `fixtures/gha/workflow-signed-attest.yml`.

### GitHub artifact attestations

With `github_attest: true` the composite action calls [`actions/attest`](https://github.com/actions/attest) binding:

- **subject**: `execution-receipt.json`
- **predicate-type**: `https://veriforge.dev/predicates/agent-execution/v0.1`
- **predicate**: `agent-execution-predicate.json`

This yields `provenance`-style cryptographic identity via GitHub OIDC (`github_oidc` / Sigstore under the hood on GitHub’s side).

Live validation fixture: `fixtures/gha/live/` captures a verified production GitHub artifact attestation from `cli/cli` and documents the field comparison against VeriForge `agent-execution/v0.1`. The key finding is that GitHub stores the same in-toto Statement slots (`_type`, `subject[]`, `predicateType`, `predicate`) VeriForge emits; no schema/adapter change was required. The modern repository attestations API returns an expiring `bundle_url`, so importers should use `gh attestation verify --format json` or fetch and verify that bundle URL before reading the statement.

## CI results JSON shape

```json
{
  "unit_tests": "passed|failed|skipped|not_run",
  "lint": "passed|failed|not_run",
  "sast": "passed|failed|not_run",
  "dependency_scan": "passed|failed|not_run",
  "migration_forward": "passed|failed|skipped|not_run",
  "migration_rollback": "passed|failed|skipped|not_run",
  "sources": { "unit_tests": "github-actions:jest" }
}
```

## OTEL input shapes

| Input | Notes |
|-------|--------|
| OTLP JSON `resourceSpans` | Claude Code / collector — attributes as `[{key,value:{stringValue}}]` |
| JSONL of OTLP objects | File dumps from collectors or `npm run capture-otlp` |
| Flat attribute maps | Legacy `fixtures/claude-otel.json` |

Recognized session keys: `claude_code.session.id`, `claude.session_id`, `gen_ai.conversation.id`.  
Path keys: `file.path`, `code.file.path`, `claude_code.tool.file_path`, …  
Committed OTLP demo: `fixtures/otel/claude-code-otlp-migration.json`.

## Next steps

- Replace the local/mock GitHub Check publish with a partner repository token path once a design partner is ready.
