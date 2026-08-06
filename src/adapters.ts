import type { AssuranceClass, EvidenceItem } from "./types.js";

/** Claude Code / generic OTEL export (JSON, JSONL, or OTLP resourceSpans). */
export interface OtelSpanLike {
  name?: string;
  attributes?: Record<string, string | number | boolean | string[]>;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  /** Raw OTLP attribute array preserved for debugging when present. */
  _otlpAttributeCount?: number;
}

export interface CiResultsInput {
  unit_tests?: "passed" | "failed" | "skipped" | "not_run";
  lint?: "passed" | "failed" | "not_run";
  sast?: "passed" | "failed" | "not_run";
  dependency_scan?: "passed" | "failed" | "not_run";
  /** Migration-wedge CI controls (forward / rollback). */
  migration_forward?: "passed" | "failed" | "skipped" | "not_run";
  migration_rollback?: "passed" | "failed" | "skipped" | "not_run";
  sources?: Record<string, string>;
}

export function evidenceFromCi(ci: CiResultsInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const push = (
    id: string,
    kind: string,
    outcome: EvidenceItem["outcome"],
    assurance: AssuranceClass,
    source?: string
  ) => {
    items.push({ id, kind, outcome, assurance, source });
  };

  if (ci.unit_tests) {
    push("unit_tests", "test", ci.unit_tests, "deterministic", ci.sources?.unit_tests);
  }
  if (ci.lint) {
    push("lint", "static_analysis", ci.lint, "deterministic", ci.sources?.lint);
  }
  if (ci.sast) {
    push("sast", "security_scan", ci.sast, "tool-derived", ci.sources?.sast);
  }
  if (ci.dependency_scan) {
    push(
      "dependency_scan",
      "dependency_scan",
      ci.dependency_scan,
      "tool-derived",
      ci.sources?.dependency_scan
    );
  }
  if (ci.migration_forward) {
    push(
      "migration_forward",
      "migration_test",
      ci.migration_forward,
      "deterministic",
      ci.sources?.migration_forward
    );
  }
  if (ci.migration_rollback) {
    push(
      "migration_rollback",
      "migration_test",
      ci.migration_rollback,
      "deterministic",
      ci.sources?.migration_rollback
    );
  }
  return items;
}

/** OTLP AnyValue → JS primitive. */
function otlpAnyValue(v: unknown): string | number | boolean | string[] | undefined {
  if (v == null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.stringValue === "string") return o.stringValue;
  if (typeof o.boolValue === "boolean") return o.boolValue;
  if (typeof o.intValue === "number") return o.intValue;
  if (typeof o.intValue === "string" && o.intValue !== "") {
    const n = Number(o.intValue);
    return Number.isFinite(n) ? n : o.intValue;
  }
  if (typeof o.doubleValue === "number") return o.doubleValue;
  if (o.arrayValue && typeof o.arrayValue === "object") {
    const values = (o.arrayValue as { values?: unknown[] }).values ?? [];
    return values
      .map((x) => otlpAnyValue(x))
      .filter((x): x is string | number | boolean => x !== undefined)
      .map(String);
  }
  if (typeof o.bytesValue === "string") return o.bytesValue;
  return undefined;
}

/**
 * Normalize span attributes from:
 * - flat map (MVP fixture / some exporters)
 * - OTLP JSON KeyValue array [{ key, value: { stringValue } }]
 */
export function normalizeAttributes(raw: unknown): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  if (!raw) return out;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const kv = item as { key?: string; value?: unknown };
      if (typeof kv.key !== "string") continue;
      const val = otlpAnyValue(kv.value);
      if (val !== undefined) out[kv.key] = val;
    }
    return out;
  }

  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = v as string[];
      } else if (v && typeof v === "object" && ("stringValue" in (v as object) || "intValue" in (v as object))) {
        const val = otlpAnyValue(v);
        if (val !== undefined) out[k] = val;
      }
    }
  }
  return out;
}

function normalizeSpan(raw: unknown): OtelSpanLike | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const attrsRaw = s.attributes;
  const attributes = normalizeAttributes(attrsRaw);
  const span: OtelSpanLike = {
    name: typeof s.name === "string" ? s.name : undefined,
    attributes,
    startTimeUnixNano:
      typeof s.startTimeUnixNano === "string" || typeof s.startTimeUnixNano === "number"
        ? s.startTimeUnixNano
        : undefined,
    endTimeUnixNano:
      typeof s.endTimeUnixNano === "string" || typeof s.endTimeUnixNano === "number"
        ? s.endTimeUnixNano
        : undefined,
  };
  if (Array.isArray(attrsRaw)) span._otlpAttributeCount = attrsRaw.length;
  return span;
}

function spansFromResourceSpans(raw: { resourceSpans?: unknown[] }): OtelSpanLike[] {
  const spans: OtelSpanLike[] = [];
  const rs = raw.resourceSpans ?? [];
  for (const block of rs) {
    if (!block || typeof block !== "object") continue;
    const b = block as { resource?: { attributes?: unknown }; scopeSpans?: unknown[] };
    const resourceAttrs = normalizeAttributes(b.resource?.attributes);
    const scopeSpans = b.scopeSpans ?? [];
    for (const ss of scopeSpans) {
      if (!ss || typeof ss !== "object") continue;
      const list = (ss as { spans?: unknown[] }).spans ?? [];
      for (const item of list) {
        const span = normalizeSpan(item);
        if (!span) continue;
        // Resource attrs fill gaps (service.name, session ids often live here).
        span.attributes = { ...resourceAttrs, ...(span.attributes ?? {}) };
        spans.push(span);
      }
    }
  }
  return spans;
}

/**
 * Parse Claude Code / OTEL collector exports:
 * - OTLP JSON object with resourceSpans
 * - Array of span-like objects
 * - JSONL string (multiple OTLP objects) — pass parsed lines or use parseOtelText
 */
export function parseOtelJson(raw: unknown): OtelSpanLike[] {
  if (typeof raw === "string") return parseOtelText(raw);
  if (Array.isArray(raw)) {
    // Array of spans OR array of OTLP ExportTraceServiceRequest objects
    const out: OtelSpanLike[] = [];
    for (const item of raw) {
      if (item && typeof item === "object" && "resourceSpans" in item) {
        out.push(...spansFromResourceSpans(item as { resourceSpans?: unknown[] }));
      } else {
        const span = normalizeSpan(item);
        if (span) out.push(span);
      }
    }
    return out;
  }
  if (raw && typeof raw === "object" && "resourceSpans" in raw) {
    return spansFromResourceSpans(raw as { resourceSpans?: unknown[] });
  }
  return [];
}

/** Extract top-level JSON values from a buffer (JSONL or concatenated objects). */
function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) break;
    if (text[i] !== "{" && text[i] !== "[") {
      // skip garbage until next structure
      const next = text.indexOf("{", i);
      const nextA = text.indexOf("[", i);
      const candidates = [next, nextA].filter((x) => x >= 0);
      if (!candidates.length) break;
      i = Math.min(...candidates);
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < n; i++) {
      const c = text[i]!;
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === "\\") {
          escape = true;
        } else if (c === "\"") {
          inString = false;
        }
        continue;
      }
      if (c === "\"") {
        inString = true;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          i++;
          const slice = text.slice(start, i);
          try {
            values.push(JSON.parse(slice));
          } catch {
            /* skip invalid */
          }
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return values;
}

/** Parse file body that may be JSON or JSONL (Claude Code / collector dump). */
export function parseOtelText(text: string): OtelSpanLike[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Prefer single JSON document
  try {
    return parseOtelJson(JSON.parse(trimmed));
  } catch {
    /* multi-doc / JSONL */
  }

  const spans: OtelSpanLike[] = [];
  for (const value of extractJsonValues(trimmed)) {
    spans.push(...parseOtelJson(value));
  }
  return spans;
}

function attrString(a: Record<string, string | number | boolean | string[]>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

function isPathLike(s: string): boolean {
  if (!s || s.length > 1024) return false;
  if (s.includes("\n") || s.includes("\0")) return false;
  // Heuristic: repo-relative or absolute paths agents touch
  return (
    s.includes("/") ||
    s.endsWith(".sql") ||
    s.endsWith(".ts") ||
    s.endsWith(".py") ||
    s.endsWith(".go") ||
    s.endsWith(".yml") ||
    s.endsWith(".yaml") ||
    s.endsWith(".json") ||
    s.endsWith(".md")
  );
}

function collectPathsFromAttrs(a: Record<string, string | number | boolean | string[]>, files: Set<string>): void {
  const pathKeys = [
    "file.path",
    "code.file.path",
    "code.filepath",
    "filepath",
    "path",
    "claude_code.tool.file_path",
    "claude.tool.file_path",
    "gen_ai.tool.call.arguments.file_path",
    "input.file.path",
    "output.file.path",
  ];
  for (const k of pathKeys) {
    const v = a[k];
    if (typeof v === "string" && isPathLike(v)) files.add(v);
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && isPathLike(item)) files.add(item);
    }
  }
  // Nested path lists some exporters put under tool result metadata keys
  for (const [k, v] of Object.entries(a)) {
    if (!/path|file/i.test(k)) continue;
    if (typeof v === "string" && isPathLike(v)) files.add(v);
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && isPathLike(item)) files.add(item);
    }
  }
}

export function agentFactsFromOtel(spans: OtelSpanLike[]): {
  session_id?: string;
  model_identifier?: { value?: string; assurance: AssuranceClass };
  files_touched: string[];
  span_count: number;
  otlp_encoded: boolean;
} {
  const files = new Set<string>();
  let session_id: string | undefined;
  let model: string | undefined;
  let otlp_encoded = false;

  for (const span of spans) {
    if (span._otlpAttributeCount != null) otlp_encoded = true;
    const a = span.attributes ?? {};

    session_id =
      session_id ??
      attrString(
        a,
        "claude.session_id",
        "claude_code.session.id",
        "session.id",
        "gen_ai.conversation.id",
        "conversation.id"
      );

    model =
      model ??
      attrString(
        a,
        "gen_ai.request.model",
        "gen_ai.response.model",
        "llm.request.model",
        "model"
      );

    collectPathsFromAttrs(a, files);

    // Span name sometimes encodes tool + path for Claude Code style traces
    if (span.name && /edit|write|read|bash|tool/i.test(span.name)) {
      /* paths already from attrs */
    }
  }

  return {
    session_id,
    model_identifier: model
      ? { value: model, assurance: "declared" }
      : { assurance: "unknown" },
    files_touched: [...files].sort(),
    span_count: spans.length,
    otlp_encoded,
  };
}
