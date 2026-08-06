/**
 * Cryptographic signing for VeriForge Execution Receipts.
 *
 * Paths:
 * 1. Node DSSE (ECDSA P-256) — offline, unit-testable, Cosign-compatible curve
 * 2. Cosign CLI (`attest-blob` / `sign-blob`) — Sigstore bundle + Rekor when available
 */
import { createPrivateKey, createPublicKey, createHash, sign, verify, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { DsseEnvelope, InTotoStatement } from "./types.js";
import { statementToJson, envelopePayloadBase64 } from "./receipt.js";

export type SigningMethod = "none" | "node_dsse" | "cosign";

export interface SignOptions {
  /** PEM private key (PKCS#8) for node_dsse */
  privateKeyPem?: string;
  /** Path to PEM private key */
  privateKeyPath?: string;
  /** Path to PEM public key (optional; derived when possible) */
  publicKeyPath?: string;
  /** Cosign private key path (`cosign.key`) */
  cosignKeyPath?: string;
  /** Use Cosign keyless signing via ambient OIDC (GitHub Actions id-token, etc.) */
  cosignKeyless?: boolean;
  /** Override cosign binary (default: cosign on PATH) */
  cosignBin?: string;
  /** Key id embedded in DSSE signatures */
  keyId?: string;
  method?: SigningMethod;
  /** Working dir for temp subject files (cosign) */
  workDir?: string;
}

export interface SignResult {
  method: SigningMethod;
  bundle: DsseEnvelope;
  /** Cosign/Sigstore bundle path when method=cosign */
  sigstoreBundlePath?: string;
  keyId: string;
}

/** DSSE Pre-Authentication Encoding (v1). */
export function dssePae(payloadType: string, payloadBody: Buffer): Buffer {
  const typeBuf = Buffer.from(payloadType, "utf8");
  const sp = Buffer.from(" ", "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1", "utf8"),
    sp,
    Buffer.from(String(typeBuf.length), "utf8"),
    sp,
    typeBuf,
    sp,
    Buffer.from(String(payloadBody.length), "utf8"),
    sp,
    payloadBody,
  ]);
}

export function publicKeyIdFromPem(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url");
}

export function generateDevKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function signStatementNodeDsse(
  statement: InTotoStatement,
  privateKeyPem: string,
  keyId?: string
): DsseEnvelope {
  const payloadType = "application/vnd.in-toto+json" as const;
  const body = Buffer.from(statementToJson(statement), "utf8");
  const payload = body.toString("base64");
  const pae = dssePae(payloadType, body);
  const privateKey = createPrivateKey(privateKeyPem);
  const sig = sign("sha256", pae, privateKey);
  let kid = keyId;
  if (!kid) {
    try {
      const pub = createPublicKey(privateKey);
      const pubPem = pub.export({ type: "spki", format: "pem" }).toString();
      kid = publicKeyIdFromPem(pubPem);
    } catch {
      kid = "veriforge-node-dsse";
    }
  }
  return {
    payloadType,
    payload,
    signatures: [{ keyid: kid, sig: sig.toString("base64") }],
  };
}

export function verifyDsseEnvelope(
  envelope: DsseEnvelope,
  publicKeyPem: string
): boolean {
  if (!envelope.signatures?.length) return false;
  const body = Buffer.from(envelope.payload, "base64");
  const pae = dssePae(envelope.payloadType, body);
  const publicKey = createPublicKey(publicKeyPem);
  return envelope.signatures.some((s) => {
    try {
      return verify("sha256", pae, publicKey, Buffer.from(s.sig, "base64"));
    } catch {
      return false;
    }
  });
}

async function loadPrivateKeyPem(opts: SignOptions): Promise<string> {
  if (opts.privateKeyPem) return opts.privateKeyPem;
  if (opts.privateKeyPath) return readFile(opts.privateKeyPath, "utf8");
  throw new Error("node_dsse requires privateKeyPem or privateKeyPath");
}

/**
 * Sign with Cosign: prefers `attest-blob` (DSSE + in-toto) producing a Sigstore bundle.
 * Falls back to extracting dsseEnvelope into our bundle shape.
 */
export async function signWithCosign(
  statement: InTotoStatement,
  opts: SignOptions
): Promise<SignResult> {
  const cosignBin = opts.cosignBin ?? "cosign";
  const keyPath = opts.cosignKeyPath ?? opts.privateKeyPath;

  const workDir = opts.workDir ?? process.cwd();
  const scratch = `${workDir}/.veriforge-sign`;
  await mkdir(scratch, { recursive: true });

  const predicatePath = `${scratch}/predicate.json`;
  const subjectPath = `${scratch}/subject.bin`;
  const bundlePath = `${workDir}/execution-receipt.sigstore.json`;

  await writeFile(predicatePath, JSON.stringify(statement.predicate, null, 2), "utf8");
  // Subject content: name + digest material for stable offline runs
  const subjectPayload = JSON.stringify({
    name: statement.subject[0]?.name ?? "git-commit",
    digest: statement.subject[0]?.digest ?? {},
  });
  await writeFile(subjectPath, subjectPayload, "utf8");

  const args = ["attest-blob"];
  if (keyPath) {
    args.push("--key", keyPath);
  }
  args.push(
    "--predicate",
    predicatePath,
    "--type",
    statement.predicateType,
    "--yes",
    "--bundle",
    bundlePath,
    subjectPath
  );

  const env = { ...process.env };
  if (!env.COSIGN_PASSWORD) env.COSIGN_PASSWORD = "";

  const result = spawnSync(cosignBin, args, {
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      `cosign attest-blob failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}`
    );
  }

  if (!existsSync(bundlePath)) {
    throw new Error(`cosign did not write bundle at ${bundlePath}`);
  }

  const sigstore = JSON.parse(await readFile(bundlePath, "utf8")) as {
    dsseEnvelope?: DsseEnvelope;
  };

  if (!sigstore.dsseEnvelope?.payload) {
    // Fallback: sign-blob the full statement
    return signBlobWithCosign(statement, opts, bundlePath, cosignBin, keyPath, env);
  }

  const dsse = sigstore.dsseEnvelope;
  const keyId = opts.keyId ?? dsse.signatures?.[0]?.keyid ?? (keyPath ? "cosign" : "sigstore-keyless");
  return {
    method: "cosign",
    bundle: {
      payloadType: dsse.payloadType ?? "application/vnd.in-toto+json",
      payload: dsse.payload,
      signatures: (dsse.signatures ?? []).map((s) => ({
        keyid: s.keyid ?? keyId,
        sig: s.sig,
      })),
    },
    sigstoreBundlePath: bundlePath,
    keyId,
  };
}

async function signBlobWithCosign(
  statement: InTotoStatement,
  opts: SignOptions,
  bundlePath: string,
  cosignBin: string,
  keyPath: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<SignResult> {
  const workDir = opts.workDir ?? process.cwd();
  const scratch = `${workDir}/.veriforge-sign`;
  await mkdir(scratch, { recursive: true });
  const stmtPath = `${scratch}/statement.json`;
  await writeFile(stmtPath, statementToJson(statement), "utf8");

  const args = ["sign-blob"];
  if (keyPath) {
    args.push("--key", keyPath);
  }
  args.push("--yes", "--bundle", bundlePath, stmtPath);
  const result = spawnSync(cosignBin, args, { env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `cosign sign-blob failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}`
    );
  }

  // sign-blob uses messageSignature; wrap statement as unsigned-payload DSSE-shaped with pointer
  const payload = envelopePayloadBase64(statement);
  return {
    method: "cosign",
    bundle: {
      payloadType: "application/vnd.in-toto+json",
      payload,
      signatures: [
        {
          keyid: opts.keyId ?? (keyPath ? "cosign-sign-blob" : "sigstore-keyless-sign-blob"),
          sig: Buffer.from(`sigstore-bundle:${bundlePath}`, "utf8").toString("base64"),
        },
      ],
    },
    sigstoreBundlePath: bundlePath,
    keyId: opts.keyId ?? (keyPath ? "cosign-sign-blob" : "sigstore-keyless-sign-blob"),
  };
}

export async function signStatement(
  statement: InTotoStatement,
  opts: SignOptions
): Promise<SignResult> {
  const method: SigningMethod =
    opts.method ??
    (opts.cosignKeyPath || opts.cosignKeyless || opts.method === "cosign"
      ? "cosign"
      : opts.privateKeyPem || opts.privateKeyPath
        ? "node_dsse"
        : "none");

  if (method === "none") {
    const { buildUnsignedBundle } = await import("./receipt.js");
    const bundle = buildUnsignedBundle(statement);
    return { method: "none", bundle, keyId: bundle.signatures[0]?.keyid ?? "unsigned" };
  }

  if (method === "cosign") {
    return signWithCosign(statement, opts);
  }

  const pem = await loadPrivateKeyPem(opts);
  const bundle = signStatementNodeDsse(statement, pem, opts.keyId);
  return {
    method: "node_dsse",
    bundle,
    keyId: bundle.signatures[0]?.keyid ?? "node_dsse",
  };
}

export function whichCosign(bin = "cosign"): string | null {
  const r = spawnSync(bin, ["version"], { encoding: "utf8" });
  return r.status === 0 ? bin : null;
}
