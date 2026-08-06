#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function usage() {
  console.log(`capture-otlp-session — tiny local OTLP/HTTP trace capture for VeriForge

Usage:
  node scripts/capture-otlp-session.mjs --out .veriforge/otel-export.jsonl [--port 4318] [--host 127.0.0.1]

Point Claude Code (or another OTLP/HTTP exporter) at the listener:
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_TRACES_EXPORTER=otlp
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
  export OTEL_METRICS_EXPORTER=none
  export OTEL_LOGS_EXPORTER=none

Then run the agent session and stop this process with Ctrl-C. The output is JSONL:
one OTLP ExportTraceServiceRequest per line, ingestible via veriforge-attest --otel.
`);
}

function parseArgs(argv) {
  const args = { host: "127.0.0.1", port: 4318, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true, ...args };
    if (a === "--out") args.out = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.out) throw new Error("missing --out PATH");
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return args;
}

function collectOtlpFacts(raw) {
  let resourceSpanCount = 0;
  let spanCount = 0;
  let sessionId;
  let model;

  for (const resourceSpan of raw.resourceSpans ?? []) {
    resourceSpanCount++;
    const resourceAttrs = attrsToMap(resourceSpan?.resource?.attributes);
    sessionId ??= firstAttr(resourceAttrs, [
      "claude_code.session.id",
      "claude.session_id",
      "gen_ai.conversation.id",
      "conversation.id",
      "session.id",
    ]);
    for (const scopeSpan of resourceSpan?.scopeSpans ?? []) {
      for (const span of scopeSpan?.spans ?? []) {
        spanCount++;
        const attrs = attrsToMap(span?.attributes);
        sessionId ??= firstAttr(attrs, [
          "claude_code.session.id",
          "claude.session_id",
          "gen_ai.conversation.id",
          "conversation.id",
          "session.id",
        ]);
        model ??= firstAttr(attrs, [
          "gen_ai.request.model",
          "gen_ai.response.model",
          "llm.request.model",
          "model",
        ]);
      }
    }
  }

  return { resourceSpanCount, spanCount, sessionId, model };
}

function attrsToMap(attrs) {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (const item of attrs) {
    if (!item || typeof item.key !== "string") continue;
    const v = anyValue(item.value);
    if (v !== undefined) out[item.key] = v;
  }
  return out;
}

function anyValue(v) {
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "number") return v.intValue;
  if (typeof v.intValue === "string") return v.intValue;
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return undefined;
}

function firstAttr(attrs, keys) {
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return undefined;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, out }));
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/traces") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "send OTLP traces with POST /v1/traces" }));
        return;
      }

      const body = await readRequestBody(req);
      const raw = JSON.parse(body);
      const facts = collectOtlpFacts(raw);
      if (facts.resourceSpanCount === 0 || facts.spanCount === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected OTLP JSON with resourceSpans[].scopeSpans[].spans[]" }));
        return;
      }

      await appendFile(out, `${JSON.stringify(raw)}\n`, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ partialSuccess: {}, spans: facts.spanCount }));
      console.log(
        `captured /v1/traces spans=${facts.spanCount}` +
          (facts.sessionId ? ` session=${facts.sessionId}` : " session=unknown") +
          (facts.model ? ` model=${facts.model}` : "") +
          ` out=${out}`
      );
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(args.port, args.host, () => {
    console.log(`OTLP capture listening on http://${args.host}:${args.port}/v1/traces`);
    console.log(`Writing OTLP JSONL to ${out}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
