/** Assurance classes per [[VeriForge Thesis v4.0]] — every claim must declare one. */
export type AssuranceClass =
  | "cryptographic"
  | "deterministic"
  | "observed"
  | "tool-derived"
  | "statistical"
  | "human-attested"
  | "declared"
  | "inferred"
  | "unknown";

export type EvidenceOutcome = "passed" | "failed" | "skipped" | "not_run" | "unknown";

export interface EvidenceItem {
  id: string;
  kind: string;
  outcome: EvidenceOutcome;
  assurance: AssuranceClass;
  source?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionPredicateV01 {
  version: "0.1";
  source: {
    repository?: string;
    ref?: string;
    base_commit?: string;
    head_commit?: string;
    pull_request?: number;
  };
  task: {
    workflow?: string;
    wedge?: "migration" | "dependency_upgrade" | "iac" | "authz" | "other";
    summary?: string;
  };
  agent: {
    name?: string;
    session_id?: string;
    model_identifier?: { value?: string; assurance: AssuranceClass };
  };
  execution: {
    started_at?: string;
    finished_at?: string;
    files_touched?: string[];
  };
  permissions?: Array<{ action: string; assurance: AssuranceClass }>;
  evidence: EvidenceItem[];
  policy?: {
    version?: number;
    decision?: "allow" | "block" | "review";
    reasons?: string[];
  };
  provenance?: {
    builder?: string;
    signing?:
      | "unsigned"
      | "node_dsse"
      | "cosign_key"
      | "sigstore"
      | "github_oidc";
    key_id?: string;
    note?: string;
  };
}

export const PREDICATE_TYPE =
  "https://veriforge.dev/predicates/agent-execution/v0.1" as const;

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

export interface InTotoStatement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: typeof PREDICATE_TYPE;
  predicate: AgentExecutionPredicateV01;
}

export interface DsseEnvelope {
  payloadType: "application/vnd.in-toto+json";
  payload: string;
  signatures: Array<{ keyid?: string; sig: string }>;
}