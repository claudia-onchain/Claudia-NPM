// Google Gemini API (generativelanguage.googleapis.com), header x-goog-api-key.
// Checked 2026-10-08 against:
//   images  https://ai.google.dev/gemini-api/docs/generate-content/image-generation   (:generateContent, inlineData parts)
//   video   https://ai.google.dev/gemini-api/docs/veo   (:predictLongRunning → GET /v1beta/{operation} → video.uri, download with key)
//           https://ai.google.dev/gemini-api/docs/omni  (POST /v1beta/interactions, background, GET /v1beta/interactions/{id})
//   music   https://ai.google.dev/gemini-api/docs/generate-content/music-generation  (Lyria 3.5 / Clip via :generateContent)
//   speech  https://ai.google.dev/gemini-api/docs/generate-content/speech-generation (AUDIO modality; 3.8 returns WAV, older PCM)
//   models  https://ai.google.dev/api/models   (GET /v1beta/models?pageSize=1000)
// Veo deletes generated videos from Google's servers after 2 days, so outputs are downloaded as soon as the operation is done.
import { pcmToWav, sniff } from "../sniff.js";
import { b64, fromB64, isImage, strip, withProviderOptions, type Connector, type Ctx, type LoadedRef, type RemoteOutput, type Step } from "./base.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function inline(r: LoadedRef): { mimeType: string; data: string } {
  return { mimeType: r.mime, data: r.bytes ? b64(r.bytes) : `<base64 of ${r.source}>` };
}

const BLOCK_REASONS = new Set(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_PROHIBITED_CONTENT", "OTHER"]);

/** Pulls inline media parts out of a generateContent response (skipping Gemini 3 "thought" previews). */
function mediaParts(json: any, prefix: string): RemoteOutput[] | Step {
  const block = json?.promptFeedback?.blockReason;
  if (block) return { state: "failed", code: "blocked", message: `Google blocked the prompt (${block})`, hint: "Reword the prompt." };
  const cand = json?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const outs: RemoteOutput[] = [];
  for (const p of parts) {
    const d = p?.inlineData ?? p?.inline_data;
    if (!d?.data || p.thought) continue;
    const mime = d.mimeType ?? d.mime_type ?? "application/octet-stream";
    if (!mime.startsWith(prefix)) continue;
    outs.push({ bytes: fromB64(d.data), mime });
  }
  if (!outs.length && cand?.finishReason && BLOCK_REASONS.has(cand.finishReason))
    return { state: "failed", code: "blocked", message: `Google stopped the output (${cand.finishReason})`, hint: "Reword the prompt or remove the reference image." };
  return outs;
}

async function generateContent(ctx: Ctx, body: unknown): Promise<any> {
  const res = await ctx.http({ method: "POST", url: `${BASE}/models/${ctx.model.remoteId}:generateContent`, json: body, timeoutMs: 300_000 });
  return res.json;
}

async function image(ctx: Ctx): Promise<Step> {
  const refs = (await ctx.refBytes()).filter(isImage);
  const req = ctx.req;
  const parts: unknown[] = [{ text: req.prompt ?? "" }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: inline(r).data } }))];
  const imageConfig = strip({ aspectRatio: req.aspect, imageSize: req.resolution ? req.resolution.toUpperCase().replace(/^(\d)K$/, "$1K") : undefined });
  const body = withProviderOptions(
    {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    },
    req,
  );
  const n = Math.max(1, Math.min(4, req.n ?? 1));
  const outputs: RemoteOutput[] = [];
  for (let i = 0; i < n; i++) {
    const got = mediaParts(await generateContent(ctx, body), "image/");
    if (!Array.isArray(got)) return got;
    outputs.push(...got);
  }
  return { state: "done", outputs };
}

async function speech(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const style = typeof req.meta?.style === "string" ? req.meta.style : undefined;
  const body = withProviderOptions(
    {
      contents: [{ role: "user", parts: [strip({ text: req.text ?? req.prompt ?? "", speech_metadata: style ? { style } : undefined })] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice: req.voice || "Kore" } } },
    },
    req,
  );
  const got = mediaParts(await generateContent(ctx, body), "audio/");
  if (!Array.isArray(got)) return got;
  // 3.8 TTS returns a full WAV; older previews return raw 24 kHz 16-bit mono PCM.
  return {
    state: "done",
    outputs: got.map((o) => (sniff(o.bytes!).mime === "audio/wav" ? { ...o, mime: "audio/wav" } : { bytes: pcmToWav(o.bytes!), mime: "audio/wav" })),
  };
}

async function music(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const refs = (await ctx.refBytes()).filter(isImage);
  const wav = req.meta?.format === "wav";
  const body = withProviderOptions(
    {
      contents: [{ parts: [{ text: req.prompt ?? "" }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: inline(r).data } }))] }],
      ...(wav ? { generationConfig: { responseModalities: ["AUDIO", "TEXT"], responseFormat: { audio: { mimeType: "audio/wav" } } } } : {}),
    },
    req,
  );
  const got = mediaParts(await generateContent(ctx, body), "audio/");
  if (!Array.isArray(got)) return got;
  return { state: "done", outputs: got };
}

// ---- Veo 3.1 (long-running operation) ----
async function veo(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const refs = (await ctx.refBytes()).filter(isImage);
  const instance: Record<string, unknown> = { prompt: req.prompt ?? "" };
  const mode = req.meta?.refMode === "reference" ? "reference" : "frames";
  if (refs.length && mode === "frames") {
    instance.image = { inlineData: inline(refs[0]!) };
    if (refs[1]) instance.lastFrame = { inlineData: inline(refs[1]) };
  } else if (refs.length) {
    instance.referenceImages = refs.slice(0, 3).map((r) => ({ image: { inlineData: inline(r) }, referenceType: "asset" }));
  }
  const fixed8 = (req.resolution && req.resolution !== "720p") || mode === "reference";
  const parameters = strip({
    aspectRatio: req.aspect === "9:16" ? "9:16" : req.aspect ? "16:9" : undefined,
    resolution: req.resolution,
    durationSeconds: fixed8 ? "8" : req.durationSec ? String(req.durationSec) : undefined,
    negativePrompt: req.negativePrompt,
    seed: req.seed,
    personGeneration: refs.length ? "allow_adult" : undefined,
  });
  const body = withProviderOptions({ instances: [instance], parameters }, req);
  const res = await ctx.http({ method: "POST", url: `${BASE}/models/${ctx.model.remoteId}:predictLongRunning`, json: body });
  return { state: "running", remote: { kind: "operation", name: res.json.name }, progress: 0 };
}

async function pollOperation(ctx: Ctx, name: string): Promise<Step> {
  const res = await ctx.http({ method: "GET", url: `${BASE}/${name}` });
  const op = res.json;
  if (!op.done) return { state: "running", remote: { kind: "operation", name } };
  if (op.error) return { state: "failed", code: op.error.code === 3 ? "invalid" : "provider_error", message: `Veo: ${op.error.message ?? "failed"}` };
  const r = op.response?.generateVideoResponse ?? op.response ?? {};
  const samples: any[] = r.generatedSamples ?? r.generatedVideos ?? [];
  const outputs = samples.map((s) => s?.video?.uri).filter(Boolean).map((url: string) => ({ url, mime: "video/mp4", auth: true }));
  if (!outputs.length && (r.raiMediaFilteredCount || r.raiMediaFilteredReasons?.length))
    return { state: "failed", code: "blocked", message: `Google filtered the video: ${(r.raiMediaFilteredReasons ?? []).join("; ") || "safety filter"}`, hint: "Reword the prompt or use another reference image." };
  return { state: "done", outputs };
}

// ---- Gemini Omni Flash (Interactions API, background) ----
async function omni(ctx: Ctx): Promise<Step> {
  const req = ctx.req;
  const refs = (await ctx.refBytes()).filter(isImage);
  const input = refs.length
    ? [...refs.map((r) => ({ type: "image", data: inline(r).data, mime_type: r.mime })), { type: "text", text: req.prompt ?? "" }]
    : req.prompt ?? "";
  const body = withProviderOptions(
    {
      model: ctx.model.remoteId,
      input,
      response_format: strip({ type: "video", aspect_ratio: req.aspect === "9:16" ? "9:16" : req.aspect ? "16:9" : undefined, resolution: req.resolution }),
      background: true,
    },
    req,
  );
  const res = await ctx.http({ method: "POST", url: `${BASE}/interactions`, json: body, timeoutMs: 600_000 });
  return interactionStep(res.json);
}

function interactionStep(j: any): Step {
  const status = j?.status;
  if (status === "failed" || status === "cancelled")
    return { state: "failed", message: `Gemini Omni: ${j?.error?.message ?? status}` };
  if (status !== "completed") return { state: "running", remote: { kind: "interaction", id: j.id } };
  const outputs: RemoteOutput[] = [];
  for (const step of j.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const c of step.content ?? []) {
      if (c?.type !== "video") continue;
      if (c.data) outputs.push({ bytes: fromB64(c.data), mime: c.mime_type ?? "video/mp4" });
      else if (c.uri) outputs.push({ url: c.uri, mime: c.mime_type ?? "video/mp4", auth: true });
    }
  }
  return { state: "done", outputs };
}

export const google: Connector = {
  id: "google",
  name: "Google Gemini",
  kinds: ["image", "video", "music", "speech"],
  docs: "https://ai.google.dev/gemini-api/docs",
  keyUrl: "https://aistudio.google.com/apikey",
  terms: "https://ai.google.dev/gemini-api/terms",
  auth: (key) => ({ "x-goog-api-key": key }),

  async submit(ctx) {
    switch (ctx.model.kind) {
      case "image":
        return image(ctx);
      case "speech":
        return speech(ctx);
      case "music":
        return music(ctx);
      case "video":
        return ctx.model.api === "interactions" ? omni(ctx) : veo(ctx);
      default:
        return { state: "failed", code: "invalid", message: `Google does not make ${ctx.model.kind}` };
    }
  },

  async poll(ctx, remote) {
    if (remote.kind === "interaction") {
      const res = await ctx.http({ method: "GET", url: `${BASE}/interactions/${remote.id}`, timeoutMs: 300_000 });
      return interactionStep(res.json);
    }
    return pollOperation(ctx, String(remote.name));
  },

  async cancel(ctx, remote) {
    if (remote.kind === "interaction") await ctx.http({ method: "POST", url: `${BASE}/interactions/${remote.id}/cancel`, json: {} });
  },

  async listModels(ctx) {
    const ids: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ctx.http({ method: "GET", url: `${BASE}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}` });
      for (const m of res.json.models ?? []) ids.push(String(m.name).replace(/^models\//, ""));
      token = res.json.nextPageToken;
      if (!token) break;
    }
    return ids;
  },
};

