#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runAttest, writeOutputs } from "./attest.js";
import { publishCheckFromOutDir } from "./github-checks.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      otel: { type: "string" },
      ci: { type: "string" },
      policy: { type: "string" },
      out: { type: "string", default: "./veriforge-out" },
      wedge: { type: "string" },
      "agent-name": { type: "string" },
      repository: { type: "string" },
      ref: { type: "string" },
      "base-sha": { type: "string" },
      "head-sha": { type: "string" },
      "pr-number": { type: "string" },
      "sign-key": { type: "string" },
      "cosign-key": { type: "string" },
      "cosign-keyless": { type: "boolean", default: false },
      "cosign-bin": { type: "string" },
      "sign-method": { type: "string" },
      "publish-check": { type: "boolean", default: false },
      "check-mock": { type: "boolean", default: false },
      "check-name": { type: "string" },
      "check-run-id": { type: "string" },
      "check-details-url": { type: "string" },
      "github-token": { type: "string" },
      "publish-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`veriforge-attest — build cryptographically signed in-toto Execution Receipts

Usage:
  veriforge-attest --otel ./otel.json --ci ./ci.json --policy ./policy.yaml --out ./out
  veriforge-attest --otel ./otel.json --ci ./ci.json --policy ./policy.rego --out ./out
  veriforge-attest --ci ./ci.json --head-sha abc123 --sign-key ./fixtures/signing/dev.key.pem
  veriforge-attest --ci ./ci.json --cosign-key ./cosign.key --sign-method cosign
  veriforge-attest --ci ./ci.json --sign-method cosign --cosign-keyless

GitHub Checks API (from attest bundle):
  # Local mock — writes github-check-run.json (no network)
  veriforge-attest --ci ./ci.json --head-sha abc --out ./out --publish-check --check-mock

  # Live publish (needs GITHUB_TOKEN + checks: write)
  veriforge-attest --ci ./ci.json --head-sha $SHA --repository owner/repo \\
    --publish-check --github-token "$GITHUB_TOKEN"

  # Publish-only from existing out dir
  veriforge-attest --publish-only --out ./veriforge-out --check-mock
  veriforge-attest --publish-only --out ./veriforge-out --repository owner/repo

Signing:
  --sign-key PATH       PEM PKCS#8 ECDSA P-256 private key → Node DSSE envelope
  --cosign-key PATH     Cosign private key → cosign attest-blob (+ Sigstore bundle)
  --cosign-keyless      Cosign keyless via ambient OIDC (GitHub Actions id-token: write)
  --sign-method M       none | node_dsse | cosign (auto from key flags)
  --cosign-bin PATH     Cosign binary (default: cosign on PATH)

Checks:
  --publish-check       After attest (or with --publish-only), open/update Check Run
  --check-mock          Write github-check-run.json only (local/CI dry-run)
  --check-name NAME     Check Run name (default: VeriForge Attest)
  --check-run-id ID     PATCH existing Check Run instead of POST
  --check-details-url U Optional details_url on the Check Run
  --github-token TOKEN  Or env GITHUB_TOKEN / GH_TOKEN
  --publish-only        Skip attest; publish from --out/execution-receipt.json

Environment (GitHub Actions): GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA, GITHUB_TOKEN,
  COSIGN_PASSWORD, etc. Action needs permissions.checks: write for live publish.

Outputs (in --out):
  execution-receipt.json              in-toto Statement
  execution-receipt.bundle.json       DSSE envelope (unsigned or signed)
  agent-execution-predicate.json      predicate only (for actions/attest)
  execution-receipt.sigstore.json     Cosign/Sigstore bundle (keyless OIDC or key path)
  github-check-summary.md             PR check text
  github-check-run.json               Checks API request/response (when --publish-check)
`);
    process.exit(0);
  }

  void positionals;

  const outDir = values.out!;
  const wantPublish = Boolean(values["publish-check"] || values["publish-only"]);

  if (values["publish-only"]) {
    if (!wantPublish) {
      /* always publish in publish-only */
    }
    const result = await publishCheckFromOutDir({
      outDir,
      mockDir: values["check-mock"] ? outDir : undefined,
      token: values["github-token"],
      repository: values.repository ?? process.env.GITHUB_REPOSITORY,
      checkRunId: values["check-run-id"] ? Number(values["check-run-id"]) : undefined,
      name: values["check-name"],
      detailsUrl: values["check-details-url"],
    });
    printCheckResult(result);
    return;
  }

  const pr = values["pr-number"] ? Number(values["pr-number"]) : undefined;
  const signKey = values["sign-key"];
  const cosignKey = values["cosign-key"];
  const cosignKeyless = values["cosign-keyless"] === true;
  const signMethodRaw = values["sign-method"] as
    | "none"
    | "node_dsse"
    | "cosign"
    | undefined;

  if (!values.ci && !values.otel) {
    console.error("error: provide --ci and/or --otel (or use --publish-only --out DIR)");
    process.exit(2);
  }

  const result = await runAttest({
    otelPath: values.otel,
    ciPath: values.ci,
    policyPath: values.policy,
    wedge: values.wedge as import("./types.js").AgentExecutionPredicateV01["task"]["wedge"],
    agentName: values["agent-name"],
    github: {
      repository: values.repository ?? process.env.GITHUB_REPOSITORY,
      ref: values.ref ?? process.env.GITHUB_REF,
      base_sha: values["base-sha"] ?? process.env.GITHUB_BASE_SHA,
      head_sha: values["head-sha"] ?? process.env.GITHUB_SHA,
      pr_number:
        pr ??
        (process.env.GITHUB_PULL_REQUEST
          ? Number(process.env.GITHUB_PULL_REQUEST)
          : undefined),
      workflow: process.env.GITHUB_WORKFLOW,
    },
    sign:
      signKey || cosignKey || cosignKeyless || signMethodRaw
        ? {
            privateKeyPath: signKey,
            cosignKeyPath: cosignKey,
            cosignKeyless,
            cosignBin: values["cosign-bin"],
            method: signMethodRaw ?? (cosignKey || cosignKeyless ? "cosign" : signKey ? "node_dsse" : "none"),
            workDir: outDir,
          }
        : undefined,
  });

  await writeOutputs(outDir, result.statementJson, result.bundle, result.checkSummary, {
    statement: result.statement,
    predicate: result.statement.predicate,
    sigstoreBundlePath: result.sigstoreBundlePath,
  });

  console.log(result.checkSummary);
  console.log(`\nWrote: ${outDir}/execution-receipt.json`);
  console.log(`Signing: ${result.signingMethod}${result.keyId ? ` keyid=${result.keyId}` : ""}`);
  if (result.sigstoreBundlePath) {
    console.log(`Sigstore bundle: ${outDir}/execution-receipt.sigstore.json`);
  }

  if (wantPublish) {
    const check = await publishCheckFromOutDir({
      outDir,
      mockDir: values["check-mock"] ? outDir : undefined,
      token: values["github-token"],
      repository:
        values.repository ??
        result.statement.predicate.source.repository ??
        process.env.GITHUB_REPOSITORY,
      checkRunId: values["check-run-id"] ? Number(values["check-run-id"]) : undefined,
      name: values["check-name"],
      detailsUrl: values["check-details-url"],
      signingMethod: result.signingMethod,
      keyId: result.keyId,
    });
    printCheckResult(check);
  }
}

function printCheckResult(result: {
  mode: string;
  check_run_id?: number;
  html_url?: string;
  mock_path?: string;
  request: { conclusion?: string; head_sha: string; name: string };
}): void {
  console.log(`\nGitHub Check Run (${result.mode}):`);
  console.log(`  name: ${result.request.name}`);
  console.log(`  head_sha: ${result.request.head_sha}`);
  console.log(`  conclusion: ${result.request.conclusion}`);
  if (result.check_run_id != null) console.log(`  id: ${result.check_run_id}`);
  if (result.html_url) console.log(`  url: ${result.html_url}`);
  if (result.mock_path) console.log(`  artifact: ${result.mock_path}`);
  else console.log(`  artifact: github-check-run.json (under --out)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
