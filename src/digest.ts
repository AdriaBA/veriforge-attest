import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function digestFile(path: string): Promise<Record<string, string>> {
  const buf = await readFile(path);
  return { sha256: sha256Hex(buf) };
}

export function subjectForCommit(headCommit: string, name = "git-commit"): {
  name: string;
  digest: Record<string, string>;
} {
  return {
    name,
    digest: { sha1: headCommit },
  };
}