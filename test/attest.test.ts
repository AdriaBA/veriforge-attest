import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileRegoPolicy, evaluatePolicy } from "../src/policy.js";
import { runAttest, writeOutputs } from "../src/attest.js";
import {
  generateDevKeyPair,
  signStatementNodeDsse,
  verifyDsseEnvelope,
  dssePae,
} from "../src/sign.js";
import { buildStatement, buildPredicateBase } from "../src/receipt.js";
import { PREDICATE_TYPE, STATEMENT_TYPE } from "../src/types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "..", "fixtures");

describe("policy", () => {
  it("blocks on failed unit tests", () => {
    const r = evaluatePolicy(
      {
        version: 1,
        rules: [{ id: "x", when: "evidence.unit_tests == failed", decision: "block" }],
      },
      [{ id: "unit_tests", kind: "test", outcome: "failed", assurance: "deterministic" }]
    );
    assert.equal(r?.decision, "block");
  });

  it("compiles the Rego fixture into factual evidence rules", async () => {
    const raw = await readFile(join(fixtures, "policy.rego"), "utf8");
    const policy = compileRegoPolicy(raw);

    assert.deepEqual(policy, {
      version: 1,
      rules: [
        {
          id: "rego-block-unit-tests-failed",
          when: "evidence.unit_tests == failed",
          decision: "block",
          message: "Unit tests failed — merge blocked by policy.",
        },
        {
          id: "rego-review-dependency-scan-failed",
          when: "evidence.dependency_scan == failed",
          decision: "review",
          message: "Dependency scan reported failures — human review required.",
        },
      ],
    });

    const result = evaluatePolicy(policy, [
      { id: "unit_tests", kind: "test", outcome: "passed", assurance: "deterministic" },
      { id: "dependency_scan", kind: "scan", outcome: "failed", assurance: "tool-derived" },
    ]);
    assert.equal(result?.decision, "review");
    assert.deepEqual(result?.reasons, ["Dependency scan reported failures — human review required."]);
  });
});

describe("runAttest", () => {
  it("builds in-toto statement with veriforge predicate", async () => {
    const { statementJson } = await runAttest({
      otelPath: join(fixtures, "claude-otel.json"),
      ciPath: join(fixtures, "ci-results.json"),
      policyPath: join(fixtures, "policy.yaml"),
      github: { head_sha: "deadbeef", repository: "acme/app" },
      wedge: "migration",
    });
    const stmt = JSON.parse(statementJson);
    assert.equal(stmt._type, STATEMENT_TYPE);
    assert.equal(stmt.predicateType, PREDICATE_TYPE);
    assert.equal(stmt.predicate.version, "0.1");
    assert.equal(stmt.predicate.task.wedge, "migration");
    assert.equal(stmt.predicate.policy.decision, "review");
    assert.ok(stmt.predicate.evidence.some((e: { id: string }) => e.id === "dependency_scan"));
    assert.equal(stmt.predicate.provenance.signing, "unsigned");
  });

  it("accepts the Rego policy fixture through runAttest", async () => {
    const { statement } = await runAttest({
      otelPath: join(fixtures, "claude-otel.json"),
      ciPath: join(fixtures, "ci-results.json"),
      policyPath: join(fixtures, "policy.rego"),
      github: { head_sha: "deadbeef", repository: "acme/app" },
      wedge: "migration",
    });

    assert.equal(statement.predicate.policy?.decision, "review");
    assert.deepEqual(statement.predicate.policy?.reasons, [
      "Dependency scan reported failures — human review required.",
    ]);
  });

  it("signs DSSE with node ECDSA P-256 and verifies", async () => {
    const { privateKeyPem, publicKeyPem } = generateDevKeyPair();
    const out = await mkdtemp(join(tmpdir(), "veriforge-sign-"));
    const keyPath = join(out, "dev.key.pem");
    const pubPath = join(out, "dev.pub.pem");
    await writeFile(keyPath, privateKeyPem);
    await writeFile(pubPath, publicKeyPem);

    const result = await runAttest({
      otelPath: join(fixtures, "claude-otel.json"),
      ciPath: join(fixtures, "ci-results.json"),
      policyPath: join(fixtures, "policy.yaml"),
      github: { head_sha: "cafebabe", repository: "acme/app" },
      wedge: "migration",
      sign: { privateKeyPath: keyPath, method: "node_dsse", workDir: out },
    });

    assert.equal(result.signingMethod, "node_dsse");
    assert.equal(result.statement.predicate.provenance?.signing, "node_dsse");
    assert.ok(
      result.statement.predicate.evidence.some(
        (e) => e.id === "receipt_signature" && e.assurance === "cryptographic"
      )
    );
    assert.ok(result.bundle.signatures[0]?.sig);
    assert.notEqual(result.bundle.signatures[0]?.keyid, "veriforge-mvp-unsigned");

    const ok = verifyDsseEnvelope(result.bundle, publicKeyPem);
    assert.equal(ok, true);

    // Payload decodes to matching statement
    const payload = JSON.parse(Buffer.from(result.bundle.payload, "base64").toString("utf8"));
    assert.equal(payload.predicateType, PREDICATE_TYPE);
    assert.equal(payload.predicate.provenance.signing, "node_dsse");

    await writeOutputs(out, result.statementJson, result.bundle, result.checkSummary, {
      statement: result.statement,
    });
    const pred = JSON.parse(await readFile(join(out, "agent-execution-predicate.json"), "utf8"));
    assert.equal(pred.provenance.signing, "node_dsse");
  });

  it("signs with Cosign keyless when method=cosign and no key is provided", async () => {
    const out = await mkdtemp(join(tmpdir(), "veriforge-cosign-keyless-"));
    const fakeCosign = join(out, "cosign-fake.mjs");
    const argsPath = join(out, "cosign-args.json");
    await writeFile(
      fakeCosign,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args, null, 2));
const bundle = args[args.indexOf("--bundle") + 1];
writeFileSync(bundle, JSON.stringify({
  dsseEnvelope: {
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
    signatures: [{ keyid: "sigstore-keyless", sig: "ZmFrZQ==" }]
  }
}, null, 2));
`,
      "utf8"
    );
    await chmod(fakeCosign, 0o755);

    const result = await runAttest({
      otelPath: join(fixtures, "claude-otel.json"),
      ciPath: join(fixtures, "ci-results.json"),
      policyPath: join(fixtures, "policy.yaml"),
      github: { head_sha: "feedface", repository: "acme/app" },
      wedge: "migration",
      sign: { method: "cosign", cosignBin: fakeCosign, workDir: out },
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.equal(args[0], "attest-blob");
    assert.equal(args.includes("--key"), false);
    assert.equal(result.signingMethod, "cosign");
    assert.equal(result.keyId, "sigstore-keyless");
    assert.equal(result.statement.predicate.provenance?.signing, "sigstore");
    assert.ok(result.sigstoreBundlePath?.endsWith("execution-receipt.sigstore.json"));
  });
});

describe("dsse", () => {
  it("PAE is deterministic", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const a = dssePae("application/vnd.in-toto+json", body);
    const b = dssePae("application/vnd.in-toto+json", body);
    assert.equal(a.equals(b), true);
    assert.ok(a.toString("utf8").startsWith("DSSEv1 "));
  });

  it("signStatementNodeDsse round-trip", () => {
    const { privateKeyPem, publicKeyPem } = generateDevKeyPair();
    const statement = buildStatement({
      predicate: buildPredicateBase({
        evidence: [{ id: "x", kind: "test", outcome: "passed", assurance: "deterministic" }],
        provenance: { signing: "node_dsse" },
      }),
      subjectName: "git-commit",
      subjectDigest: { sha1: "abc" },
    });
    const env = signStatementNodeDsse(statement, privateKeyPem, "test-key");
    assert.equal(env.signatures[0]?.keyid, "test-key");
    assert.equal(verifyDsseEnvelope(env, publicKeyPem), true);

    const { publicKeyPem: other } = generateDevKeyPair();
    assert.equal(verifyDsseEnvelope(env, other), false);
  });
});
