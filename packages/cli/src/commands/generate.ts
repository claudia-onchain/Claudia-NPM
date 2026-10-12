// claudia generate image|video|speech|music|sfx|avatar "<prompt>" — via @useclaudia/media with the user's own keys.
// Always: estimate first → confirm → progress → saved file path. --dry-run shows the exact provider request instead.
import { resolve } from "node:path";
import { numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { loadMedia, type GenerateRequest, type Job, type Media, type MediaDryRun, type MediaKind } from "../optional.js";
import { bytes, c, info, kvBlock, log, ok, progressBar, section, sym, table, title, usd, warn } from "../ui.js";
import { term } from "../term.js";

const KINDS: MediaKind[] = ["image", "video", "speech", "music", "sfx", "avatar"];
const ASPECTS = ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"];

export async function openMedia(ctx: Ctx, dryRun = false): Promise<Media> {
  const { createMedia } = await loadMedia();
  const cfg = ctx.home.config() as { media?: { limits?: Record<string, unknown> } };
  return createMedia({ keys: ctx.keys, dataDir: ctx.home.dir, limits: cfg.media?.limits, dryRun });
}

const estimateText = (e: { usd: number; low?: number; high?: number; confidence: string; basis: string }) =>
  `${c.bold(`≈ ${usd(e.usd, { exact: true })}`)}${e.low !== undefined && e.high !== undefined && e.low !== e.high ? c.dim(` (${usd(e.low, { exact: true })}–${usd(e.high, { exact: true })})`) : ""} ${c.dim(`· ${e.confidence === "exact" ? "exact price" : e.confidence === "list" ? "list price" : "estimate"} · ${e.basis}`)}`;

export async function generate(ctx: Ctx) {
  const kind = ctx.args[0] as MediaKind | undefined;
  if (kind === ("models" as string)) return models(ctx);
  if (!kind || !KINDS.includes(kind)) throw new UsageError(`Usage: claudia generate <${KINDS.join("|")}> "<prompt>"  ·  claudia generate models`);
  const f = ctx.flags;
  const prompt = ctx.args.slice(1).join(" ").trim() || str(f, "prompt");
  if (!prompt) throw new UsageError(`What should it make? claudia generate ${kind} "<prompt>"`);
  const aspect = str(f, "aspect");
  if (aspect && !ASPECTS.includes(aspect)) throw new UsageError(`--aspect is one of ${ASPECTS.join(", ")}`);
  const refs = (str(f, "ref") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((r) => (/^https?:\/\//.test(r) ? r : resolve(r)));
  const req: GenerateRequest = {
    kind,
    model: str(f, "model"),
    ...(kind === "speech" ? { text: prompt } : { prompt }),
    negativePrompt: str(f, "negative"),
    voice: str(f, "voice"),
    refs: refs.length ? refs : undefined,
    aspect: aspect as GenerateRequest["aspect"],
    resolution: str(f, "resolution"),
    durationSec: numFlag(f, "duration"),
    n: numFlag(f, "n"),
    seed: numFlag(f, "seed"),
    brand: str(f, "brand"),
  };
  for (const k of Object.keys(req) as (keyof GenerateRequest)[]) if (req[k] === undefined) delete req[k];

  const media = await openMedia(ctx, ctx.dryRun);
  try {
    const est = media.estimate(req);
    const spend = media.spend();
    const S = sym();
    if (!ctx.json) {
      title(`Generate ${kind}`, req.model ?? "default model");
      kvBlock([
        [kind === "speech" ? "Text" : "Prompt", wrapPlain(prompt)],
        req.aspect || req.durationSec || req.resolution || req.n ? ["Settings", [req.aspect, req.resolution, req.durationSec ? `${req.durationSec} s` : "", req.n ? `${req.n}×` : ""].filter(Boolean).join(` ${S.dot} `)] : null,
        req.refs ? ["References", req.refs.join(", ")] : null,
        ["Cost", estimateText(est)],
        ["Spent", `${usd(spend.today, { exact: true })} today ${S.dot} ${usd(spend.month, { exact: true })} this month`],
      ]);
    }
    const maxUsd = numFlag(f, "max-usd");
    if (maxUsd !== undefined && est.usd > maxUsd) throw new CliError(EXIT.REFUSED, "over_budget", `This would cost about ${usd(est.usd, { exact: true })}, over your --max-usd ${usd(maxUsd, { exact: true })}.`, "Pick a cheaper model (claudia generate models) or raise --max-usd.");

    if (ctx.dryRun) {
      const d = (await media.generate(req, { dryRun: true })) as MediaDryRun;
      if (!ctx.json) {
        section("Request it would send");
        kvBlock([
          ["Method", d.request.method],
          ["URL", d.request.url],
          ["Headers", Object.entries(d.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n")],
          d.request.body !== undefined ? ["Body", truncateBody(d.request.body)] : null,
        ]);
        log("");
        info("Dry run — nothing was sent and nothing was spent.");
      }
      return { dryRun: true, request: d.request, estimate: d.estimate ?? est };
    }

    // Answering "y" (or --yes) IS the approval: the job skips the media approval queue, even above the approval limit.
    if (!ctx.json) info("Saying yes approves this spend now: the job won't wait in the approval queue.");
    await ctx.confirmOrRefuse(`Approve and generate for about ${usd(est.usd, { exact: true })} on your own key?`, "this spends money on your provider account (yes = approve)");
    let job = (await media.generate(req, { approve: true })) as Job;
    if (job.status === "needs_approval") job = await media.approve(job.id);
    const live = term().errTTY && !ctx.json;
    const draw = (j: Job) => {
      if (!live || j.id !== job.id) return;
      const frac = j.progress ?? ({ queued: 0.02, running: 0.3, downloading: 0.9 } as Record<string, number>)[j.status] ?? 0;
      process.stderr.write(`\r\u001b[2K  ${progressBar(frac, Math.min(30, term().width - 30))} ${c.dim(j.status)}`);
    };
    media.on("job", draw);
    draw(job);
    const timeoutMs = (numFlag(f, "timeout") ?? (kind === "video" || kind === "avatar" ? 900 : 300)) * 1000;
    job = await media.wait(job.id, { timeoutMs });
    media.off?.("job", draw);
    if (live) process.stderr.write("\r\u001b[2K");
    if (job.status !== "succeeded") {
      if (job.status === "queued" || job.status === "running" || job.status === "downloading") {
        if (!ctx.json) warn(`Still ${job.status} after ${Math.round(timeoutMs / 1000)} s. It keeps going in the background; the file lands in ${ctx.home.dir}/media/library.`);
        return { job };
      }
      throw new CliError(job.status === "blocked" ? EXIT.REFUSED : EXIT.ERROR, job.error?.code ?? job.status, job.error?.message ?? `The job ended as ${job.status}.`, job.error?.hint);
    }
    if (!ctx.json) {
      ok(`Done ${sym().dot} ${job.provider} ${sym().dot} ${job.model}`);
      for (const o of job.outputs) {
        log(`  ${c.bold(o.path)}`);
        info(`${o.mime} ${sym().dot} ${bytes(o.bytes)}${o.width ? ` ${sym().dot} ${o.width}×${o.height}` : ""}${o.durationSec ? ` ${sym().dot} ${o.durationSec} s` : ""} ${sym().dot} sha256 ${o.sha256.slice(0, 12)}`);
      }
    }
    return { job, files: job.outputs.map((o) => o.path) };
  } finally {
    await media.close();
  }
}

const wrapPlain = (s: string) => (s.length > 400 ? s.slice(0, 400) + "…" : s);

function truncateBody(b: unknown): string {
  const s = typeof b === "string" ? b : JSON.stringify(b, null, 2);
  const lines = s.split("\n");
  return (lines.length > 24 ? [...lines.slice(0, 24), "…"] : lines).join("\n").slice(0, 2400);
}

async function models(ctx: Ctx) {
  const media = await openMedia(ctx, true);
  try {
    const kind = ctx.args[1] as MediaKind | undefined;
    const list = media.models(kind ? { kind } : undefined).filter((m) => !m.retired);
    const providers = await media.providers();
    const configured = new Map(providers.map((p) => [p.id, p.configured]));
    if (!ctx.json) {
      title("Media models", kind ?? "all kinds");
      table(
        [
          { header: "Model", get: (m) => c.bold(m.id), headline: true, min: 12 },
          { header: "Kind", get: (m) => m.kind, headline: true },
          { header: "Price", get: (m) => c.dim(m.priceHint ?? "—"), priority: 2 },
          { header: "Key", get: (m) => (configured.get(m.provider) ? c.buy(`${sym().ok} ${m.provider}`) : c.dim(`${m.provider} (no key)`)) },
        ],
        list,
      );
      log("");
      info("Add a key: claudia keys set <provider> · then: claudia generate image \"…\" --model <id>");
    }
    return { models: list, providers };
  } finally {
    await media.close();
  }
}

