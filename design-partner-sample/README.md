# Design-partner sample — migration wedge

Minimal consumer repo that wires **real Claude Code OTEL** (OTLP JSON) through
`@veriforge/attest` → signed Execution Receipt → GitHub Check Run.

This is the path design partners copy. It is intentionally small: one SQL
migration, migration CI facts, policy, and a documented OTEL capture flow.

## Layout

```
design-partner-sample/
  README.md
  db/
    schema.sql
    migrations/
      20260718_add_billing_accounts.sql
      20260718_add_billing_accounts_down.sql
  .veriforge/
    policy.yaml
    ci-results.json          # written by CI or local scripts
    otel-export.json/.jsonl  # from Claude Code capture; demo only when USE_DEMO_OTLP=1
  .github/workflows/
    veriforge-migration.yml
  scripts/
    capture-claude-otel.sh
    run-migration-ci.sh
    e2e-local.sh
```

## Acceptance path (local, no GitHub token)

From the **veriforge-attest** package root:

```bash
bash design-partner-sample/scripts/e2e-local.sh
# → design-partner-sample/.veriforge/out/
#    execution-receipt.json
#    github-check-run.json   (mock Check conclusion)
```

Expect:

- Predicate `task.wedge` = `migration`
- `agent.session_id` from OTEL (`claude_code.session.id` / conversation id)
- `execution.files_touched` includes migration SQL paths
- Evidence `agent_otel_trace` with `source: otlp-json` (real OTLP encoding)
- Evidence `migration_forward` + `migration_rollback` from CI JSON
- Check conclusion from policy (demo CI → `success` / `allow`)

## Capture real Claude Code OTEL (partner machine)

Claude Code can export OpenTelemetry. Typical env (see Anthropic Claude Code
telemetry docs for current knobs):

```bash
# Terminal 1 — built-in OTLP HTTP receiver; writes JSONL directly ingestible by runAttest
START_OTLP_CAPTURE=1 bash design-partner-sample/scripts/capture-claude-otel.sh

# Terminal 2 — Claude Code exports traces to that receiver
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Then run a migration task in Claude Code against this sample (`db/migrations/…`),
stop the session, and point attest at the dump:

```bash
node dist/cli.js \
  --otel design-partner-sample/.veriforge/otel-export.json \
  --ci design-partner-sample/.veriforge/ci-results.json \
  --policy design-partner-sample/.veriforge/policy.yaml \
  --wedge migration \
  --head-sha "$(git rev-parse HEAD)" \
  --repository "$GITHUB_REPOSITORY" \
  --sign-key fixtures/signing/dev.key.pem \
  --out design-partner-sample/.veriforge/out \
  --publish-check --check-mock
```

### What “non-synthetic” means here

| Artifact | Role |
|----------|------|
| `fixtures/claude-otel.json` | Legacy **flat** mini fixture (unit tests) |
| `fixtures/otel/claude-code-otlp-migration.json` | **OTLP JSON** multi-span export matching Claude Code attribute conventions (design-partner demo committed for CI/offline) |
| Partner-captured `.veriforge/otel-export.json` / `.jsonl` | Live OTLP session dump from `scripts/capture-otlp-session.mjs` or a partner collector — preferred in production |

The adapter accepts both flat maps and OTLP `[{key,value:{stringValue}}]` attributes,
JSON or JSONL. The capture path preserves the received OTLP payload; VeriForge only reports factual spans/files/session evidence and does not compute or invent trust scores.

## CI (GitHub Actions)

Copy `.github/workflows/veriforge-migration.yml` into the partner repo and point
`uses:` at the published action (or path). Workflow:

1. Run migration forward/rollback checks → write `.veriforge/ci-results.json`
2. Download or commit OTEL export artifact from the agent job
3. Call VeriForge Attest with `wedge: migration`, `publish_check: true`

## Policy (migration wedge)

See `.veriforge/policy.yaml`: block on failed unit/migration tests; review on
failed dependency scan.

## Related

- Package README: `../README.md`
- [[VeriForge Attest MVP]]
- [[VeriForge Thesis v4.0]]
