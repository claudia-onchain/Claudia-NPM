import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, extname } from "node:path";

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDIA_HOME?.trim() || join(homedir(), ".claudia");
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Atomic JSON write (tmp + rename), 0600. */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function appendLine(file: string, obj: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify(obj) + "\n", { mode: 0o600 });
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

export function sha256b64url(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
};

export function mimeOf(path: string, given?: string): string {
  if (given) return given;
  const clean = path.split("?")[0]!;
  return MIME[extname(clean).toLowerCase()] ?? "application/octet-stream";
}

export function extOf(mime: string): string {
  for (const [k, v] of Object.entries(MIME)) if (v === mime) return k.slice(1);
  return "bin";
}

export const isUrl = (s: string) => /^https?:\/\//i.test(s);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  return u.toString();
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export const DAY_MS = 24 * 60 * 60 * 1000;
