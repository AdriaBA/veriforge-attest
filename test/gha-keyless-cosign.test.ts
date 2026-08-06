import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function readYaml(path: string): any {
  return YAML.parse(readFileSync(path, "utf8"));
}

describe("GitHub Actions keyless Cosign fixture", () => {
  it("documents ambient OIDC keyless Cosign without long-lived private key secrets", () => {
    const workflowPath = join(root, "fixtures", "gha", "workflow-signed-attest.yml");
    const workflowText = readFileSync(workflowPath, "utf8");
    const workflow = readYaml(workflowPath);

    assert.equal(workflow.permissions["id-token"], "write");
    assert.equal(workflow.permissions.contents, "read");
    assert.equal(workflow.permissions.checks, "write");

    const steps = workflow.jobs.attest.steps as Array<Record<string, any>>;
    assert.ok(
      steps.some(
        (step) =>
          step.name === "VeriForge Attest + Check Run" &&
          step.with?.cosign_keyless === "true" &&
          step.with?.github_attest === "true"
      ),
      "reference workflow must prefer keyless Cosign + GitHub OIDC attestations in CI"
    );
    assert.doesNotMatch(workflowText, /COSIGN_PRIVATE_KEY|secrets\.COSIGN/);
  });
});

describe("composite action keyless Cosign input", () => {
  it("keeps keyless CI separate from local/dev key signing", () => {
    const actionPath = join(root, "action.yml");
    const actionText = readFileSync(actionPath, "utf8");
    const action = readYaml(actionPath);

    assert.equal(action.inputs.cosign_keyless.default, "false");
    assert.match(action.inputs.cosign_keyless.description, /keyless/i);
    assert.match(action.inputs.cosign_key.description, /local|offline|legacy|dev/i);
    assert.match(actionText, /sigstore\/cosign-installer/);
    assert.match(actionText, /--cosign-keyless/);
    assert.match(actionText, /inputs\.cosign_keyless == 'true'/);
    assert.doesNotMatch(actionText, /--key\s+\"?\$\{\{ inputs\.cosign_keyless/);
  });
});
