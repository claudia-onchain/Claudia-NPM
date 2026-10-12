// Optional packages, loaded on demand so the CLI stays small: @useclaudia/media (generate) and @useclaudia/social
// (post to networks). The types below are the parts of their published contract the CLI uses.
import { CliError, EXIT } from "./context.js";
import type { KeyProvider } from "./keystore.js";

// ─── media ────────────────────────────────────────────────────────────

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx" | "avatar";
export interface ModelInfo { id: string; provider: string; kind: MediaKind; label: string; caps: Record<string, unknown>; priceHint?: string; retired?: boolean }
export interface GenerateRequest {
  kind: MediaKind; model?: string; prompt?: string; negativePrompt?: string; text?: string; voice?: string; refs?: string[];
  aspect?: "1:1" | "16:9" | "9:16" | "4:5" | "3:2" | "2:3"; resolution?: string; durationSec?: number; n?: number; seed?: number; brand?: string; meta?: Record<string, unknown>;
}
export interface Estimate { usd: number; low?: number; high?: number; basis: string; confidence: "exact" | "list" | "estimate" }
export type JobStatus = "needs_approval" | "queued" | "running" | "downloading" | "succeeded" | "failed" | "blocked" | "expired" | "canceled";
export interface MediaOutput { path: string; mime: string; bytes: number; width?: number; height?: number; durationSec?: number; sha256: string }
export interface Job {
  id: string; status: JobStatus; request: GenerateRequest; model: string; provider: string; estimate: Estimate; createdAt: number; updatedAt: number;
  progress?: number; outputs: MediaOutput[]; error?: { code: string; message: string; hint?: string };
}
export interface HttpPreview { method: string; url: string; headers: Record<string, string>; body?: unknown }
export interface MediaDryRun { dryRun: true; request: HttpPreview; estimate: Estimate }
export interface Media {
  providers(): Promise<{ id: string; name: string; kinds: MediaKind[]; configured: boolean; docs: string }[]>;
  models(filter?: { kind?: MediaKind; provider?: string }): ModelInfo[];
  estimate(req: GenerateRequest): Estimate;
  generate(req: GenerateRequest, opts?: { dryRun?: boolean; approve?: boolean }): Promise<Job | MediaDryRun>;
  getJob(id: string): Job | null;
  approve(id: string): Promise<Job>;
  cancel(id: string): Promise<Job>;
  wait(id: string, opts?: { timeoutMs?: number }): Promise<Job>;
  spend(): { today: number; month: number; byProvider: Record<string, { today: number; month: number }> };
  on(ev: "job", cb: (j: Job) => void): void;
  off?(ev: "job", cb: (j: Job) => void): void;
  close(): Promise<void>;
}
interface MediaModule {
  createMedia(opts: { keys: KeyProvider; dataDir?: string; limits?: Record<string, unknown>; dryRun?: boolean }): Media;
}

// ─── social ───────────────────────────────────────────────────────────

export const NETWORK_IDS = ["x", "telegram", "discord", "bluesky", "mastodon", "farcaster", "nostr", "linkedin", "youtube", "buffer", "zernio", "upload-post", "instagram", "facebook", "threads", "tiktok", "pinterest"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];
export interface NetworkInfo {
  id: NetworkId; name: string; tier: string; auth: "oauth-loopback" | "oauth-relay" | "key" | "service";
  caps: Record<string, boolean>; limits: { maxChars?: number; maxImages?: number; maxVideoMb?: number; perDay?: number }; costHint?: string; setup: string; docs: string;
}
export interface Account { id: string; network: NetworkId; handle: string; name?: string; avatar?: string; connectedAt: number; expiresAt?: number; via?: NetworkId }
export interface PostInput {
  text: string; media?: { path: string; mime?: string; alt?: string }[]; link?: string; thread?: string[]; replyTo?: { network: NetworkId; id: string };
  targets: { account: string; text?: string }[]; scheduleAt?: number; labels?: { ai?: boolean; ad?: boolean; nfa?: boolean };
}
export interface Post { id: string; status: string; input: PostInput; createdAt: number; updatedAt: number; results: { account: string; network: NetworkId; status: string; url?: string; remoteId?: string; error?: string; at?: number }[] }
export interface Preview { account: string; network: NetworkId; text: string; chars: number; media: number; labelsAdded: string[]; costUsd?: number; warnings: string[]; blocked?: string }
export interface Social {
  networks(): NetworkInfo[];
  connect(network: NetworkId, params?: Record<string, string>, opts?: { dryRun?: boolean }): Promise<Account | { authorizeUrl: string; state: string; redirectUri?: string } | { dryRun: true; requests: HttpPreview[] }>;
  completeOAuth(state: string, code: string): Promise<Account>;
  disconnect(accountId: string): Promise<void>;
  accounts(): Account[];
  draft(input: PostInput): Post;
  preview(id: string): Preview[];
  submit(id: string): Post;
  approve(id: string): Post;
  reject(id: string, why?: string): Post;
  publish(id: string, opts?: { dryRun?: boolean }): Promise<Post | { dryRun: true; requests: HttpPreview[] }>;
  killSwitch(on?: boolean): boolean;
  /** 0.2: resolves once stored accounts are loaded. */
  ready?(): Promise<void>;
  close(): Promise<void>;
}
interface SocialModule {
  waitForOAuthCallback?(port: number, opts?: { timeoutMs?: number; path?: string }): Promise<{ code?: string; state?: string; error?: string }>;
  createSocial(opts: { keys: KeyProvider; dataDir?: string; dryRun?: boolean; loopbackPort?: number; relayUrl?: string; mediaRelay?: { url: string; token: () => Promise<string | null> } }): Social;
}

// ─── loading ──────────────────────────────────────────────────────────

async function load<T>(name: string, what: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find (package|module)/.test((e as Error).message)) {
      throw new CliError(EXIT.SETUP, "missing_package", `${what} needs the ${name} package.`, `npm i -g ${name}   (next to the CLI; it brings no keys of ours — you use your own)`);
    }
    throw e;
  }
}

export const loadMedia = () => load<MediaModule>("@useclaudia/media", "Generating images, video and audio");
export const loadSocial = () => load<SocialModule>("@useclaudia/social", "Posting to social networks");

/** Whether an optional package resolves (for doctor), with its version. */
export async function probe(name: string): Promise<string | null> {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve(`${name}/package.json`);
    const { readFileSync } = await import("node:fs");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  } catch {
    try {
      await import(/* @vite-ignore */ name);
      return "installed";
    } catch {
      return null;
    }
  }
}
