// BytePlus ModelArk (Seedance video, Seedream images). Header `Authorization: Bearer <ARK key>`.
// Checked 2026-10-08 against https://docs.byteplus.com/en/docs/ModelArk/1520757 (create task), /1521309 (get task),
// /1541523 (images):
//   POST /api/v3/contents/generations/tasks { model, content: [{ type: "text" }, { type: "image_url", image_url: { url }, role }], resolution, ratio, duration, seed, watermark }
//   GET  /api/v3/contents/generations/tasks/{id} → status queued | running | succeeded | failed | cancelled | expired, content.video_url
//   DELETE /api/v3/contents/generations/tasks/{id} (cancels queued tasks only)
//   POST /api/v3/images/generations { model, prompt, image?, size, response_format: "url", watermark } → data[].url (24 h)
import { isImage, strip, withProviderOptions, type Connector, type Step } from "./base.js";

const BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
const SIZES: Record<string, string> = { "1:1": "2048x2048", "16:9": "2560x1440", "9:16": "1440x2560", "4:5": "1824x2280", "3:2": "2496x1664", "2:3": "1664x2496" };

export const byteplus: Connector = {
  id: "byteplus",
  name: "BytePlus ModelArk",
  kinds: ["video", "image"],
  docs: "https://docs.byteplus.com/en/docs/ModelArk/1520757",
  keyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey",
  terms: "https://www.byteplus.com/en/legal/terms-of-service",
  auth: (key) => ({ Authorization: `Bearer ${key}` }),
  async submit(ctx) {
    const req = ctx.req;
    const imgs = (await ctx.refUrls()).filter(isImage);
    if (ctx.model.kind === "image") {
      const body = strip({
        model: ctx.model.remoteId,
        prompt: req.prompt ?? "",
        image: imgs.length === 0 ? undefined : imgs.length === 1 ? imgs[0]!.url : imgs.map((r) => r.url),
        size: req.resolution ?? (req.aspect ? SIZES[req.aspect] : "2K"),
        seed: req.seed,
        response_format: "url",
        watermark: false,
      });
      const res = await ctx.http({ method: "POST", url: `${BASE}/images/generations`, json: withProviderOptions(body, req), timeoutMs: 300_000 });
      const outs = (res.json?.data ?? []).map((d: any) => (d.url ? { url: d.url } : d.b64_json ? { bytes: new Uint8Array(Buffer.from(d.b64_json, "base64")) } : null)).filter(Boolean);
      return { state: "done", outputs: outs };
    }
    const content: unknown[] = [{ type: "text", text: req.prompt ?? "" }];
    imgs.slice(0, 2).forEach((r, i) => content.push({ type: "image_url", image_url: { url: r.url }, role: i === 0 ? "first_frame" : "last_frame" }));
    const body = strip({
      model: ctx.model.remoteId,
      content,
      resolution: req.resolution,
      ratio: req.aspect && RATIOS.has(req.aspect) ? req.aspect : imgs.length ? "adaptive" : undefined,
      duration: req.durationSec !== undefined ? Math.round(req.durationSec) : undefined,
      seed: req.seed,
      generate_audio: typeof req.meta?.audio === "boolean" ? req.meta.audio : undefined,
      watermark: false,
    });
    const res = await ctx.http({ method: "POST", url: `${BASE}/contents/generations/tasks`, json: withProviderOptions(body, req) });
    return { state: "running", remote: { taskId: res.json.id }, progress: 0 };
  },
  async poll(ctx, remote): Promise<Step> {
    const res = await ctx.http({ method: "GET", url: `${BASE}/contents/generations/tasks/${encodeURIComponent(String(remote.taskId))}` });
    const t = res.json ?? {};
    if (t.status === "succeeded") return { state: "done", outputs: t.content?.video_url ? [{ url: t.content.video_url, mime: "video/mp4" }] : [] };
    if (t.status === "failed" || t.status === "cancelled")
      return { state: "failed", code: /sensitive|policy|risk|moderation/i.test(`${t.error?.code} ${t.error?.message}`) ? "blocked" : "provider_error", message: `BytePlus: ${t.error?.message ?? t.status}` };
    if (t.status === "expired") return { state: "failed", code: "expired", message: "BytePlus: the task expired before it ran" };
    return { state: "running", remote, progress: t.status === "running" ? 0.5 : 0 };
  },
  async cancel(ctx, remote) {
    await ctx.http({ method: "DELETE", url: `${BASE}/contents/generations/tasks/${encodeURIComponent(String(remote.taskId))}` });
  },
};
