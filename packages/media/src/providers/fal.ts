// fal.ai queue API. Header `Authorization: Key <key>`.
// Checked 2026-10-08 against https://fal.ai/docs/model-apis/model-endpoints/queue.md and each model's OpenAPI schema
// (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>):
//   POST https://queue.fal.run/{endpoint}  → { request_id, status_url, response_url, cancel_url }
//   GET  status_url (IN_QUEUE | IN_PROGRESS | COMPLETED)  →  GET response_url  →  { video: { url } } | { images: [{ url }] }
//   PUT  cancel_url
// We store and reuse the returned URLs instead of building them (fal drops the endpoint sub-path for those).
// Endpoint ids and per-model field names live in the model table (models.ts), not here.
import { isAudio, isImage, isVideo, strip, withProviderOptions, type Connector, type Ctx, type Step } from "./base.js";
import { ClaudiaMediaError } from "../errors.js";

const QUEUE = "https://queue.fal.run";

const FLUX_SIZE: Record<string, string> = {
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:5": "portrait_4_3",
  "3:2": "landscape_4_3",
  "2:3": "portrait_4_3",
};

export interface FalSpec {
  /** Endpoint for prompt-only requests. */
  text?: string;
  /** Endpoint when an image ref is given (image-to-video / edit). */
  image?: string;
  /** Field that takes the first image ref ("image_url" | "start_image_url"). */
  imageField?: string;
  /** Field that takes all image refs as an array ("image_urls"). */
  imagesField?: string;
  /** Field for a second image (last frame). */
  endImageField?: string;
  duration?: "string" | "int";
  aspect?: boolean;
  resolution?: boolean;
  negative?: boolean;
  /** Model takes `generate_audio`. */
  audio?: boolean;
  /** Flux-style `image_size` enum. */
  imageSize?: boolean;
  /** Avatar / lip-sync models: which media refs map to which fields. */
  avatar?: "image+audio" | "video+audio";
}

async function body(ctx: Ctx, spec: FalSpec): Promise<{ endpoint: string; input: Record<string, unknown> }> {
  const req = ctx.req;
  const refs = await ctx.refUrls();
  const imgs = refs.filter(isImage);
  if (spec.avatar) {
    const audio = refs.find(isAudio);
    if (!audio) throw new ClaudiaMediaError("invalid", `${ctx.model.label} needs an audio ref`, { hint: "Make speech first (kind: \"speech\"), then pass [face image or video, audio file] as refs." });
    const input: Record<string, unknown> = { audio_url: audio.url };
    if (spec.avatar === "image+audio") {
      if (!imgs[0]) throw new ClaudiaMediaError("invalid", `${ctx.model.label} needs a face image ref`, { hint: "Pass a photo as the first ref, or set a brand kit with reference images." });
      input.image_url = imgs[0].url;
      if (req.prompt) input.prompt = req.prompt;
      if (spec.resolution && req.resolution) input.resolution = req.resolution;
    } else {
      const video = refs.find(isVideo);
      if (!video) throw new ClaudiaMediaError("invalid", `${ctx.model.label} needs a video ref`, { hint: "Pass [video, audio] as refs." });
      input.video_url = video.url;
    }
    return { endpoint: spec.text ?? spec.image!, input: withProviderOptions(input, req) };
  }
  const useImage = imgs.length > 0 && !!spec.image;
  const endpoint = useImage ? spec.image! : spec.text ?? spec.image!;
  if (!useImage && !spec.text) throw new ClaudiaMediaError("invalid", `${ctx.model.label} needs an image ref`, { hint: "Pass an image in refs (or use a brand kit with reference images)." });
  const input: Record<string, unknown> = strip({
    prompt: req.prompt ?? "",
    negative_prompt: spec.negative ? req.negativePrompt : undefined,
    seed: req.seed,
    resolution: spec.resolution ? req.resolution : undefined,
    aspect_ratio: spec.aspect && req.aspect && !useImage ? req.aspect : undefined,
    image_size: spec.imageSize && req.aspect ? FLUX_SIZE[req.aspect] : undefined,
    num_images: ctx.model.kind === "image" && req.n && req.n > 1 ? req.n : undefined,
    duration:
      req.durationSec === undefined || !spec.duration ? undefined : spec.duration === "int" ? Math.round(req.durationSec) : String(Math.round(req.durationSec)),
    generate_audio: spec.audio && typeof req.meta?.audio === "boolean" ? req.meta.audio : undefined,
  });
  if (useImage) {
    if (spec.imagesField) input[spec.imagesField] = imgs.map((r) => r.url);
    else input[spec.imageField ?? "image_url"] = imgs[0]!.url;
    if (spec.endImageField && imgs[1]) input[spec.endImageField] = imgs[1].url;
  }
  return { endpoint, input: withProviderOptions(input, req) };
}

function looksBlocked(msg: string): boolean {
  return /nsfw|content.?policy|safety|moderation|not allowed|prohibited|sensitive/i.test(msg);
}

function outputsOf(json: any): { url: string; mime?: string }[] {
  const out: { url: string; mime?: string }[] = [];
  if (json?.video?.url) out.push({ url: json.video.url, mime: json.video.content_type });
  for (const im of json?.images ?? []) if (im?.url) out.push({ url: im.url, mime: im.content_type });
  if (json?.audio?.url) out.push({ url: json.audio.url, mime: json.audio.content_type });
  if (json?.image?.url) out.push({ url: json.image.url, mime: json.image.content_type });
  return out;
}

export const fal: Connector = {
  id: "fal",
  name: "fal.ai",
  kinds: ["image", "video", "avatar"],
  docs: "https://fal.ai/docs/model-apis/model-endpoints/queue",
  keyUrl: "https://fal.ai/dashboard/keys",
  terms: "https://fal.ai/terms",
  auth: (key) => ({ Authorization: `Key ${key}` }),

  async submit(ctx) {
    const spec = ctx.model.fal;
    if (!spec) throw new ClaudiaMediaError("unsupported", `${ctx.model.id} has no fal endpoint`);
    const { endpoint, input } = await body(ctx, spec);
    const res = await ctx.http({ method: "POST", url: `${QUEUE}/${endpoint}`, json: input });
    const j = res.json;
    return {
      state: "running",
      remote: { requestId: j.request_id, statusUrl: j.status_url, responseUrl: j.response_url, cancelUrl: j.cancel_url, endpoint },
      progress: 0,
    };
  },

  async poll(ctx, remote): Promise<Step> {
    const st = await ctx.http({ method: "GET", url: String(remote.statusUrl) });
    const s = st.json?.status;
    if (s === "IN_QUEUE") return { state: "running", remote, progress: 0 };
    if (s === "IN_PROGRESS") return { state: "running", remote, progress: 0.5 };
    if (s !== "COMPLETED") return { state: "running", remote };
    if (st.json?.error) {
      const msg = String(st.json.error);
      return { state: "failed", code: looksBlocked(msg) ? "blocked" : "provider_error", message: `fal: ${msg}` };
    }
    try {
      const r = await ctx.http({ method: "GET", url: String(remote.responseUrl) });
      const outs = outputsOf(r.json);
      if (r.json?.has_nsfw_concepts?.some?.(Boolean) && !outs.length) return { state: "failed", code: "blocked", message: "fal flagged the output as unsafe" };
      return { state: "done", outputs: outs };
    } catch (e) {
      const err = e as ClaudiaMediaError;
      if (err.code === "invalid") return { state: "failed", code: looksBlocked(err.message) ? "blocked" : "invalid", message: err.message, hint: err.hint };
      throw e;
    }
  },

  async cancel(ctx, remote) {
    if (remote.cancelUrl) await ctx.http({ method: "PUT", url: String(remote.cancelUrl) });
  },

  async listModels(ctx) {
    const { MODELS } = await import("../models.js");
    const ids = [...new Set(MODELS.filter((m) => m.provider === "fal").flatMap((m) => m.remoteIds()))];
    const found: string[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const q = ids.slice(i, i + 50).map((id) => `endpoint_id=${encodeURIComponent(id)}`).join("&");
      const res = await ctx.http({ method: "GET", url: `https://api.fal.ai/v1/models?${q}&limit=50` });
      for (const m of res.json.models ?? []) if (m?.endpoint_id && m.metadata?.status !== "deprecated") found.push(m.endpoint_id);
    }
    return found;
  },
};
