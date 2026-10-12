// The shape every provider connector follows:
//   capabilities (the model table) → estimate (price spec) → submit → poll → download.
// Connectors never call fetch directly; they use ctx.http, which goes through the shared transport
// (so dry runs, mocks and error mapping behave the same everywhere).
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ClaudiaMediaError } from "../errors.js";
import { mimeFromPath, sniff } from "../sniff.js";
import type { HttpRequest, HttpResponse } from "../transport.js";
import type { DryRunRequest, GenerateRequest, MediaKind, ProviderId } from "../types.js";
import type { ModelEntry } from "../models.js";

/** Something the provider produced: inline bytes, or a URL we still have to download. */
export interface RemoteOutput {
  url?: string;
  bytes?: Uint8Array;
  mime?: string;
  /** Send the provider key with the download (Google file URIs need it). */
  auth?: boolean;
  durationSec?: number;
}

export type Step =
  | { state: "done"; outputs: RemoteOutput[]; costUsd?: number }
  | { state: "running"; remote: Record<string, unknown>; progress?: number; expiresAt?: number }
  | { state: "failed"; code?: "blocked" | "provider_error" | "expired" | "invalid"; message: string; hint?: string };

export interface LoadedRef {
  source: string;
  name: string;
  mime: string;
  /** Present for local files, or URLs we fetched because the provider needs bytes. */
  bytes?: Uint8Array;
  /** http(s) URL or data: URI. */
  url?: string;
}

export interface Ctx {
  key: string;
  model: ModelEntry;
  /** The request after brand kit + defaults were applied. */
  req: GenerateRequest;
  dry: boolean;
  http(r: HttpRequest): Promise<HttpResponse>;
  /** Refs as bytes (URLs are fetched; in a dry run they are left as a placeholder). */
  refBytes(): Promise<LoadedRef[]>;
  /** Refs as URLs (local files become data: URIs). */
  refUrls(): Promise<LoadedRef[]>;
}

export interface Connector {
  id: ProviderId;
  name: string;
  kinds: MediaKind[];
  /** Where the request shapes were checked. */
  docs: string;
  /** Where to create a key. */
  keyUrl: string;
  terms: string;
  /** Builds headers carrying the key. */
  auth(key: string): Record<string, string>;
  submit(ctx: Ctx): Promise<Step>;
  poll?(ctx: Ctx, remote: Record<string, unknown>): Promise<Step>;
  /** Default: GET the URL (with auth headers when `out.auth`). */
  download?(ctx: Ctx, out: RemoteOutput): Promise<{ bytes: Uint8Array; mime?: string }>;
  cancel?(ctx: Ctx, remote: Record<string, unknown>): Promise<void>;
  /** Remote model ids the key can see, for checkModels(). Return null when the provider has no list endpoint. */
  listModels?(ctx: Omit<Ctx, "model" | "req">): Promise<string[] | null>;
}

/** Thrown by ctx.http in dry-run mode; generate() turns it into a DryRun result. */
export class DryCapture extends Error {
  constructor(readonly request: DryRunRequest) {
    super("dry run");
  }
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || s.startsWith("data:");
}

export function readLocalRef(p: string): LoadedRef {
  let bytes: Uint8Array;
  try {
    if (!statSync(p).isFile()) throw new Error("not a file");
    bytes = new Uint8Array(readFileSync(p));
  } catch {
    throw new ClaudiaMediaError("invalid", `Reference file not found: ${p}`, { hint: "Pass an existing local path or an https URL." });
  }
  const mime = sniff(bytes).mime ?? mimeFromPath(p) ?? "application/octet-stream";
  return { source: p, name: basename(p), mime, bytes };
}

export function dataUri(r: LoadedRef): string {
  return `data:${r.mime};base64,${Buffer.from(r.bytes ?? new Uint8Array()).toString("base64")}`;
}

export function b64(bytes: Uint8Array | undefined): string {
  return Buffer.from(bytes ?? new Uint8Array()).toString("base64");
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export const isImage = (r: LoadedRef) => r.mime.startsWith("image/");
export const isAudio = (r: LoadedRef) => r.mime.startsWith("audio/");
export const isVideo = (r: LoadedRef) => r.mime.startsWith("video/");

/** Merge `meta.providerOptions` into a body (escape hatch for fields we don't model). */
export function withProviderOptions<T extends Record<string, unknown>>(body: T, req: GenerateRequest): T {
  const extra = req.meta?.providerOptions;
  return extra && typeof extra === "object" ? { ...body, ...(extra as Record<string, unknown>) } : body;
}

export function strip<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function unsupported(what: string, hint?: string): never {
  throw new ClaudiaMediaError("unsupported", what, { hint });
}
