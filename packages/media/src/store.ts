import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** `opts.dataDir` → $CLAUDIA_HOME → ~/.claudia */
export function resolveDataDir(dataDir?: string): string {
  return dataDir || process.env.CLAUDIA_HOME || join(homedir(), ".claudia");
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function writeBytesAtomic(file: string, bytes: Uint8Array): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, file);
}

export function appendLine(file: string, value: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
}

export function readLines<T>(file: string): T[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn last line
    }
  }
  return out;
}

export function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
