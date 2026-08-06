/**
 * GitHub Checks API publisher for VeriForge Attest bundles.
 * @see https://docs.github.com/en/rest/checks/runs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentExecutionPredicateV01, InTotoStatement } from "./types.js";
import { formatGitHubCheckSummary } from "./attest.js";
import type { SigningMethod } from "./sign.js";

export type CheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "success"
  | "skipped"
  | "stale"
  | "timed_out";

export type CheckStatus = "queued" | "in_progress" | "completed";

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

/** Request body for POST/PATCH check-runs (subset we use). */
export interface CheckRunRequest {
  name: string;
  head_sha: string;
  status: CheckStatus;
  conclusion?: CheckConclusion;
  started_at?: string;
  completed_at?: string;
  external_id?: string;
  details_url?: string;
  output: CheckRunOutput;
}

export interface CheckRunResult {
  mode: "live" | "mock";
  check_run_id?: number;
  html_url?: string;
  request: CheckRunRequest;
  response?: unknown;
  mock_path?: string;
}

export interface BuildCheckRunOptions {
  name?: string;
  detailsUrl?: string;
  externalId?: string;
  /** Override conclusion; default maps from policy.decision */
  conclusion?: CheckConclusion;
  signingMethod?: SigningMethod;
  keyId?: string;
  /** Extra markdown appended under the summary (e.g. artifact paths). */
  extraText?: string;
  /** Pre-rendered summary markdown; if omitted, built from predicate. */
  summaryMarkdown?: string;
}

export function conclusionFromPolicy(
  decision: AgentExecutionPredicateV01["policy"] extends infer P
    ? P extends { decision?: infer D }
      ? D
      : undefined
    : undefined
): CheckConclusion {
  switch (decision) {
    case "allow":
      return "success";
    case "block":
      return "failure";
    case "review":
      return "action_required";
    default:
      return "neutral";
  }
}

export function titleFromConclusion(conclusion: CheckConclusion, decision?: string): string {
  const d = decision ?? conclusion;
  switch (conclusion) {
    case "success":
      return `VeriForge Attest: allow`;
    case "failure":
      return `VeriForge Attest: block`;
    case "action_required":
      return `VeriForge Attest: review required`;
    default:
      return `VeriForge Attest: ${d}`;
  }
}

export function buildCheckRunRequest(
  predicate: AgentExecutionPredicateV01,
  opts: BuildCheckRunOptions = {}
): CheckRunRequest {
  const head =
    predicate.source.head_commit && predicate.source.head_commit !== "unknown"
      ? predicate.source.head_commit
      : undefined;
  if (!head) {
    throw new Error("Cannot publish Check Run: predicate.source.head_commit is missing");
  }

  const decision = predicate.policy?.decision;
  const conclusion = opts.conclusion ?? conclusionFromPolicy(decision);
  const signingMethod = opts.signingMethod ?? mapProvenanceSigning(predicate.provenance?.signing);
  const keyId = opts.keyId ?? predicate.provenance?.key_id;
  const summary =
    opts.summaryMarkdown ?? formatGitHubCheckSummary(predicate, signingMethod, keyId);

  const textParts: string[] = [];
  if (opts.extraText) textParts.push(opts.extraText);
  textParts.push(
    "",
    "### Bundle references",
    "",
    "- Subject: git commit `" + head + "`",
    predicate.source.repository ? `- Repository: \`${predicate.source.repository}\`` : "",
    predicate.provenance?.signing
      ? `- Provenance signing: \`${predicate.provenance.signing}\``
      : "",
    ""
  );

  const now = new Date().toISOString();
  const req: CheckRunRequest = {
    name: opts.name ?? "VeriForge Attest",
    head_sha: head,
    status: "completed",
    conclusion,
    started_at: now,
    completed_at: now,
    output: {
      title: titleFromConclusion(conclusion, decision),
      summary: truncate(summary, 65535),
      text: truncate(textParts.filter(Boolean).join("\n"), 65535),
    },
  };

  if (opts.detailsUrl) req.details_url = opts.detailsUrl;
  if (opts.externalId) req.external_id = opts.externalId;

  return req;
}

function mapProvenanceSigning(
  s: AgentExecutionPredicateV01["provenance"] extends infer P
    ? P extends { signing?: infer S }
      ? S
      : undefined
    : undefined
): SigningMethod {
  if (s === "node_dsse") return "node_dsse";
  if (s === "cosign_key" || s === "sigstore") return "cosign";
  return "none";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + "\n…(truncated)";
}

export function parseRepository(repo: string): { owner: string; name: string } {
  const parts = repo.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Invalid repository "${repo}" — expected owner/name`);
  }
  return { owner: parts[0]!, name: parts[1]! };
}

export interface PublishCheckRunOptions {
  /** owner/name — required for live publish */
  repository?: string;
  token?: string;
  /** If set, PATCH existing check run instead of POST */
  checkRunId?: number;
  /** Write request (+ optional fake response) under this dir; no network */
  mockDir?: string;
  /** Override API base (tests) */
  apiBaseUrl?: string;
  /** Inject fetch for tests */
  fetchImpl?: typeof fetch;
}

export async function publishCheckRun(
  request: CheckRunRequest,
  opts: PublishCheckRunOptions = {}
): Promise<CheckRunResult> {
  if (opts.mockDir) {
    await mkdir(opts.mockDir, { recursive: true });
    const mockPath = join(opts.mockDir, "github-check-run.json");
    const fakeId = opts.checkRunId ?? Math.floor(Date.now() / 1000) % 1_000_000_000;
    const response = {
      id: fakeId,
      name: request.name,
      head_sha: request.head_sha,
      status: request.status,
      conclusion: request.conclusion,
      html_url: `https://github.com/example/mock/runs/${fakeId}`,
      output: request.output,
      mock: true,
      method: opts.checkRunId ? "PATCH" : "POST",
    };
    const artifact = {
      mode: "mock" as const,
      request,
      response,
      published_at: new Date().toISOString(),
    };
    await writeFile(mockPath, JSON.stringify(artifact, null, 2), "utf8");
    return {
      mode: "mock",
      check_run_id: fakeId,
      html_url: response.html_url,
      request,
      response,
      mock_path: mockPath,
    };
  }

  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub Checks publish requires GITHUB_TOKEN/GH_TOKEN or --check-mock / mockDir"
    );
  }

  const repository =
    opts.repository ?? process.env.GITHUB_REPOSITORY ?? requestHasRepoFromEnv();
  if (!repository) {
    throw new Error("GitHub Checks publish requires repository (owner/name) or GITHUB_REPOSITORY");
  }

  const { owner, name } = parseRepository(repository);
  const base = (opts.apiBaseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(
    /\/$/,
    ""
  );
  const fetchFn = opts.fetchImpl ?? fetch;

  const url = opts.checkRunId
    ? `${base}/repos/${owner}/${name}/check-runs/${opts.checkRunId}`
    : `${base}/repos/${owner}/${name}/check-runs`;
  const method = opts.checkRunId ? "PATCH" : "POST";

  const res = await fetchFn(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "veriforge-attest",
    },
    body: JSON.stringify(request),
  });

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }

  if (!res.ok) {
    throw new Error(
      `GitHub Checks API ${method} failed: HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 500)}`
    );
  }

  const parsed = body as { id?: number; html_url?: string };
  return {
    mode: "live",
    check_run_id: parsed.id,
    html_url: parsed.html_url,
    request,
    response: body,
  };
}

function requestHasRepoFromEnv(): string | undefined {
  return undefined;
}

export interface PublishFromAttestBundleOptions extends PublishCheckRunOptions, BuildCheckRunOptions {
  /** Directory with execution-receipt.json (+ optional github-check-summary.md) */
  outDir: string;
  /** Also write github-check-run.json into outDir on live publish */
  writeArtifact?: boolean;
}

/**
 * Load execution-receipt.json from an attest out dir and open/update a Check Run.
 */
export async function publishCheckFromOutDir(
  opts: PublishFromAttestBundleOptions
): Promise<CheckRunResult> {
  const receiptPath = join(opts.outDir, "execution-receipt.json");
  const summaryPath = join(opts.outDir, "github-check-summary.md");
  const raw = await readFile(receiptPath, "utf8");
  const statement = JSON.parse(raw) as InTotoStatement;
  const predicate = statement.predicate;

  let summaryMarkdown = opts.summaryMarkdown;
  if (!summaryMarkdown) {
    try {
      summaryMarkdown = await readFile(summaryPath, "utf8");
    } catch {
      // rebuild from predicate
    }
  }

  const repository =
    opts.repository ?? predicate.source.repository ?? process.env.GITHUB_REPOSITORY;

  const request = buildCheckRunRequest(predicate, {
    name: opts.name,
    detailsUrl: opts.detailsUrl,
    externalId: opts.externalId,
    conclusion: opts.conclusion,
    signingMethod: opts.signingMethod,
    keyId: opts.keyId ?? predicate.provenance?.key_id,
    extraText: opts.extraText,
    summaryMarkdown,
  });

  const result = await publishCheckRun(request, {
    repository,
    token: opts.token,
    checkRunId: opts.checkRunId,
    mockDir: opts.mockDir,
    apiBaseUrl: opts.apiBaseUrl,
    fetchImpl: opts.fetchImpl,
  });

  // Persist artifact next to receipt (audit trail for PR/GHA)
  if (opts.writeArtifact !== false) {
    await mkdir(opts.outDir, { recursive: true });
    const artifactPath = join(opts.outDir, "github-check-run.json");
    await writeFile(
      artifactPath,
      JSON.stringify(
        {
          mode: result.mode,
          check_run_id: result.check_run_id,
          html_url: result.html_url,
          request: result.request,
          response: result.response,
          published_at: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
    if (result.mode === "mock") {
      result.mock_path = artifactPath;
    }
  }

  return result;
}
