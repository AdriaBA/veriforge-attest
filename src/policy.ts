import type { AgentExecutionPredicateV01, EvidenceItem } from "./types.js";

export interface PolicyRule {
  id: string;
  when: string;
  decision: "block" | "review";
  message?: string;
}

export interface PolicyFile {
  version: number;
  rules: PolicyRule[];
}

/**
 * Compile a deliberately small Rego subset into the existing factual policy evaluator.
 *
 * Supported form:
 *   block["message"] if { evidence_outcome("unit_tests", "failed") }
 *   review["message"] if { evidence_outcome("dependency_scan", "failed") }
 *
 * This is a spike path, not a general OPA implementation: it keeps policy-as-code
 * examples close to the evidence model without adding opaque scores or a runtime.
 */
export function compileRegoPolicy(source: string): PolicyFile {
  const rules: PolicyRule[] = [];
  const ruleRe =
    /(block|review)\s*\[\s*"([^"]+)"\s*\]\s*if\s*\{([\s\S]*?)\}/g;

  for (const match of source.matchAll(ruleRe)) {
    const [, decision, message, body] = match;
    const evidence = body.match(/evidence_outcome\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
    if (!evidence) continue;

    const [, evidenceId, outcome] = evidence;
    rules.push({
      id: `rego-${decision}-${slug(evidenceId)}-${slug(outcome)}`,
      when: `evidence.${evidenceId} == ${outcome}`,
      decision: decision as PolicyRule["decision"],
      message,
    });
  }

  return { version: 1, rules };
}

/** Minimal YAML policy evaluator — factual only, no invented scores. */
export function evaluatePolicy(
  policy: PolicyFile,
  evidence: EvidenceItem[]
): AgentExecutionPredicateV01["policy"] {
  const reasons: string[] = [];
  let decision: "allow" | "block" | "review" = "allow";

  const byId = new Map(evidence.map((e) => [e.id, e]));

  for (const rule of policy.rules) {
    const hit = matchWhen(rule.when, byId);
    if (!hit) continue;
    if (rule.decision === "block") {
      decision = "block";
      reasons.push(rule.message ?? rule.id);
    } else if (rule.decision === "review" && decision !== "block") {
      decision = "review";
      reasons.push(rule.message ?? rule.id);
    }
  }

  return { version: policy.version, decision, reasons };
}

function matchWhen(when: string, byId: Map<string, EvidenceItem>): boolean {
  const m = when.trim().match(/^evidence\.([a-zA-Z0-9_.-]+)\s*==\s*(\w+)$/);
  if (!m) return false;
  const [, id, outcome] = m;
  const item = byId.get(id);
  return item?.outcome === outcome;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
