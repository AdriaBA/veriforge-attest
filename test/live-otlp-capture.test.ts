import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { runAttest } from "../src/attest.js";

const root = join(import.meta.dirname, "..");
const otlpFixture = join(root, "fixtures", "otel", "claude-code-otlp-migration.json");
const ciFixture = join(root, "design-partner-sample", ".veriforge", "ci-results.json");
const policyFixture = join(root, "design-partner-sample", ".veriforge", "policy.yaml");

function waitForStdout(child: ReturnType<typeof spawn>, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}; stdout=${stdout}; stderr=${stderr}`)), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (!stdout.includes(needle)) {
        clearTimeout(timer);
        reject(new Error(`collector exited ${code}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
  });
}

describe("live OTLP session capture", () => {
  it("captures OTLP HTTP traces to a dump that runAttest accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veriforge-otlp-"));
    const out = join(dir, "otel-export.jsonl");
    const port = 18_000 + (process.pid % 10_000);
    const collector = spawn(process.execPath, [
      join(root, "scripts", "capture-otlp-session.mjs"),
      "--out",
      out,
      "--port",
      String(port),
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForStdout(collector, "OTLP capture listening");
      const payload = await readFile(otlpFixture, "utf8");
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(response.status, 200);
      await waitForStdout(collector, "captured /v1/traces");

      const dump = await readFile(out, "utf8");
      assert.match(dump, /resourceSpans/);

      const { statement, checkSummary } = await runAttest({
        otelPath: out,
        ciPath: ciFixture,
        policyPath: policyFixture,
        github: { head_sha: "livecapture123", repository: "partner/live-app" },
        wedge: "migration",
        agentName: "claude-code",
      });

      assert.equal(statement.predicate.agent.session_id, "sess_partner_migration_20260718");
      assert.equal(statement.predicate.policy?.decision, "allow");
      assert.ok(statement.predicate.execution.files_touched.some((f) => f.includes("migrations")));
      assert.ok(statement.predicate.evidence.some((e) => e.id === "agent_otel_trace" && e.source === "otlp-json"));
      assert.match(checkSummary, /No invented scores/);
    } finally {
      collector.kill("SIGTERM");
      await Promise.race([once(collector, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
