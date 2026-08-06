import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREDICATE_TYPE, STATEMENT_TYPE } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const liveFixtures = join(__dirname, "..", "fixtures", "gha", "live");

describe("live GitHub artifact attestation fixture", () => {
  it("uses the same in-toto statement slots as VeriForge agent-execution predicates", async () => {
    const statement = JSON.parse(
      await readFile(join(liveFixtures, "github-cli-attestation-statement.json"), "utf8")
    );
    const summary = JSON.parse(
      await readFile(join(liveFixtures, "github-cli-attestation-summary.json"), "utf8")
    );
    const response = JSON.parse(
      await readFile(join(liveFixtures, "github-cli-attestation-response.json"), "utf8")
    );

    assert.equal(statement._type, STATEMENT_TYPE);
    assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
    assert.equal(summary.comparison_to_veriforge_agent_execution_v0_1.adapter_change_required, false);
    assert.match(
      summary.comparison_to_veriforge_agent_execution_v0_1.compatible.join("\n"),
      new RegExp(PREDICATE_TYPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );

    assert.deepEqual(statement.subject, [
      {
        name: "gh_2.50.0_windows_arm64.zip",
        digest: {
          sha256: "8aad120b416386b4269ef62c8fdebcad31a70847297817a149daf927edc85548",
        },
      },
    ]);
    assert.equal(
      statement.predicate.buildDefinition.externalParameters.workflow.repository,
      "https://github.com/cli/cli"
    );
    assert.equal(
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit,
      "faef2ddd81b0736748413a7c646cd0bfc26c00a0"
    );
    assert.equal(response.attestations[0].bundle_url_redacted.includes("sig="), false);
  });
});
