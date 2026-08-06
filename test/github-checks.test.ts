import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCheckRunRequest,
  conclusionFromPolicy,
  parseRepository,
  publishCheckFromOutDir,
  publishCheckRun,
} from "../src/github-checks.js";
import { runAttest, writeOutputs } from "../src/attest.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "..", "fixtures");

describe("github-checks mapping", () => {
  it("maps policy decisions to conclusions", () => {
    assert.equal(conclusionFromPolicy("allow"), "success");
    assert.equal(conclusionFromPolicy("block"), "failure");
    assert.equal(conclusionFromPolicy("review"), "action_required");
    assert.equal(conclusionFromPolicy(undefined), "neutral");
  });

  it("parses owner/repo", () => {
    assert.deepEqual(parseRepository("acme/app"), { owner: "acme", name: "app" });
    assert.throws(() => parseRepository("nope"));
  });

  it("builds completed Check Run from predicate", () => {
    const req = buildCheckRunRequest(
      {
        version: "0.1",
        source: { repository: "acme/app", head_commit: "deadbeefcafebabe" },
        task: { wedge: "migration" },
        agent: {},
        execution: {},
        evidence: [
          { id: "unit_tests", kind: "test", outcome: "passed", assurance: "deterministic" },
        ],
        policy: { decision: "review", reasons: ["needs eyes"] },
        provenance: { signing: "node_dsse", key_id: "abc" },
      },
      { name: "VeriForge Attest", detailsUrl: "https://example.com/run/1" }
    );
    assert.equal(req.name, "VeriForge Attest");
    assert.equal(req.head_sha, "deadbeefcafebabe");
    assert.equal(req.status, "completed");
    assert.equal(req.conclusion, "action_required");
    assert.equal(req.details_url, "https://example.com/run/1");
    assert.match(req.output.summary, /VeriForge Attest/);
    assert.match(req.output.summary, /review/);
    assert.match(req.output.title, /review/i);
  });

  it("requires head_commit", () => {
    assert.throws(() =>
      buildCheckRunRequest({
        version: "0.1",
        source: {},
        task: {},
        agent: {},
        execution: {},
        evidence: [],
      })
    );
  });
});

describe("github-checks publish", () => {
  it("mock path writes github-check-run.json from attest out dir", async () => {
    const out = await mkdtemp(join(tmpdir(), "veriforge-check-"));
    const attest = await runAttest({
      otelPath: join(fixtures, "claude-otel.json"),
      ciPath: join(fixtures, "ci-results.json"),
      policyPath: join(fixtures, "policy.yaml"),
      github: { head_sha: "aabbccddeeff00112233445566778899aabbccdd", repository: "acme/app" },
      wedge: "migration",
    });
    await writeOutputs(out, attest.statementJson, attest.bundle, attest.checkSummary, {
      statement: attest.statement,
    });

    const result = await publishCheckFromOutDir({ outDir: out, mockDir: out });
    assert.equal(result.mode, "mock");
    assert.equal(result.request.conclusion, "action_required"); // fixture policy → review
    assert.ok(result.check_run_id);

    const artifact = JSON.parse(await readFile(join(out, "github-check-run.json"), "utf8"));
    assert.equal(artifact.mode, "mock");
    assert.equal(artifact.request.head_sha, "aabbccddeeff00112233445566778899aabbccdd");
    assert.equal(artifact.request.status, "completed");
    assert.match(artifact.request.output.summary, /dependency_scan/);
  });

  it("live path POSTs then PATCHes via injected fetch", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      calls.push({ url, method, body });
      if (method === "POST") {
        return new Response(
          JSON.stringify({
            id: 4242,
            html_url: "https://github.com/acme/app/runs/4242",
            name: "VeriForge Attest",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: 4242,
          html_url: "https://github.com/acme/app/runs/4242",
          name: "VeriForge Attest",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const request = buildCheckRunRequest({
      version: "0.1",
      source: { head_commit: "1111222233334444555566667777888899990000" },
      task: {},
      agent: {},
      execution: {},
      evidence: [],
      policy: { decision: "allow" },
    });

    const created = await publishCheckRun(request, {
      repository: "acme/app",
      token: "ghs_test",
      apiBaseUrl: "https://api.github.example",
      fetchImpl,
    });
    assert.equal(created.mode, "live");
    assert.equal(created.check_run_id, 4242);
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]!.url, /\/repos\/acme\/app\/check-runs$/);

    const updated = await publishCheckRun(
      { ...request, conclusion: "failure" },
      {
        repository: "acme/app",
        token: "ghs_test",
        checkRunId: 4242,
        apiBaseUrl: "https://api.github.example",
        fetchImpl,
      }
    );
    assert.equal(updated.check_run_id, 4242);
    assert.equal(calls[1]?.method, "PATCH");
    assert.match(calls[1]!.url, /\/check-runs\/4242$/);
  });

  it("live path errors without token", async () => {
    const prevG = process.env.GITHUB_TOKEN;
    const prevH = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const request = buildCheckRunRequest({
        version: "0.1",
        source: { head_commit: "abcd" },
        task: {},
        agent: {},
        execution: {},
        evidence: [],
      });
      await assert.rejects(
        () => publishCheckRun(request, { repository: "acme/app" }),
        /GITHUB_TOKEN/
      );
    } finally {
      if (prevG !== undefined) process.env.GITHUB_TOKEN = prevG;
      if (prevH !== undefined) process.env.GH_TOKEN = prevH;
    }
  });
});
