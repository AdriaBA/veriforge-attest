import type { AgentExecutionPredicateV01, InTotoStatement } from "./types.js";
import { PREDICATE_TYPE as PT, STATEMENT_TYPE as ST } from "./types.js";

export interface BuildReceiptInput {
  predicate: AgentExecutionPredicateV01;
  subjectName: string;
  subjectDigest: Record<string, string>;
}

export function buildStatement(input: BuildReceiptInput): InTotoStatement {
  return {
    _type: ST,
    subject: [{ name: input.subjectName, digest: input.subjectDigest }],
    predicateType: PT,
    predicate: input.predicate,
  };
}

export function buildPredicateBase(
  partial: Partial<AgentExecutionPredicateV01> & {
    evidence: AgentExecutionPredicateV01["evidence"];
  }
): AgentExecutionPredicateV01 {
  const signing = partial.provenance?.signing ?? "unsigned";
  const defaultNote =
    signing === "unsigned"
      ? "Unsigned attestation; use --sign-key / --cosign-key or GitHub artifact attestations for cryptographic assurance."
      : signing === "node_dsse"
        ? "DSSE envelope signed with ECDSA P-256 (node_dsse); verify with public key PEM."
        : signing === "cosign_key"
          ? "Signed via Cosign (key); see execution-receipt.sigstore.json when present."
          : signing === "github_oidc"
            ? "Intended for GitHub artifact attestations (actions/attest) with OIDC identity."
            : "Sigstore / keyless signing path.";

  return {
    version: "0.1",
    source: partial.source ?? {},
    task: partial.task ?? {},
    agent: partial.agent ?? {},
    execution: partial.execution ?? {},
    permissions: partial.permissions,
    evidence: partial.evidence,
    policy: partial.policy,
    provenance: {
      builder: "@veriforge/attest@0.2.0",
      note: defaultNote,
      ...partial.provenance,
      signing,
    },
  };
}

export function statementToJson(statement: InTotoStatement): string {
  return JSON.stringify(statement, null, 2);
}

export function envelopePayloadBase64(statement: InTotoStatement): string {
  return Buffer.from(statementToJson(statement), "utf8").toString("base64");
}

/** MVP: unsigned DSSE-shaped bundle for local dev / GitHub artifact upload. */
export function buildUnsignedBundle(statement: InTotoStatement): {
  payloadType: "application/vnd.in-toto+json";
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
} {
  const payload = envelopePayloadBase64(statement);
  return {
    payloadType: "application/vnd.in-toto+json",
    payload,
    signatures: [
      {
        keyid: "veriforge-mvp-unsigned",
        sig: Buffer.from(`unsigned:${payload.slice(0, 32)}`, "utf8").toString("base64"),
      },
    ],
  };
}