// HeyGen v3 (v1/v2 video endpoints are retired after 2026-10-31). Header `X-Api-Key`.
// Checked 2026-10-08 against https://developers.heygen.com/reference/create-video and /reference/get-video:
//   POST /v3/videos { type: "avatar", avatar_id, script + voice_id | audio_url, resolution, aspect_ratio }
//                   { type: "image", image: { type: "url" | "base64", … }, script + voice_id | audio_url }
//        → { data: { video_id, status: "waiting" } }
//   GET  /v3/videos/{video_id} → data.status pending | processing | completed | failed, data.video_url (presigned, expires)
import { ClaudiaMediaError } from "../errors.js";
import { isAudio, isImage, strip, withProviderOptions, type Connector, type Step } from "./base.js";

const BASE = "https://api.heygen.com/v3";
const ASPECTS = new Set(["16:9", "9:16", "4:5", "1:1"]);

export const heygen: Connector = {
  id: "heygen",
  name: "HeyGen",
  kinds: ["avatar"],
  docs: "https://developers.heygen.com/reference/create-video",
  keyUrl: "https://app.heygen.com/settings?nav=API",
  terms: "https://www.heygen.com/terms",
  auth: (key) => ({ "X-Api-Key": key }),
  async submit(ctx) {
    const req = ctx.req;
    const refs = await ctx.refBytes();
    const avatarId = typeof req.meta?.avatarId === "string" ? req.meta.avatarId : undefined;
    const img = refs.find(isImage);
    const audio = refs.find(isAudio);
    const base: Record<string, unknown> = strip({
      resolution: req.resolution,
      aspect_ratio: req.aspect && ASPECTS.has(req.aspect) ? req.aspect : undefined,
      motion_prompt: req.prompt || undefined,
      title: typeof req.meta?.title === "string" ? req.meta.title : undefined,
    });
    if (audio) {
      if (!/^https?:/.test(audio.source))
        throw new ClaudiaMediaError("invalid", "HeyGen needs audio as a public URL", { hint: "Pass `text` + `voice` instead, or share the audio with a public link (e.g. useclaudia.xyz/relay/media) and pass that URL." });
      base.audio_url = audio.source;
    } else {
      if (!req.text) throw new ClaudiaMediaError("invalid", "HeyGen needs a script", { hint: "Pass `text` (what the avatar says) and `voice` (a HeyGen voice id)." });
      if (!req.voice && !avatarId) throw new ClaudiaMediaError("invalid", "HeyGen needs a voice id for a photo avatar", { hint: "Pick one from GET https://api.heygen.com/v3/voices and pass it as `voice`, or set it on the brand kit." });
      base.script = req.text;
      if (req.voice) base.voice_id = req.voice;
    }
    let body: Record<string, unknown>;
    if (avatarId) body = { type: "avatar", avatar_id: avatarId, ...base };
    else if (img) {
      const image = /^https?:/.test(img.source)
        ? { type: "url", url: img.source }
        : { type: "base64", media_type: img.mime, data: img.bytes ? Buffer.from(img.bytes).toString("base64") : `<base64 of ${img.source}>` };
      body = { type: "image", image, ...base };
    } else throw new ClaudiaMediaError("invalid", "HeyGen needs an avatar", { hint: "Pass meta.avatarId (a look id from GET /v3/avatars/looks) or a face photo in refs." });
    const res = await ctx.http({ method: "POST", url: `${BASE}/videos`, json: withProviderOptions(body, req) });
    return { state: "running", remote: { videoId: res.json?.data?.video_id }, progress: 0 };
  },
  async poll(ctx, remote): Promise<Step> {
    const res = await ctx.http({ method: "GET", url: `${BASE}/videos/${encodeURIComponent(String(remote.videoId))}` });
    const d = res.json?.data ?? {};
    if (d.status === "completed" && d.video_url) return { state: "done", outputs: [{ url: d.video_url, mime: "video/mp4", durationSec: d.duration }] };
    if (d.status === "failed") {
      const msg = `${d.failure_code ?? ""} ${d.failure_message ?? "failed"}`.trim();
      return { state: "failed", code: /moderat|policy|inappropriate|safety/i.test(msg) ? "blocked" : "provider_error", message: `HeyGen: ${msg}` };
    }
    return { state: "running", remote, progress: d.status === "processing" ? 0.5 : 0 };
  },
};
