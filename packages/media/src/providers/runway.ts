// Runway API. Headers `Authorization: Bearer <key>`, `X-Runway-Version: 2024-11-06`.
// Checked 2026-10-08 against https://docs.dev.runwayml.com/api.md and /guides/pricing.md:
//   POST /v1/image_to_video { model, promptImage, promptText, ratio, duration, seed }   → { id }
//   POST /v1/text_to_video  { model, promptText, ratio, duration }                     → { id }
//   POST /v1/video_to_video { model: "aleph2", videoUri, promptText, seed }             → { id }
//   POST /v1/text_to_image  { model, promptText, ratio, referenceImages[{ uri }] }       → { id }
//   GET  /v1/tasks/{id} → status PENDING | THROTTLED | RUNNING | SUCCEEDED | FAILED | CANCELLED, output[], cost.credits
//   DELETE /v1/tasks/{id}
// Output URLs expire in 24–48 h; 1 credit = $0.01. Poll no faster than every 5 s.
import { ClaudiaMediaError } from "../errors.js";
import { isImage, isVideo, strip, withProviderOptions, type Connector, type Step } from "./base.js";

const BASE = "https://api.dev.runwayml.com/v1";

const VIDEO_RATIO: Record<string, string> = { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960", "4:5": "832:1104", "3:2": "1104:832", "2:3": "832:1104" };
const IMAGE_RATIO: Record<string, string> = { "16:9": "1920:1080", "9:16": "1080:1920", "1:1": "1024:1024", "4:5": "1080:1440", "3:2": "1440:1080", "2:3": "1080:1440" };

export const runway: Connector = {
  id: "runway",
  name: "Runway",
  kinds: ["video", "image"],
  docs: "https://docs.dev.runwayml.com/api",
  keyUrl: "https://dev.runwayml.com/",
  terms: "https://runwayml.com/terms-of-use",
  auth: (key) => ({ Authorization: `Bearer ${key}`, "X-Runway-Version": "2024-11-06" }),
  async submit(ctx) {
    const req = ctx.req;
    const refs = await ctx.refUrls();
    const imgs = refs.filter(isImage);
    const video = refs.find(isVideo);
    const model = ctx.model.remoteId;
    let path: string;
    let body: Record<string, unknown>;
    if (ctx.model.kind === "image") {
      path = "text_to_image";
      body = strip({ model, promptText: req.prompt ?? "", ratio: IMAGE_RATIO[req.aspect ?? "16:9"], seed: req.seed, referenceImages: imgs.length ? imgs.slice(0, 3).map((r) => ({ uri: r.url })) : undefined });
    } else if (ctx.model.caps.edit) {
      if (!video) throw new ClaudiaMediaError("invalid", `${ctx.model.label} edits a video`, { hint: "Pass the source video (30 s or shorter) in refs." });
      path = "video_to_video";
      body = strip({ model, videoUri: video.url, promptText: req.prompt ?? "", seed: req.seed });
    } else if (imgs.length) {
      path = "image_to_video";
      body = strip({ model, promptImage: imgs[0]!.url, promptText: req.prompt, ratio: VIDEO_RATIO[req.aspect ?? "16:9"], duration: req.durationSec ?? 5, seed: req.seed });
    } else {
      if (!ctx.model.caps.textToVideo) throw new ClaudiaMediaError("invalid", `${ctx.model.label} needs a start image`, { hint: "Pass an image in refs, or use runway/gen4.5 for text-to-video." });
      path = "text_to_video";
      body = strip({ model, promptText: req.prompt ?? "", ratio: req.aspect === "9:16" ? "720:1280" : "1280:720", duration: req.durationSec ?? 5, seed: req.seed });
    }
    const res = await ctx.http({ method: "POST", url: `${BASE}/${path}`, json: withProviderOptions(body, req) });
    return { state: "running", remote: { taskId: res.json.id }, progress: 0 };
  },
  async poll(ctx, remote): Promise<Step> {
    const res = await ctx.http({ method: "GET", url: `${BASE}/tasks/${encodeURIComponent(String(remote.taskId))}` });
    const t = res.json ?? {};
    if (t.status === "SUCCEEDED") {
      const credits = t.cost?.credits;
      return { state: "done", outputs: (t.output ?? []).map((url: string) => ({ url })), costUsd: typeof credits === "number" ? credits / 100 : undefined };
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") {
      const code = String(t.failureCode ?? "");
      return { state: "failed", code: /SAFETY|MODERATION/i.test(code) ? "blocked" : "provider_error", message: `Runway: ${t.failure ?? t.status}${code ? ` (${code})` : ""}` };
    }
    return { state: "running", remote, progress: typeof t.progress === "number" ? t.progress : undefined };
  },
  async cancel(ctx, remote) {
    await ctx.http({ method: "DELETE", url: `${BASE}/tasks/${encodeURIComponent(String(remote.taskId))}` });
  },
};
