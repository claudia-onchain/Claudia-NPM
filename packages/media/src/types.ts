// Public types for @useclaudia/media. The names and shapes in this file are the shared contract
// (CONTRACTS.md, "@useclaudia/media API"). Additive optional fields are marked "(extension)".

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx" | "avatar";

export type ProviderId = "google" | "openai" | "fal" | "elevenlabs" | "heygen" | "runway" | "byteplus";

/** Where a price comes from. "list" = read off the provider's public price page; "estimate" = our arithmetic or a guess. */
export interface PriceInfo {
  /** Plain-English basis, e.g. "$0.15 per second of 720p/1080p video". */
  basis: string;
  confidence: "list" | "estimate";
  /** Date the price was checked (YYYY-MM-DD). */
  asOf: string;
  /** Page the price was read from. */
  url?: string;
}

export interface ModelInfo {
  /** Claudia model id, `<provider>/<name>`, e.g. "google/veo-3.1-fast". */
  id: string;
  provider: string;
  kind: MediaKind;
  label: string;
  /** What the model accepts: aspects, durations, resolutions, refs, audio, transparent, voices… */
  caps: Record<string, unknown>;
  priceHint?: string;
  /** The provider retired (or announced the retirement of) this model. `generate()` refuses retired models. */
  retired?: boolean;
  /** (extension) Price basis with confidence and date. */
  price?: PriceInfo;
  /** (extension) The provider docs page the request shape was checked against. */
  docs?: string;
  /** (extension) The provider-side model / endpoint id could not be confirmed in the provider's docs. */
  unverified?: boolean;
  /** (extension) The id the provider uses (model name or endpoint path). */
  remoteId?: string;
}

export interface GenerateRequest {
  kind: MediaKind;
  /** Claudia model id ("google/veo-3.1-fast"). Leave empty to use the default for the kind. */
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  /** Speech: the words to say. Avatar: the script. */
  text?: string;
  /** Provider voice id / name. */
  voice?: string;
  /** Local paths or http(s) URLs. Images for image/video/avatar, audio or video for lip-sync. */
  refs?: string[];
  aspect?: "1:1" | "16:9" | "9:16" | "4:5" | "3:2" | "2:3";
  resolution?: string;
  durationSec?: number;
  n?: number;
  seed?: number;
  /** Brand-kit id, e.g. "claudia". */
  brand?: string;
  /** Free-form extras. Known keys: `avatarId` (HeyGen), `quality` / `background` (OpenAI image), `style` (speech instructions), `providerOptions` (merged into the provider body). */
  meta?: Record<string, unknown>;
}

export interface Estimate {
  usd: number;
  low?: number;
  high?: number;
  basis: string;
  confidence: "exact" | "list" | "estimate";
}

export type JobStatus =
  | "needs_approval"
  | "queued"
  | "running"
  | "downloading"
  | "succeeded"
  | "failed"
  | "blocked"
  | "expired"
  | "canceled";

export interface MediaOutput {
  path: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  sha256: string;
}

export interface Provenance {
  prompt?: string;
  model: string;
  provider: string;
  costUsd?: number;
  /** e.g. "SynthID", "C2PA", "SynthID + C2PA". */
  watermark?: string;
  /** Provider terms URL. */
  terms?: string;
  at: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  request: GenerateRequest;
  model: string;
  provider: string;
  estimate: Estimate;
  createdAt: number;
  updatedAt: number;
  /** 0..1 when the provider reports it. */
  progress?: number;
  outputs: MediaOutput[];
  error?: { code: string; message: string; hint?: string };
  provenance: Provenance;
}

export interface SpendLimits {
  perJobUsd?: number;
  perDayUsd?: number;
  perMonthUsd?: number;
  approveAboveUsd?: number;
  perProvider?: Record<string, Omit<SpendLimits, "perProvider">>;
}

export interface Brand {
  id: string;
  name: string;
  /** Reference images (local paths or URLs) applied when a request has none. */
  refs: string[];
  voice?: { provider: string; voiceId: string };
  /** Short style text appended to image / video / avatar prompts. */
  style?: string;
  /** Words that must never appear in a prompt for this brand (the request is refused). */
  banned?: string[];
}

export interface DryRunRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface DryRun {
  dryRun: true;
  request: DryRunRequest;
  estimate: Estimate;
}

export interface ProviderSummary {
  id: string;
  name: string;
  kinds: MediaKind[];
  configured: boolean;
  docs: string;
}

export interface SpendSummary {
  today: number;
  month: number;
  byProvider: Record<string, { today: number; month: number }>;
}

/** Host-supplied secret store. Names: "google", "openai", "fal", "elevenlabs", "heygen", "runway", "byteplus". */
export interface KeyProvider {
  get(name: string): Promise<string | null> | string | null;
}

export interface MediaOptions {
  keys: KeyProvider;
  /** Defaults to $CLAUDIA_HOME or ~/.claudia. Media files live in <dataDir>/media. */
  dataDir?: string;
  limits?: SpendLimits;
  fetch?: typeof fetch;
  dryRun?: boolean;
  /** Jobs running at once per provider. Defaults: heygen 1, runway 1, everything else 2. */
  concurrency?: Record<string, number>;
  /** (extension) Poll timing. Defaults: first poll after 5 s, backoff x1.5 up to 15 s. */
  poll?: { minMs?: number; maxMs?: number };
  /** (extension) Seed the default "claudia" brand kit (default true). */
  defaultBrand?: boolean;
}

export type JobListener = (job: Job) => void;

export interface CheckModelsResult {
  provider: string;
  checked: boolean;
  /** Our model ids the provider no longer lists. */
  missing: string[];
  /** Our model ids marked retired. */
  retired: string[];
  note?: string;
  dryRun?: DryRunRequest;
}

export interface Media {
  providers(): Promise<ProviderSummary[]>;
  models(filter?: { kind?: MediaKind; provider?: string }): ModelInfo[];
  estimate(req: GenerateRequest): Estimate;
  /** Returns right away with a queued (or needs_approval) job, or a DryRun when dry. */
  generate(req: GenerateRequest, opts?: { dryRun?: boolean; approve?: boolean }): Promise<Job | DryRun>;
  getJob(id: string): Job | null;
  listJobs(f?: { status?: JobStatus; limit?: number }): Job[];
  approve(id: string): Promise<Job>;
  cancel(id: string): Promise<Job>;
  /** Resolves when the job is finished or waiting for approval; on timeout it resolves with the job as it is. */
  wait(id: string, opts?: { timeoutMs?: number }): Promise<Job>;
  spend(): SpendSummary;
  brands: { list(): Brand[]; get(id: string): Brand | null; save(b: Brand): Brand };
  on(ev: "job", cb: JobListener): void;
  /** (extension) */
  off(ev: "job", cb: JobListener): void;
  /** (extension) Report models a provider no longer lists. With dryRun it only returns the request it would send. */
  checkModels(opts?: { provider?: string; dryRun?: boolean }): Promise<CheckModelsResult[]>;
  close(): Promise<void>;
}
