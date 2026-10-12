// ElevenLabs. Header `xi-api-key`.
// Checked 2026-10-08 against https://elevenlabs.io/docs/api-reference:
//   speech  POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128  { text, model_id, voice_settings? }  → audio bytes
//   sfx     POST /v1/sound-generation  { text, duration_seconds, prompt_influence, loop, model_id: "eleven_text_to_sound_v2" }
//   music   POST /v1/music  { prompt, music_length_ms (3000–600000), model_id, force_instrumental? }
//   models  GET /v1/models → [{ model_id, can_do_text_to_speech, … }]
// Default (premade) voices stop working on 2026-12-31: set your own voice id (a brand kit voice is the easy way).
import { strip, withProviderOptions, type Connector, type Ctx, type Step } from "./base.js";

const BASE = "https://api.elevenlabs.io/v1";
/** The voice used in ElevenLabs' own API examples. Pass `voice` to pick yours. */
export const ELEVENLABS_EXAMPLE_VOICE = "JBFqnCBsd6RMkjVDRZzb";

async function bytes(ctx: Ctx, url: string, json: unknown): Promise<Step> {
  const res = await ctx.http({ method: "POST", url, json, expect: "bytes", timeoutMs: 600_000 });
  return { state: "done", outputs: [{ bytes: res.bytes!, mime: res.headers["content-type"] ?? "audio/mpeg" }] };
}

export const elevenlabs: Connector = {
  id: "elevenlabs",
  name: "ElevenLabs",
  kinds: ["speech", "sfx", "music"],
  docs: "https://elevenlabs.io/docs/api-reference",
  keyUrl: "https://elevenlabs.io/app/settings/api-keys",
  terms: "https://elevenlabs.io/terms-of-use",
  auth: (key) => ({ "xi-api-key": key }),
  async submit(ctx) {
    const req = ctx.req;
    if (ctx.model.kind === "speech") {
      const voice = encodeURIComponent(req.voice || ELEVENLABS_EXAMPLE_VOICE);
      const settings = req.meta?.voiceSettings && typeof req.meta.voiceSettings === "object" ? req.meta.voiceSettings : undefined;
      return bytes(
        ctx,
        `${BASE}/text-to-speech/${voice}?output_format=mp3_44100_128`,
        withProviderOptions(strip({ text: req.text ?? req.prompt ?? "", model_id: ctx.model.remoteId, voice_settings: settings, seed: req.seed }), req),
      );
    }
    if (ctx.model.kind === "sfx") {
      return bytes(
        ctx,
        `${BASE}/sound-generation`,
        withProviderOptions(
          strip({
            text: req.prompt ?? req.text ?? "",
            duration_seconds: req.durationSec !== undefined ? Math.min(30, Math.max(0.5, req.durationSec)) : undefined,
            prompt_influence: typeof req.meta?.promptInfluence === "number" ? req.meta.promptInfluence : undefined,
            loop: req.meta?.loop === true ? true : undefined,
            model_id: ctx.model.remoteId,
          }),
          req,
        ),
      );
    }
    if (ctx.model.kind === "music") {
      return bytes(
        ctx,
        `${BASE}/music`,
        withProviderOptions(
          strip({
            prompt: req.prompt ?? "",
            music_length_ms: req.durationSec !== undefined ? Math.round(Math.min(600, Math.max(3, req.durationSec)) * 1000) : undefined,
            model_id: ctx.model.remoteId,
            force_instrumental: req.meta?.instrumental === true ? true : undefined,
            seed: req.seed,
          }),
          req,
        ),
      );
    }
    return { state: "failed", code: "invalid", message: `ElevenLabs does not make ${ctx.model.kind}` };
  },
  async listModels(ctx) {
    const res = await ctx.http({ method: "GET", url: `${BASE}/models` });
    return (Array.isArray(res.json) ? res.json : []).map((m: any) => String(m.model_id));
  },
};
