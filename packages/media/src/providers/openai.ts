// OpenAI. Header `Authorization: Bearer <key>`.
// Checked 2026-10-08 against developers.openai.com (platform.openai.com now redirects there):
//   images  https://developers.openai.com/api/reference/resources/images/methods/generate  (POST /v1/images/generations, b64_json)
//           https://developers.openai.com/api/reference/resources/images/methods/edit      (POST /v1/images/edits, JSON images[].image_url)
//   speech  https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create (POST /v1/audio/speech, binary)
//   models  GET /v1/models → data[].id (+ shutdown_date)
// No video: the Sora / Videos API shut down on 2026-09-24.
import { fromB64, isImage, strip, withProviderOptions, type Connector, type Ctx, type Step } from "./base.js";

const BASE = "https://api.openai.com/v1";

/** gpt-image-2 / 2.5 accept any WxH (multiples of 16, ratio ≤ 3:1); older models only the three fixed sizes. */
function sizeFor(ctx: Ctx): string | undefined {
  const req = ctx.req;
  if (req.resolution && /^\d+x\d+$/.test(req.resolution)) return req.resolution;
  if (!req.aspect) return undefined;
  const free = ctx.model.caps.freeSize === true;
  const fixed: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536", "4:5": "1024x1536" };
  const flexible: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536", "4:5": "1024x1280", "3:2": "1536x1024", "2:3": "1024x1536" };
  return (free ? flexible : fixed)[req.aspect];
}

async function image(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const refs = (await ctx.refUrls()).filter(isImage);
  const background = typeof req.meta?.background === "string" ? req.meta.background : undefined;
  const format = typeof req.meta?.format === "string" ? req.meta.format : "png";
  const common = strip({
    model: ctx.model.remoteId,
    prompt: req.prompt ?? "",
    n: req.n && req.n > 1 ? Math.min(req.n, 10) : undefined,
    size: sizeFor(ctx),
    quality: typeof req.meta?.quality === "string" ? req.meta.quality : "medium",
    background,
    output_format: background === "transparent" && format === "jpeg" ? "png" : format,
    moderation: typeof req.meta?.moderation === "string" ? req.meta.moderation : undefined,
  });
  const edit = refs.length > 0;
  const body = withProviderOptions(edit ? { ...common, images: refs.slice(0, 16).map((r) => ({ image_url: r.url })) } : common, req);
  const res = await ctx.http({ method: "POST", url: `${BASE}/images/${edit ? "edits" : "generations"}`, json: body, timeoutMs: 300_000 });
  const j = res.json;
  const mime = `image/${(j.output_format ?? common.output_format ?? "png").replace("jpg", "jpeg")}`;
  const outputs = (j.data ?? []).filter((d: any) => d?.b64_json).map((d: any) => ({ bytes: fromB64(d.b64_json), mime }));
  // Exact cost from the token usage the API reports.
  const tp = ctx.model.tokenPrice;
  let costUsd: number | undefined;
  if (tp && j.usage) {
    const u = j.usage;
    const textIn = u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0;
    const imageIn = u.input_tokens_details?.image_tokens ?? 0;
    costUsd = Math.round(((textIn * tp.textIn + imageIn * tp.imageIn + (u.output_tokens ?? 0) * tp.out) / 1e6) * 10000) / 10000;
  }
  return { state: "done", outputs, costUsd };
}

async function speech(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const legacy = /^tts-1/.test(ctx.model.remoteId);
  const body = withProviderOptions(
    strip({
      model: ctx.model.remoteId,
      input: req.text ?? req.prompt ?? "",
      voice: req.voice || (legacy ? "alloy" : "marin"),
      instructions: !legacy && typeof req.meta?.style === "string" ? req.meta.style : undefined,
      response_format: "mp3",
    }),
    req,
  );
  const res = await ctx.http({ method: "POST", url: `${BASE}/audio/speech`, json: body, expect: "bytes", timeoutMs: 300_000 });
  return { state: "done", outputs: [{ bytes: res.bytes!, mime: "audio/mpeg" }] };
}

export const openai: Connector = {
  id: "openai",
  name: "OpenAI",
  kinds: ["image", "speech"],
  docs: "https://developers.openai.com/api/docs",
  keyUrl: "https://platform.openai.com/api-keys",
  terms: "https://openai.com/policies/terms-of-use",
  auth: (key) => ({ Authorization: `Bearer ${key}` }),
  async submit(ctx) {
    if (ctx.model.kind === "image") return image(ctx);
    if (ctx.model.kind === "speech") return speech(ctx);
    return { state: "failed", code: "invalid", message: `OpenAI does not make ${ctx.model.kind} here` };
  },
  async listModels(ctx) {
    const res = await ctx.http({ method: "GET", url: `${BASE}/models` });
    const today = new Date().toISOString().slice(0, 10);
    return (res.json.data ?? []).filter((m: any) => !m.shutdown_date || m.shutdown_date > today).map((m: any) => String(m.id));
  },
};
