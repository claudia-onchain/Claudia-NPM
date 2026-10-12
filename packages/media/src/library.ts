// Local media library: <dataDir>/media/library/YYYY-MM/<jobId>-<n>.<ext> plus a <file>.json provenance sidecar.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { extFor, sniff } from "./sniff.js";
import { writeBytesAtomic, writeJsonAtomic } from "./store.js";
import type { MediaOutput, Provenance } from "./types.js";

export function libraryDir(mediaDir: string, at = Date.now()): string {
  const d = new Date(at);
  return join(mediaDir, "library", `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
}

export function saveOutput(
  mediaDir: string,
  jobId: string,
  index: number,
  bytes: Uint8Array,
  mimeHint: string | undefined,
  provenance: Provenance,
  extra: { durationSec?: number } = {},
): MediaOutput {
  const s = sniff(bytes);
  const mime = s.mime ?? (mimeHint && mimeHint !== "application/octet-stream" ? mimeHint.split(";")[0]!.trim() : "application/octet-stream");
  const file = join(libraryDir(mediaDir), `${jobId}-${index + 1}.${extFor(mime)}`);
  writeBytesAtomic(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const out: MediaOutput = { path: file, mime, bytes: bytes.byteLength, sha256 };
  if (s.width) out.width = s.width;
  if (s.height) out.height = s.height;
  const dur = s.durationSec ?? extra.durationSec;
  if (dur) out.durationSec = dur;
  writeJsonAtomic(`${file}.json`, { jobId, output: out, provenance });
  return out;
}
