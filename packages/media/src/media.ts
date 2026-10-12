// createMedia(): the job queue, spend control, library, brand kits and provider dispatch.
//
//   <dataDir>/media/jobs.json      jobs + the provider state needed to resume polling (atomic writes)
//   <dataDir>/media/spend.jsonl    spend ledger (append-only)
//   <dataDir>/media/brands.json    brand kits
//   <dataDir>/media/library/YYYY-MM/<jobId>-<n>.<ext>  (+ .json provenance sidecar)
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BrandStore } from "./brands.js";
import { Emitter } from "./emitter.js";
import { ClaudiaMediaError, toJobError } from "./errors.js";
import { chainKeys, envKeys } from "./keys.js";
import { saveOutput } from "./library.js";
import { MODELS, estimateFor, findModel, type ModelEntry } from "./models.js";
import { CONNECTORS } from "./providers/index.js";
import { DryCapture, isUrl, readLocalRef, type Connector, type Ctx, type LoadedRef, type RemoteOutput, type Step } from "./providers/base.js";
import { approvalThreshold, checkLimits, SpendLedger } from "./spend.js";
import { mimeFromPath } from "./sniff.js";
import { ensureDir, mtimeMs, readJson, resolveDataDir, writeJsonAtomic } from "./store.js";
import { createTransport, isDry, redactRequest, type HttpRequest, type HttpResponse, type Transport } from "./transport.js";
import type {
  CheckModelsResult,
  DryRun,
  Estimate,
  GenerateRequest,
  Job,
  JobListener,
  JobStatus,
  KeyProvider,
  Media,
  MediaKind,
  MediaOptions,
  ModelInfo,
  ProviderSummary,
} from "./types.js";

const KINDS: MediaKind[] = ["image", "video", "speech", "music", "sfx", "avatar"];
const TERMINAL: JobStatus[] = ["succeeded", "failed", "blocked", "expired", "canceled"];
const DEFAULT_CONCURRENCY: Record<string, number> = { heygen: 1, runway: 1 };
/** Give up on a job that is still "running" after this long. */
const MAX_RUN_MS = 6 * 60 * 60 * 1000;
const MAX_JOBS_KEPT = 1000;

interface JobRecord {
  job: Job;
  /** Provider state for polling (operation name, request id, task id…). Never contains secrets. */
  remote?: Record<string, unknown>;
  /** Outputs found but not downloaded yet (URLs only). */
  pending?: RemoteOutput[];
  costUsd?: number;
  /** Set while the submit request is in flight; a crash here means we can't know if the provider accepted it. */
  submitting?: boolean;
  nextAt?: number;
  delayMs?: number;
  failures?: number;
  startedAt?: number;
  expiresAt?: number;
  lease?: { pid: number; inst: string; at: number };
}

interface JobsFile {
  version: 1;
  jobs: JobRecord[];
}

function newId(): string {
  const t = Date.now().toString(36);
  return `mj_${t}${randomBytes(5).toString("hex")}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const clone = <T>(x: T): T => structuredClone(x);

function publicModel(m: ModelEntry): ModelInfo {
  const out: ModelInfo = {
    id: m.id,
    provider: m.provider,
    kind: m.kind,
    label: m.label,
    caps: clone(m.caps),
    priceHint: m.priceHint,
    price: clone(m.price),
    docs: m.docs,
    remoteId: m.remoteId,
  };
  if (m.retired) out.retired = true;
  if (m.unverified) out.unverified = true;
  return out;
}

export function createMedia(opts: MediaOptions): Media {
  if (!opts || !opts.keys) throw new ClaudiaMediaError("invalid", "createMedia needs `keys` (a KeyProvider)", { hint: "Pass envKeys() to read CLAUDIA_KEY_* variables." });
  const mediaDir = join(resolveDataDir(opts.dataDir), "media");
  ensureDir(mediaDir);
  const jobsFile = join(mediaDir, "jobs.json");
  const keys: KeyProvider = chainKeys(opts.keys, envKeys());
  const realTransport: Transport = createTransport({ fetch: opts.fetch });
  const ledger = new SpendLedger(mediaDir);
  const brands = new BrandStore(mediaDir, opts.defaultBrand !== false);
  const events = new Emitter();
  const minMs = Math.max(10, opts.poll?.minMs ?? 5_000);
  const maxMs = Math.max(minMs, opts.poll?.maxMs ?? 15_000);
  const inst = randomBytes(4).toString("hex");
  const configured = new Map<string, boolean>();
  const records = new Map<string, JobRecord>();
  const inflight = new Map<string, Promise<void>>();
  let lastWriteMtime = -1;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  // ---------- persistence ----------
  function load(): void {
    const file = readJson<JobsFile>(jobsFile, { version: 1, jobs: [] });
    for (const rec of file.jobs ?? []) {
      if (!rec?.job?.id) continue;
      const mine = records.get(rec.job.id);
      if (!mine || (rec.job.updatedAt > mine.job.updatedAt && !inflight.has(rec.job.id))) records.set(rec.job.id, rec);
    }
    lastWriteMtime = mtimeMs(jobsFile);
  }
  function syncFromDisk(): void {
    if (mtimeMs(jobsFile) !== lastWriteMtime) load();
  }
  function save(): void {
    syncFromDisk();
    let list = [...records.values()].sort((a, b) => a.job.createdAt - b.job.createdAt);
    if (list.length > MAX_JOBS_KEPT) {
      const drop = new Set(list.filter((r) => TERMINAL.includes(r.job.status)).slice(0, list.length - MAX_JOBS_KEPT).map((r) => r.job.id));
      for (const id of drop) records.delete(id);
      list = list.filter((r) => !drop.has(r.job.id));
    }
    writeJsonAtomic(jobsFile, { version: 1, jobs: list } satisfies JobsFile);
    lastWriteMtime = mtimeMs(jobsFile);
  }
  function update(rec: JobRecord, patch: Partial<Job>, emit = true): void {
    Object.assign(rec.job, patch, { updatedAt: Math.max(Date.now(), rec.job.updatedAt + 1) });
    save();
    if (emit) events.emit("job", clone(rec.job));
  }

  // ---------- keys / models ----------
  async function keyFor(provider: string): Promise<string | null> {
    let k: string | null = null;
    try {
      k = (await keys.get(provider)) ?? null;
    } catch {
      k = null;
    }
    configured.set(provider, !!k);
    return k;
  }
  function connectorFor(provider: string): Connector {
    const c = CONNECTORS[provider as keyof typeof CONNECTORS];
    if (!c) throw new ClaudiaMediaError("unsupported", `Unknown provider "${provider}"`);
    return c;
  }
  function defaultsFor(kind: MediaKind): ModelEntry[] {
    return MODELS.filter((m) => m.kind === kind && m.defaultRank !== undefined && !m.retired).sort((a, b) => a.defaultRank! - b.defaultRank!);
  }
  function resolveModelSync(req: GenerateRequest): ModelEntry {
    if (!req || !KINDS.includes(req.kind)) throw new ClaudiaMediaError("invalid", `Unknown kind "${req?.kind}"`, { hint: `Use one of: ${KINDS.join(", ")}.` });
    if (req.model) {
      const m = findModel(req.model);
      if (!m) throw new ClaudiaMediaError("invalid", `Unknown model "${req.model}"`, { hint: "List models with media.models({ kind })." });
      if (m.kind !== req.kind) throw new ClaudiaMediaError("invalid", `${m.id} makes ${m.kind}, not ${req.kind}`);
      return m;
    }
    const list = defaultsFor(req.kind);
    const pick = list.find((m) => configured.get(m.provider)) ?? list[0];
    if (!pick) throw new ClaudiaMediaError("unsupported", `No model for ${req.kind}`);
    return pick;
  }
  async function resolveModel(req: GenerateRequest): Promise<ModelEntry> {
    if (!req.model && KINDS.includes(req?.kind)) {
      for (const m of defaultsFor(req.kind)) {
        if (await keyFor(m.provider)) return m;
      }
    }
    return resolveModelSync(req);
  }

  // ---------- brand kits ----------
  function applyBrand(req: GenerateRequest, model: ModelEntry): GenerateRequest {
    const out: GenerateRequest = clone(req);
    if (!req.brand) return out;
    const b = brands.get(req.brand);
    if (!b) throw new ClaudiaMediaError("invalid", `Unknown brand "${req.brand}"`, { hint: "Create it with media.brands.save({...})." });
    const words = `${req.prompt ?? ""} ${req.text ?? ""}`.toLowerCase();
    const hit = (b.banned ?? []).find((w) => w && words.includes(w.toLowerCase()));
    if (hit) throw new ClaudiaMediaError("blocked", `The ${b.name} brand kit bans "${hit}"`, { hint: "Reword the prompt, or edit the brand kit's banned list." });
    const visual = ["image", "video", "avatar"].includes(model.kind);
    const maxRefs = Number(model.caps.refs ?? 0);
    if (visual && !(out.refs?.length) && b.refs.length && maxRefs > 0) out.refs = b.refs.slice(0, maxRefs);
    else if (model.kind === "avatar" && b.refs.length && !(out.refs ?? []).some((r) => mimeFromPath(r)?.startsWith("image/")))
      out.refs = [b.refs[0]!, ...(out.refs ?? [])]; // the brand's face + the caller's audio/video
    if (visual && b.style && out.prompt !== undefined) out.prompt = `${out.prompt}\n\nStyle: ${b.style}`;
    else if (visual && b.style && model.kind !== "avatar") out.prompt = `Style: ${b.style}`;
    if ((model.kind === "speech" || model.kind === "avatar") && !out.voice && b.voice && b.voice.provider === model.provider) out.voice = b.voice.voiceId;
    return out;
  }

  // ---------- ctx ----------
  function makeCtx(connector: Connector, model: ModelEntry, req: GenerateRequest, key: string, dry: boolean): Ctx {
    const send = async (r: HttpRequest & { auth?: boolean }): Promise<HttpResponse> => {
      const { auth, ...rest } = r;
      const full: HttpRequest = { ...rest, label: connector.name, headers: { ...(auth === false ? {} : connector.auth(key)), ...(rest.headers ?? {}) } };
      if (dry) throw new DryCapture(redactRequest(full));
      const res = await realTransport(full);
      if (isDry(res)) throw new DryCapture(res.request);
      return res;
    };
    let bytesCache: Promise<LoadedRef[]> | null = null;
    let urlCache: Promise<LoadedRef[]> | null = null;
    const ctx: Ctx = {
      key,
      model,
      req,
      dry,
      http: send,
      refBytes() {
        return (bytesCache ??= Promise.all(
          (req.refs ?? []).map(async (ref) => {
            if (!isUrl(ref)) return readLocalRef(ref);
            if (ref.startsWith("data:")) {
              const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(ref);
              const bytes = m?.[2] ? new Uint8Array(Buffer.from(m[3]!, "base64")) : new TextEncoder().encode(decodeURIComponent(m?.[3] ?? ""));
              return { source: "data-uri", name: "ref", mime: m?.[1] ?? "application/octet-stream", bytes, url: ref };
            }
            const mime = mimeFromPath(ref) ?? "image/png";
            if (dry) return { source: ref, name: ref.split("/").pop() || "ref", mime, url: ref };
            const res = await send({ method: "GET", url: ref, expect: "bytes", auth: false, timeoutMs: 120_000 });
            return { source: ref, name: ref.split("/").pop() || "ref", mime: (res.headers["content-type"] ?? mime).split(";")[0]!, bytes: res.bytes, url: ref };
          }),
        ));
      },
      refUrls() {
        return (urlCache ??= Promise.all(
          (req.refs ?? []).map(async (ref) => {
            if (isUrl(ref)) return { source: ref, name: ref.split("/").pop() || "ref", mime: mimeFromPath(ref) ?? (ref.startsWith("data:") ? ref.slice(5, ref.indexOf(";")) : "image/png"), url: ref };
            const r = readLocalRef(ref);
            return { ...r, url: `data:${r.mime};base64,${Buffer.from(r.bytes!).toString("base64")}` };
          }),
        ));
      },
    };
    return ctx;
  }

  function provenanceFor(model: ModelEntry, connector: Connector, prompt: string | undefined) {
    return { prompt, model: model.id, provider: model.provider, watermark: model.watermark, terms: connector.terms, at: Date.now() };
  }

  // ---------- scheduling ----------
  function activeCount(provider: string): number {
    let n = 0;
    for (const r of records.values()) {
      if (r.job.provider !== provider) continue;
      const s = r.job.status;
      // queued + in flight = being started right now
      if (s === "running" || s === "downloading" || (s === "queued" && inflight.has(r.job.id))) n++;
    }
    return n;
  }
  function limitFor(provider: string): number {
    return Math.max(1, opts.concurrency?.[provider] ?? DEFAULT_CONCURRENCY[provider] ?? 2);
  }
  function ownedOrFree(rec: JobRecord): boolean {
    const l = rec.lease;
    if (!l) return true;
    if (l.inst === inst) return true;
    if (l.pid === process.pid) return Date.now() - l.at > 60_000; // another instance in this process that didn't close
    return !pidAlive(l.pid) || Date.now() - l.at > 120_000;
  }
  function pendingReserved(provider: string, exceptId?: string): { all: number; provider: number } {
    let all = 0;
    let prov = 0;
    for (const r of records.values()) {
      if (r.job.id === exceptId || r.job.status !== "queued") continue;
      all += r.job.estimate.usd;
      if (r.job.provider === provider) prov += r.job.estimate.usd;
    }
    return { all, provider: prov };
  }

  function schedule(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const now = Date.now();
    let next = Infinity;
    for (const r of records.values()) {
      const s = r.job.status;
      if (s === "queued" || s === "running" || s === "downloading") next = Math.min(next, r.nextAt ?? now);
    }
    if (next === Infinity && inflight.size === 0) return;
    const delay = Math.min(Math.max(next - now, 50), 15_000);
    timer = setTimeout(() => void tick(), next === Infinity ? 1000 : delay);
  }

  function track(id: string, p: Promise<void>): void {
    const wrapped = p
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(id);
        schedule();
      });
    inflight.set(id, wrapped);
  }

  async function tick(): Promise<void> {
    timer = null;
    if (closed) return;
    syncFromDisk();
    const now = Date.now();
    const list = [...records.values()].sort((a, b) => a.job.createdAt - b.job.createdAt);
    for (const rec of list) {
      const id = rec.job.id;
      if (inflight.has(id) || (rec.nextAt ?? 0) > now) continue;
      const s = rec.job.status;
      if (s === "queued") {
        if (activeCount(rec.job.provider) >= limitFor(rec.job.provider)) continue;
        track(id, startJob(rec));
      } else if ((s === "running" || s === "downloading") && ownedOrFree(rec)) {
        if (rec.submitting) {
          rec.submitting = false;
          finish(rec, "failed", {
            code: "provider_error",
            message: "The app stopped while this job was being submitted, so it is unknown whether the provider accepted it.",
            hint: "Check the provider's dashboard before retrying, to avoid paying twice.",
          });
          continue;
        }
        if (s === "downloading") track(id, downloadJob(rec, rec.pending ?? []));
        else if (rec.remote) track(id, pollJob(rec));
      }
    }
    schedule();
  }

  function lease(rec: JobRecord): void {
    rec.lease = { pid: process.pid, inst, at: Date.now() };
  }

  function finish(rec: JobRecord, status: JobStatus, error?: Job["error"]): void {
    if (status !== "succeeded") {
      if (rec.remote && status !== "canceled") ledger.void(rec.job.id);
      else if (!rec.remote) ledger.void(rec.job.id);
    }
    rec.lease = undefined;
    rec.remote = status === "succeeded" ? undefined : rec.remote;
    rec.pending = undefined;
    rec.nextAt = undefined;
    update(rec, { status, ...(error ? { error } : {}), ...(status === "succeeded" ? { progress: 1 } : {}) });
  }

  async function ctxFor(rec: JobRecord): Promise<Ctx> {
    const model = findModel(rec.job.model)!;
    const connector = connectorFor(model.provider);
    const key = await keyFor(model.provider);
    if (!key) throw new ClaudiaMediaError("no_key", `No ${connector.name} key`, { hint: keyHint(connector) });
    return makeCtx(connector, model, applyBrand(rec.job.request, model), key, false);
  }

  async function startJob(rec: JobRecord): Promise<void> {
    const model = findModel(rec.job.model);
    if (!model) return finish(rec, "failed", { code: "invalid", message: `Model ${rec.job.model} is no longer in this version` });
    const connector = connectorFor(model.provider);
    let ctx: Ctx;
    try {
      ctx = await ctxFor(rec);
    } catch (e) {
      return finish(rec, (e as ClaudiaMediaError).code === "blocked" ? "blocked" : "failed", toJobError(e));
    }
    rec.submitting = true;
    rec.startedAt = Date.now();
    lease(rec);
    ledger.reserve(rec.job.id, model.provider, model.id, rec.job.estimate.usd);
    update(rec, { status: "running", progress: 0 });
    let step: Step;
    try {
      step = await connector.submit(ctx);
    } catch (e) {
      rec.submitting = false;
      const err = e as ClaudiaMediaError;
      const retryable = err?.code === "rate_limited" || (err?.status !== undefined && err.status >= 500);
      if (retryable && (rec.failures ?? 0) < 3 && !closed) {
        rec.failures = (rec.failures ?? 0) + 1;
        ledger.void(rec.job.id);
        rec.nextAt = Date.now() + (err.retryAfterMs ?? 30_000);
        rec.lease = undefined;
        update(rec, { status: "queued", error: toJobError(e) });
        return;
      }
      return finish(rec, err?.code === "blocked" ? "blocked" : "failed", toJobError(e));
    }
    rec.submitting = false;
    rec.failures = 0;
    await handleStep(rec, ctx, step);
  }

  async function handleStep(rec: JobRecord, ctx: Ctx, step: Step): Promise<void> {
    if (step.state === "failed") return finish(rec, step.code === "blocked" ? "blocked" : step.code === "expired" ? "expired" : "failed", { code: step.code ?? "provider_error", message: step.message, ...(step.hint ? { hint: step.hint } : {}) });
    if (step.state === "running") {
      rec.remote = step.remote;
      if (step.expiresAt) rec.expiresAt = step.expiresAt;
      rec.delayMs = rec.delayMs ? Math.min(Math.round(rec.delayMs * 1.5), maxMs) : minMs;
      rec.nextAt = Date.now() + rec.delayMs;
      lease(rec);
      update(rec, { status: "running", ...(step.progress !== undefined ? { progress: step.progress } : {}), error: undefined });
      return;
    }
    if (step.costUsd !== undefined) rec.costUsd = step.costUsd;
    await downloadJob(rec, step.outputs, ctx);
  }

  async function pollJob(rec: JobRecord): Promise<void> {
    if (rec.startedAt && Date.now() - rec.startedAt > MAX_RUN_MS)
      return finish(rec, "failed", { code: "provider_error", message: "The provider did not finish within 6 hours", hint: "Check the provider's dashboard; the job may still appear there." });
    if (rec.expiresAt && Date.now() > rec.expiresAt) return finish(rec, "expired", { code: "expired", message: "The provider's result expired before it was downloaded" });
    const model = findModel(rec.job.model)!;
    const connector = connectorFor(model.provider);
    if (!connector.poll) return finish(rec, "failed", { code: "unsupported", message: "This provider has no polling" });
    let ctx: Ctx;
    try {
      ctx = await ctxFor(rec);
      lease(rec);
      const step = await connector.poll(ctx, rec.remote!);
      rec.failures = 0;
      await handleStep(rec, ctx, step);
    } catch (e) {
      const err = e as ClaudiaMediaError;
      if (err?.code === "no_key") return finish(rec, "failed", toJobError(e));
      if (err?.code === "expired") return finish(rec, "expired", toJobError(e));
      if (err?.code === "blocked") return finish(rec, "blocked", toJobError(e));
      rec.failures = (rec.failures ?? 0) + 1;
      if (rec.failures > 8 || err?.code === "invalid") return finish(rec, "failed", toJobError(e));
      const wait = err?.code === "rate_limited" ? err.retryAfterMs ?? 30_000 : Math.min(maxMs * 2 ** Math.min(rec.failures, 4), 5 * 60_000);
      rec.nextAt = Date.now() + wait;
      lease(rec);
      update(rec, { error: toJobError(e) }, false);
    }
  }

  async function downloadJob(rec: JobRecord, outputs: RemoteOutput[], ctxIn?: Ctx): Promise<void> {
    if (!outputs.length) return finish(rec, "failed", { code: "provider_error", message: "The provider finished but returned no output", hint: "This often means a safety filter removed the result. Try a different prompt." });
    const model = findModel(rec.job.model)!;
    const connector = connectorFor(model.provider);
    rec.pending = outputs.filter((o) => o.url && !o.bytes).map((o) => ({ ...o }));
    lease(rec);
    update(rec, { status: "downloading" });
    try {
      const ctx = ctxIn ?? (await ctxFor(rec));
      const saved = [];
      for (let i = 0; i < outputs.length; i++) {
        const o = outputs[i]!;
        let bytes = o.bytes;
        let mime = o.mime;
        if (!bytes) {
          if (!o.url) continue;
          const got = connector.download
            ? await connector.download(ctx, o)
            : await ctx.http({ method: "GET", url: o.url, expect: "bytes", auth: !!o.auth, timeoutMs: 15 * 60_000 } as HttpRequest).then((r) => ({ bytes: r.bytes!, mime: r.headers["content-type"] }));
          bytes = got.bytes;
          mime = mime ?? got.mime;
        }
        const prov = { ...rec.job.provenance, costUsd: rec.costUsd ?? rec.job.estimate.usd };
        saved.push(saveOutput(mediaDir, rec.job.id, i, bytes, mime, prov, { durationSec: o.durationSec }));
      }
      const cost = rec.costUsd ?? rec.job.estimate.usd;
      ledger.settle(rec.job.id, cost);
      rec.job.outputs = saved;
      rec.job.provenance = { ...rec.job.provenance, costUsd: cost };
      finish(rec, "succeeded");
    } catch (e) {
      const err = e as ClaudiaMediaError;
      if (err?.code === "expired" || err?.status === 403) return finish(rec, "expired", { code: "expired", message: err.message, hint: "The provider deleted the file before it could be downloaded. Run the job again." });
      rec.failures = (rec.failures ?? 0) + 1;
      if (rec.failures > 5) return finish(rec, "failed", toJobError(e));
      rec.nextAt = Date.now() + (err?.retryAfterMs ?? Math.min(minMs * 2 ** rec.failures, 120_000));
      update(rec, { error: toJobError(e) }, false);
    }
  }

  function keyHint(c: Connector): string {
    return `Add your ${c.name} API key as "${c.id}" (Claudia Local → Settings → Keys, \`claudia keys set ${c.id}\`, or the CLAUDIA_KEY_${c.id.toUpperCase()} environment variable). Get one at ${c.keyUrl}`;
  }

  function get(id: string): JobRecord {
    syncFromDisk();
    const r = records.get(id);
    if (!r) throw new ClaudiaMediaError("invalid", `No job ${id}`);
    return r;
  }

  // ---------- public API ----------
  load();
  for (const c of Object.values(CONNECTORS)) void keyFor(c.id);
  schedule();

  const media: Media = {
    async providers(): Promise<ProviderSummary[]> {
      const out: ProviderSummary[] = [];
      for (const c of Object.values(CONNECTORS)) out.push({ id: c.id, name: c.name, kinds: [...c.kinds], configured: !!(await keyFor(c.id)), docs: c.docs });
      return out;
    },

    models(filter = {}) {
      return MODELS.filter((m) => (!filter.kind || m.kind === filter.kind) && (!filter.provider || m.provider === filter.provider)).map(publicModel);
    },

    estimate(req: GenerateRequest): Estimate {
      const model = resolveModelSync(req);
      return estimateFor(model, applyBrand(req, model));
    },

    async generate(req, gopts = {}): Promise<Job | DryRun> {
      if (closed) throw new ClaudiaMediaError("invalid", "This media instance is closed");
      const model = await resolveModel(req);
      if (model.retired)
        throw new ClaudiaMediaError("unsupported", `${model.label} was retired by ${model.provider}`, { hint: model.replacedBy ? `Use ${model.replacedBy} instead.` : "Pick another model from media.models()." });
      const connector = connectorFor(model.provider);
      const effective = applyBrand(req, model);
      if (!effective.prompt && !effective.text && !(effective.refs?.length))
        throw new ClaudiaMediaError("invalid", "Nothing to generate", { hint: "Pass a prompt (or text for speech)." });
      // HeyGen photo avatars (a face photo, no stock avatar) speak a script with a HeyGen voice: check it before any job.
      if (model.provider === "heygen" && typeof effective.meta?.avatarId !== "string" && !effective.voice && !(effective.refs ?? []).some((r) => mimeFromPath(r)?.startsWith("audio/")))
        throw new ClaudiaMediaError("invalid", "HeyGen photo avatars need a voice id", { hint: "Pass `voice` (a HeyGen voice id from GET https://api.heygen.com/v3/voices or the brand kit), an audio file in refs, or meta.avatarId for a stock avatar." });
      const estimate = estimateFor(model, effective);
      const dry = gopts.dryRun ?? opts.dryRun ?? false;
      if (dry) {
        const key = (await keyFor(model.provider)) ?? "dry-run-no-key";
        const ctx = makeCtx(connector, model, effective, key, true);
        try {
          await connector.submit(ctx);
        } catch (e) {
          if (e instanceof DryCapture) return { dryRun: true, request: e.request, estimate };
          throw e;
        }
        throw new ClaudiaMediaError("provider_error", "Dry run produced no request");
      }
      const key = await keyFor(model.provider);
      if (!key) throw new ClaudiaMediaError("no_key", `No ${connector.name} key set`, { hint: keyHint(connector) });
      checkLimits(opts.limits, model.provider, estimate.usd, ledger.summary(), pendingReserved(model.provider));
      const threshold = approvalThreshold(opts.limits, model.provider);
      const needsApproval = threshold !== undefined && estimate.usd > threshold && !gopts.approve;
      const now = Date.now();
      const job: Job = {
        id: newId(),
        status: needsApproval ? "needs_approval" : "queued",
        request: clone(req),
        model: model.id,
        provider: model.provider,
        estimate,
        createdAt: now,
        updatedAt: now,
        outputs: [],
        provenance: provenanceFor(model, connector, effective.prompt ?? effective.text),
      };
      const rec: JobRecord = { job };
      records.set(job.id, rec);
      save();
      events.emit("job", clone(job));
      schedule();
      return clone(job);
    },

    getJob(id) {
      syncFromDisk();
      const r = records.get(id);
      return r ? clone(r.job) : null;
    },

    listJobs(f = {}) {
      syncFromDisk();
      let list = [...records.values()].map((r) => r.job).sort((a, b) => b.createdAt - a.createdAt);
      if (f.status) list = list.filter((j) => j.status === f.status);
      if (f.limit) list = list.slice(0, f.limit);
      return list.map(clone);
    },

    async approve(id) {
      const rec = get(id);
      if (rec.job.status !== "needs_approval") return clone(rec.job);
      checkLimits(opts.limits, rec.job.provider, rec.job.estimate.usd, ledger.summary(), pendingReserved(rec.job.provider, id));
      update(rec, { status: "queued" });
      schedule();
      return clone(rec.job);
    },

    async cancel(id) {
      const rec = get(id);
      const s = rec.job.status;
      if (TERMINAL.includes(s)) return clone(rec.job);
      if ((s === "running" || s === "downloading") && rec.remote) {
        const model = findModel(rec.job.model)!;
        const connector = connectorFor(model.provider);
        if (connector.cancel) {
          try {
            await connector.cancel(await ctxFor(rec), rec.remote);
          } catch {
            // best effort: the provider may already be done
          }
        }
        finish(rec, "canceled", { code: "canceled", message: "Canceled", hint: "The provider may still bill work it already started." });
      } else finish(rec, "canceled");
      return clone(rec.job);
    },

    wait(id, wopts = {}) {
      return new Promise<Job>((resolve, reject) => {
        let rec: JobRecord;
        try {
          rec = get(id);
        } catch (e) {
          return reject(e);
        }
        const done = (j: Job) => TERMINAL.includes(j.status) || j.status === "needs_approval";
        if (done(rec.job)) return resolve(clone(rec.job));
        let t: NodeJS.Timeout | undefined;
        const onJob = (j: Job) => {
          if (j.id !== id || !done(j)) return;
          events.off("job", onJob);
          if (t) clearTimeout(t);
          resolve(j);
        };
        events.on("job", onJob);
        if (wopts.timeoutMs !== undefined)
          t = setTimeout(() => {
            events.off("job", onJob);
            resolve(clone(records.get(id)!.job));
          }, wopts.timeoutMs);
      });
    },

    spend() {
      return ledger.summary();
    },

    brands: {
      list: () => brands.list(),
      get: (id) => brands.get(id),
      save: (b) => brands.save(b),
    },

    on(ev, cb: JobListener) {
      events.on(ev, cb);
    },
    off(ev, cb: JobListener) {
      events.off(ev, cb);
    },

    async checkModels(copts = {}): Promise<CheckModelsResult[]> {
      const out: CheckModelsResult[] = [];
      const dry = copts.dryRun ?? opts.dryRun ?? false;
      for (const c of Object.values(CONNECTORS)) {
        if (copts.provider && c.id !== copts.provider) continue;
        const ours = MODELS.filter((m) => m.provider === c.id);
        const retired = ours.filter((m) => m.retired).map((m) => m.id);
        if (!c.listModels) {
          out.push({ provider: c.id, checked: false, missing: [], retired, note: "This provider has no model list endpoint." });
          continue;
        }
        const key = (await keyFor(c.id)) ?? (dry ? "dry-run-no-key" : null);
        if (!key) {
          out.push({ provider: c.id, checked: false, missing: [], retired, note: "No key set." });
          continue;
        }
        const ctx = makeCtx(c, ours[0]!, { kind: ours[0]!.kind }, key, dry);
        try {
          const ids = await c.listModels(ctx);
          if (!ids) {
            out.push({ provider: c.id, checked: false, missing: [], retired, note: "The provider did not return a list." });
            continue;
          }
          const have = new Set(ids);
          const missing = ours.filter((m) => !m.retired && m.listed !== false && !m.remoteIds().some((r) => have.has(r))).map((m) => m.id);
          out.push({ provider: c.id, checked: true, missing, retired });
        } catch (e) {
          if (e instanceof DryCapture) out.push({ provider: c.id, checked: false, missing: [], retired, dryRun: e.request, note: "Dry run: this is the request it would send." });
          else out.push({ provider: c.id, checked: false, missing: [], retired, note: (e as Error).message });
        }
      }
      return out;
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const pending = [...inflight.values()];
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 30_000).unref())]);
      for (const r of records.values()) if (r.lease?.inst === inst) r.lease = undefined;
      save();
      events.clear();
    },
  };
  return media;
}
