import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { createPublicKey } from "node:crypto";
import YAML from "yaml";
import {
  agentFactsFromOtel,
  evidenceFromCi,
  parseOtelText,
  type CiResultsInput,
} from "./adapters.js";
import { subjectForCommit } from "./digest.js";
import { compileRegoPolicy, evaluatePolicy, type PolicyFile } from "./policy.js";
import {
  buildPredicateBase,
  buildStatement,
  buildUnsignedBundle,
  statementToJson,
} from "./receipt.js";
import {
  signStatement,
  publicKeyIdFromPem,
  type SignOptions,
  type SigningMethod,
} from "./sign.js";
import type { AgentExecutionPredicateV01, DsseEnvelope, InTotoStatement } from "./types.js";

export interface AttestInputs {
  otelPath?: string;
  ciPath?: string;
  policyPath?: string;
  github?: {
    repository?: string;
    ref?: string;
    base_sha?: string;
    head_sha?: string;
    pr_number?: number;
    workflow?: string;
  };
  wedge?: AgentExecutionPredicateV01["task"]["wedge"];
  agentName?: string;
  /** Cryptographic signing (node DSSE or Cosign) */
  sign?: SignOptions;
}

export interface AttestResult {
  statement: InTotoStatement;
  statementJson: string;
  bundle: DsseEnvelope;
  checkSummary: string;
  signingMethod: SigningMethod;
  sigstoreBundlePath?: string;
  keyId?: string;
}

function resolveMethod(sign?: SignOptions): SigningMethod {
  if (!sign) return "none";
  if (sign.method && sign.method !== "none") return sign.method;
  if (sign.cosignKeyPath || sign.cosignKeyless) return "cosign";
  if (sign.privateKeyPath || sign.privateKeyPem) return "node_dsse";
  return "none";
}

function provenanceSigning(
  method: SigningMethod,
  sign?: SignOptions
): NonNullable<AgentExecutionPredicateV01["provenance"]>["signing"] {
  if (method === "node_dsse") return "node_dsse";
  if (method === "cosign" && !sign?.cosignKeyPath && !sign?.privateKeyPath) return "sigstore";
  if (method === "cosign") return "cosign_key";
  return "unsigned";
}

async function resolveKeyId(sign: SignOptions, method: SigningMethod): Promise<string | undefined> {
  if (sign.keyId) return sign.keyId;
  if (method !== "node_dsse") return undefined;
  try {
    let pem = sign.privateKeyPem;
    if (!pem && sign.privateKeyPath) pem = await readFile(sign.privateKeyPath, "utf8");
    if (!pem) return undefined;
    const pub = createPublicKey(pem);
    return publicKeyIdFromPem(pub.export({ type: "spki", format: "pem" }).toString());
  } catch {
    return undefined;
  }
}

export async function runAttest(inputs: AttestInputs): Promise<AttestResult> {
  let otelSpans: ReturnType<typeof parseOtelText> = [];
  if (inputs.otelPath) {
    // JSON or JSONL (Claude Code / collector dump)
    otelSpans = parseOtelText(await readFile(inputs.otelPath, "utf8"));
  }

  let ci: CiResultsInput = {};
  if (inputs.ciPath) {
    ci = JSON.parse(await readFile(inputs.ciPath, "utf8")) as CiResultsInput;
  }

  const agentFacts = agentFactsFromOtel(otelSpans);
  const evidence = evidenceFromCi(ci);

  if (agentFacts.span_count > 0) {
    evidence.push({
      id: "agent_otel_trace",
      kind: "agent_execution",
      outcome: "passed",
      assurance: "observed",
      source: agentFacts.otlp_encoded ? "otlp-json" : "otel-flat",
      detail: `${agentFacts.span_count} spans; encoding=${agentFacts.otlp_encoded ? "otlp" : "flat"}`,
      metadata: {
        span_count: agentFacts.span_count,
        otlp_encoded: agentFacts.otlp_encoded,
      },
    });
  }

  if (agentFacts.files_touched.length) {
    evidence.push({
      id: "agent_files_touched",
      kind: "agent_execution",
      outcome: "passed",
      assurance: "observed",
      detail: `${agentFacts.files_touched.length} paths from OTEL`,
    });
  }

  let policyResult: AgentExecutionPredicateV01["policy"] = {
    version: 1,
    decision: "allow",
    reasons: [],
  };
  if (inputs.policyPath) {
    const policyText = await readFile(inputs.policyPath, "utf8");
    const policy = extname(inputs.policyPath) === ".rego"
      ? compileRegoPolicy(policyText)
      : (YAML.parse(policyText) as PolicyFile);
    policyResult = evaluatePolicy(policy, evidence);
  }

  const method = resolveMethod(inputs.sign);
  const keyId = inputs.sign ? await resolveKeyId(inputs.sign, method) : undefined;

  if (method !== "none") {
    evidence.push({
      id: "receipt_signature",
      kind: "signature",
      outcome: "passed",
      assurance: "cryptographic",
      source: method === "cosign" ? "cosign" : "node_dsse",
      detail:
        keyId ?? (method === "cosign" && !inputs.sign?.cosignKeyPath && !inputs.sign?.privateKeyPath)
          ? `keyid=${keyId ?? "ambient-oidc"}`
          : `method=${method}`,
    });
  }

  const gh = inputs.github ?? {};
  const head = gh.head_sha ?? "unknown";
  const predicate = buildPredicateBase({
    source: {
      repository: gh.repository,
      ref: gh.ref,
      base_commit: gh.base_sha,
      head_commit: head,
      pull_request: gh.pr_number,
    },
    task: {
      workflow: gh.workflow ?? "veriforge-attest",
      wedge: inputs.wedge ?? "other",
    },
    agent: {
      name: inputs.agentName ?? "claude-code",
      session_id: agentFacts.session_id,
      model_identifier: agentFacts.model_identifier,
    },
    execution: {
      files_touched: agentFacts.files_touched,
    },
    evidence,
    policy: policyResult,
    provenance: {
      signing: provenanceSigning(method, inputs.sign),
      key_id: keyId,
      note:
        method === "cosign"
          ? "Cosign-signed DSSE / Sigstore bundle (cryptographic assurance)."
          : method === "node_dsse"
            ? "Node DSSE ECDSA P-256 signature (cryptographic assurance)."
            : undefined,
    },
  });

  const subject = subjectForCommit(head);
  const statement = buildStatement({
    predicate,
    subjectName: subject.name,
    subjectDigest: subject.digest,
  });

  let bundle: DsseEnvelope = buildUnsignedBundle(statement);
  let signingMethod: SigningMethod = "none";
  let sigstoreBundlePath: string | undefined;
  let finalKeyId = keyId;

  if (inputs.sign && method !== "none") {
    const signed = await signStatement(statement, {
      ...inputs.sign,
      method: method === "cosign" ? "cosign" : "node_dsse",
      keyId: keyId,
      workDir: inputs.sign.workDir,
    });
    bundle = signed.bundle;
    signingMethod = signed.method;
    sigstoreBundlePath = signed.sigstoreBundlePath;
    finalKeyId = signed.keyId ?? keyId;
  }

  const checkSummary = formatGitHubCheckSummary(statement.predicate, signingMethod, finalKeyId);

  return {
    statement,
    statementJson: statementToJson(statement),
    bundle,
    checkSummary,
    signingMethod,
    sigstoreBundlePath,
    keyId: finalKeyId,
  };
}

export function formatGitHubCheckSummary(
  p: AgentExecutionPredicateV01,
  signingMethod: SigningMethod = "none",
  keyId?: string
): string {
  const lines: string[] = [
    "## VeriForge Attest",
    "",
    `**Policy decision:** ${p.policy?.decision ?? "allow"}`,
    `**Signing:** ${signingMethod}${keyId ? ` (\`${keyId.slice(0, 24)}${keyId.length > 24 ? "…" : ""}\`)` : ""}`,
  ];
  if (p.policy?.reasons?.length) {
    lines.push("", "**Reasons:**", ...p.policy.reasons.map((r) => `- ${r}`));
  }
  lines.push("", "### Evidence (factual)", "");
  for (const e of p.evidence) {
    lines.push(`- \`${e.id}\`: **${e.outcome}** (_${e.assurance}_)`);
  }
  if (p.agent.model_identifier?.value) {
    lines.push(
      "",
      `Agent model (assurance: ${p.agent.model_identifier.assurance}): ${p.agent.model_identifier.value}`
    );
  }
  if (p.execution.files_touched?.length) {
    lines.push("", `Files touched (OTEL): ${p.execution.files_touched.length}`);
  }
  lines.push(
    "",
    "_No invented scores. Assurance class on every claim per VeriForge schema v0.1._"
  );
  return lines.join("\n");
}

export async function writeOutputs(
  outDir: string,
  statementJson: string,
  bundle: DsseEnvelope,
  checkSummary: string,
  extras?: {
    predicate?: AgentExecutionPredicateV01;
    sigstoreBundlePath?: string;
    statement?: InTotoStatement;
  }
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/execution-receipt.json`, statementJson, "utf8");
  await writeFile(
    `${outDir}/execution-receipt.bundle.json`,
    JSON.stringify(bundle, null, 2),
    "utf8"
  );
  await writeFile(`${outDir}/github-check-summary.md`, checkSummary, "utf8");

  const predicate =
    extras?.predicate ??
    extras?.statement?.predicate ??
    (JSON.parse(statementJson) as InTotoStatement).predicate;
  await writeFile(
    `${outDir}/agent-execution-predicate.json`,
    JSON.stringify(predicate, null, 2),
    "utf8"
  );

  if (extras?.sigstoreBundlePath) {
    try {
      const raw = await readFile(extras.sigstoreBundlePath, "utf8");
      await writeFile(`${outDir}/execution-receipt.sigstore.json`, raw, "utf8");
    } catch {
      // optional
    }
  }
}
