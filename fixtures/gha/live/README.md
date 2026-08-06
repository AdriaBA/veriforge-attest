# Live GitHub artifact attestation fixture

This fixture validates VeriForge's receipt/predicate model against a real GitHub artifact attestation from the public `cli/cli` repository, not only local mocks.

## Source payload

Artifact: `gh_2.50.0_windows_arm64.zip`
Repository: `cli/cli`
Subject digest: `sha256:8aad120b416386b4269ef62c8fdebcad31a70847297817a149daf927edc85548`
Workflow: `https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk`
Run: `https://github.com/cli/cli/actions/runs/9289075752/attempts/1`

Captured with:

```bash
gh release download v2.50.0 -R cli/cli \
  -p gh_2.50.0_windows_arm64.zip \
  -D /tmp/veriforge-live-attestation

gh attestation verify \
  /tmp/veriforge-live-attestation/gh_2.50.0_windows_arm64.zip \
  -R cli/cli \
  --format json

gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  /repos/cli/cli/attestations/sha256:8aad120b416386b4269ef62c8fdebcad31a70847297817a149daf927edc85548
```

## Files

- `github-cli-attestation-response.json` — sanitized repository attestation API response shape. The live API returned `repository_id`, `bundle_url`, and `initiator`; the expiring signed `bundle_url` query string is redacted.
- `github-cli-attestation-statement.json` — decoded in-toto Statement from `gh attestation verify --format json`.
- `github-cli-attestation-summary.json` — field comparison against VeriForge `agent-execution/v0.1`.

## Field comparison

GitHub's verified payload is a standard in-toto Statement:

- `_type`: `https://in-toto.io/Statement/v1`
- `subject[]`: artifact name plus SHA-256 digest
- `predicateType`: `https://slsa.dev/provenance/v1` for this production GitHub CLI release
- `predicate`: SLSA `buildDefinition` and `runDetails`

This validates VeriForge's shape: `execution-receipt.json` also uses `_type`, `subject[]`, `predicateType`, and `predicate`; GitHub artifact attestations support freeform predicate types, so `https://veriforge.dev/predicates/agent-execution/v0.1` fits the same slot.

Observed gaps / follow-ups:

1. Modern `GET /repos/{owner}/{repo}/attestations/{subject_digest}` returns an expiring `bundle_url`, not an inline bundle. Any future importer should fetch and verify the bundle URL or consume `gh attestation verify --format json` output.
2. GitHub SLSA provenance uses `buildDefinition` / `runDetails`; VeriForge `agent-execution/v0.1` uses `source` / `task` / `agent` / `execution` / `evidence` / `policy` / `provenance`. This is expected for different predicate types and does not require an adapter/schema change.
3. Only `verificationResult.signature.certificate` and `verifiedTimestamps` are non-user-controllable; do not treat `statement.predicate` alone as cryptographic truth.

Adapter change required: no.
