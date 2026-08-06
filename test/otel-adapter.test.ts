import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentFactsFromOtel,
  normalizeAttributes,
  parseOtelJson,
  parseOtelText,
  evidenceFromCi,
} from "../src/adapters.js";
import { runAttest } from "../src/attest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "..", "fixtures");
const otlpPath = join(fixtures, "otel", "claude-code-otlp-migration.json");

describe("otel adapter — OTLP + Claude Code", () => {
  it("normalizes OTLP KeyValue attribute arrays", () => {
    const attrs = normalizeAttributes([
      { key: "file.path", value: { stringValue: "db/m.sql" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
      { key: "ok", value: { boolValue: true } },
    ]);
    assert.equal(attrs["file.path"], "db/m.sql");
    assert.equal(attrs["gen_ai.usage.input_tokens"], 12);
    assert.equal(attrs.ok, true);
  });

  it("parses OTLP resourceSpans with resource-level session id", async () => {
    const raw = JSON.parse(await readFile(otlpPath, "utf8"));
    const spans = parseOtelJson(raw);
    assert.ok(spans.length >= 4);
    const facts = agentFactsFromOtel(spans);
    assert.equal(facts.otlp_encoded, true);
    assert.equal(facts.session_id, "sess_partner_migration_20260718");
    assert.equal(facts.model_identifier?.value, "claude-sonnet-4-20250514");
    assert.ok(facts.files_touched.some((f) => f.includes("20260718_add_billing_accounts.sql")));
    assert.ok(facts.files_touched.includes("db/schema.sql"));
    assert.ok(facts.files_touched.some((f) => f.includes("_down.sql")));
  });

  it("parses JSONL OTLP dumps", async () => {
    const one = await readFile(otlpPath, "utf8");
    const text = one.trim() + "\n" + one.trim() + "\n";
    const spans = parseOtelText(text);
    assert.ok(spans.length >= 8);
  });

  it("still accepts legacy flat claude-otel.json", async () => {
    const raw = JSON.parse(await readFile(join(fixtures, "claude-otel.json"), "utf8"));
    const spans = parseOtelJson(raw);
    const facts = agentFactsFromOtel(spans);
    assert.equal(facts.session_id, "sess_demo_001");
    assert.ok(facts.files_touched.includes("db/migrations/20260707_add_users.sql"));
  });

  it("evidenceFromCi includes migration controls", () => {
    const ev = evidenceFromCi({
      migration_forward: "passed",
      migration_rollback: "failed",
    });
    assert.equal(ev.find((e) => e.id === "migration_forward")?.outcome, "passed");
    assert.equal(ev.find((e) => e.id === "migration_rollback")?.outcome, "failed");
  });

  it("runAttest end-to-end on OTLP migration fixture", async () => {
    const { statement } = await runAttest({
      otelPath: otlpPath,
      ciPath: join(
        __dirname,
        "..",
        "design-partner-sample",
        ".veriforge",
        "ci-results.json"
      ),
      policyPath: join(
        __dirname,
        "..",
        "design-partner-sample",
        ".veriforge",
        "policy.yaml"
      ),
      github: { head_sha: "aabbccdd", repository: "acme/partner-app" },
      wedge: "migration",
    });
    assert.equal(statement.predicate.task.wedge, "migration");
    assert.equal(statement.predicate.agent.session_id, "sess_partner_migration_20260718");
    assert.ok(
      statement.predicate.evidence.some(
        (e) => e.id === "agent_otel_trace" && e.source === "otlp-json"
      )
    );
    assert.ok(
      statement.predicate.evidence.some((e) => e.id === "migration_forward" && e.outcome === "passed")
    );
    assert.equal(statement.predicate.policy?.decision, "allow");
  });
});
