// The model table: every model id, endpoint id, capability and price lives here (not in connector code).
// Prices and ids were checked against each provider's official docs on 2026-10-08 (see `docs` / `price.url`).
// confidence "list" = read off the provider's price page; "estimate" = derived by us (or a third-party figure).
// `unverified: true` = the provider-side id could not be confirmed in the docs; use with care.
// `shutdown` = announced shutdown date; the model is treated as retired from that day on.
import type { FalSpec } from "./providers/fal.js";
import { priceEstimate, speechSeconds, type CostSpec } from "./pricing.js";
import { readLocalRef } from "./providers/base.js";
import { sniff } from "./sniff.js";
import type { Estimate, GenerateRequest, MediaKind, PriceInfo, ProviderId } from "./types.js";

const ASOF = "2026-10-08";
const SYNTHID = "SynthID";

export interface ModelEntry {
  id: string;
  provider: ProviderId;
  kind: MediaKind;
  label: string;
  /** Provider model name or primary endpoint id. */
  remoteId: string;
  caps: Record<string, unknown>;
  cost: CostSpec;
  price: PriceInfo;
  priceHint: string;
  docs: string;
  watermark?: string;
  unverified?: boolean;
  retired?: boolean;
  /** YYYY-MM-DD the provider shuts the model down. */
  shutdown?: string;
  replacedBy?: string;
  /** Lower = preferred default for its kind (only models with a rank are picked automatically). */
  defaultRank?: number;
  /** Google: which API surface. */
  api?: "interactions";
  fal?: FalSpec;
  /** USD per 1M tokens, for exact cost from reported usage (OpenAI images). */
  tokenPrice?: { textIn: number; imageIn: number; out: number };
  /** false = the provider's model list endpoint doesn't include this id (skip in checkModels). */
  listed?: boolean;
  remoteIds(): string[];
}

type Row = Omit<ModelEntry, "remoteIds" | "priceHint" | "price"> & { price: Omit<PriceInfo, "asOf"> & { asOf?: string }; priceHint?: string };

const G_PRICE = "https://ai.google.dev/gemini-api/docs/pricing";
const OAI_PRICE = "https://developers.openai.com/api/docs/pricing";
const EL_PRICE = "https://elevenlabs.io/pricing/api";
const RW_PRICE = "https://docs.dev.runwayml.com/guides/pricing";
const BP_PRICE = "https://docs.byteplus.com/en/docs/ModelArk/1544106";
const falDocs = (id: string) => `https://fal.ai/models/${id}/api`;

const ROWS: Row[] = [
  // ---------------- Google: images (Nano Banana) ----------------
  {
    id: "google/nano-banana-2.1", provider: "google", kind: "image", label: "Nano Banana 2.1", remoteId: "gemini-nano-banana-2.1",
    caps: { refs: 14, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], resolutions: ["1K", "2K", "4K"], edit: true },
    cost: { per: "image", usd: 0.0336, byResolution: { "1k": 0.0336, "2k": 0.0504, "4k": 0.113 } },
    price: { basis: "$0.0336 per 1K image, $0.0504 2K, $0.113 4K", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/image-generation", watermark: SYNTHID, defaultRank: 1,
  },
  {
    id: "google/nano-banana-2", provider: "google", kind: "image", label: "Nano Banana 2", remoteId: "gemini-3.1-flash-image",
    caps: { refs: 14, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], resolutions: ["512", "1K", "2K", "4K"], edit: true },
    cost: { per: "image", usd: 0.067, byResolution: { "512": 0.045, "1k": 0.067, "2k": 0.101, "4k": 0.151 } },
    price: { basis: "$0.067 per 1K image ($0.045 512px, $0.101 2K, $0.151 4K)", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/image-generation", watermark: SYNTHID,
  },
  {
    id: "google/nano-banana-lite", provider: "google", kind: "image", label: "Nano Banana Lite", remoteId: "gemini-3.1-flash-lite-image",
    caps: { refs: 14, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], resolutions: ["1K"], edit: true },
    cost: { per: "image", usd: 0.0336 },
    price: { basis: "$0.0336 per image (1K only)", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/image-generation", watermark: SYNTHID,
  },
  {
    id: "google/nano-banana-pro", provider: "google", kind: "image", label: "Nano Banana Pro", remoteId: "gemini-3-pro-image",
    caps: { refs: 14, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], resolutions: ["1K", "2K", "4K"], edit: true },
    cost: { per: "image", usd: 0.134, byResolution: { "1k": 0.134, "2k": 0.134, "4k": 0.24 } },
    price: { basis: "$0.134 per 1K/2K image, $0.24 4K", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/image-generation", watermark: SYNTHID,
  },
  {
    id: "google/gemini-2.5-flash-image", provider: "google", kind: "image", label: "Nano Banana (Gemini 2.5 Flash Image)", remoteId: "gemini-2.5-flash-image",
    caps: { refs: 3, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], note: "Google's pricing page says this shut down 2026-10-02 (the deprecations page says 2027-03-15)." },
    cost: { per: "image", usd: 0.039 },
    price: { basis: "$0.039 per image", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/deprecations", watermark: SYNTHID, shutdown: "2026-10-02", replacedBy: "google/nano-banana-2.1",
  },
  {
    id: "google/imagen-4", provider: "google", kind: "image", label: "Imagen 4", remoteId: "imagen-4.0-generate-001",
    caps: {}, cost: { per: "image", usd: 0.04 },
    price: { basis: "retired", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/deprecations", watermark: SYNTHID, shutdown: "2026-08-17", replacedBy: "google/nano-banana-2.1",
  },

  // ---------------- Google: video ----------------
  {
    id: "google/omni-flash", provider: "google", kind: "video", label: "Gemini Omni Flash", remoteId: "gemini-omni-1.1-flash", api: "interactions",
    caps: { refs: 3, aspects: ["16:9", "9:16"], resolutions: ["360p", "720p", "1080p", "4k"], audio: true, note: "Duration is decided by the model from the prompt; billed by output tokens." },
    cost: { per: "second", usd: 0.1, defaultSec: 8 },
    price: { basis: "~$0.10 per second at 720p ($17.50 per 1M output tokens, 5,792 tokens/s); length set by the model, 8 s assumed", confidence: "estimate", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/omni", watermark: SYNTHID, defaultRank: 1,
  },
  {
    id: "google/veo-3.1", provider: "google", kind: "video", label: "Veo 3.1", remoteId: "veo-3.1-generate-preview",
    caps: { refs: 3, aspects: ["16:9", "9:16"], resolutions: ["720p", "1080p", "4k"], durations: [4, 6, 8], audio: true, lastFrame: true, referenceImages: 3 },
    cost: { per: "second", usd: 0.4, byResolution: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 }, defaultSec: 8 },
    price: { basis: "$0.40 per second (720p/1080p), $0.60 4K, audio included, billed only on success", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/veo", watermark: SYNTHID, shutdown: "2026-10-22", replacedBy: "google/omni-flash",
  },
  {
    id: "google/veo-3.1-fast", provider: "google", kind: "video", label: "Veo 3.1 Fast", remoteId: "veo-3.1-fast-generate-preview",
    caps: { refs: 3, aspects: ["16:9", "9:16"], resolutions: ["720p", "1080p", "4k"], durations: [4, 6, 8], audio: true, lastFrame: true, referenceImages: 3 },
    cost: { per: "second", usd: 0.1, byResolution: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 }, defaultSec: 8 },
    price: { basis: "$0.10 per second 720p, $0.12 1080p, $0.30 4K, audio included", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/veo", watermark: SYNTHID, shutdown: "2026-10-22", replacedBy: "google/omni-flash",
  },
  {
    id: "google/veo-3.1-lite", provider: "google", kind: "video", label: "Veo 3.1 Lite", remoteId: "veo-3.1-lite-generate-preview",
    caps: { refs: 2, aspects: ["16:9", "9:16"], resolutions: ["720p", "1080p"], durations: [4, 6, 8], audio: true, lastFrame: true },
    cost: { per: "second", usd: 0.05, byResolution: { "720p": 0.05, "1080p": 0.08 }, defaultSec: 8 },
    price: { basis: "$0.05 per second 720p, $0.08 1080p, audio included", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/veo", watermark: SYNTHID, shutdown: "2026-10-22", replacedBy: "google/omni-flash",
  },

  // ---------------- Google: music + speech ----------------
  {
    id: "google/lyria-3.5", provider: "google", kind: "music", label: "Lyria 3.5", remoteId: "lyria-3.5",
    caps: { refs: 1, lyrics: true, formats: ["mp3", "wav"], note: "Full song of a couple of minutes, shaped by the prompt." },
    cost: { per: "call", usd: 0.08 },
    price: { basis: "$0.08 per song", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/music-generation", watermark: SYNTHID, defaultRank: 1,
  },
  {
    id: "google/lyria-3-clip", provider: "google", kind: "music", label: "Lyria 3 Clip", remoteId: "lyria-3-clip-preview",
    caps: { refs: 1, durations: [30] },
    cost: { per: "call", usd: 0.04 },
    price: { basis: "$0.04 per 30-second clip", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/music-generation", watermark: SYNTHID,
  },
  {
    id: "google/gemini-3.8-flash-tts", provider: "google", kind: "speech", label: "Gemini 3.8 Flash TTS", remoteId: "gemini-3.8-flash-tts",
    caps: { voices: ["Kore", "Puck", "Zephyr", "Charon", "Fenrir", "Leda", "Orus", "Aoede", "Sulafat", "Achird"], style: true, languages: 130 },
    cost: { per: "tokens", inPerM: 0.5, outPerM: 9, outTokensPerSec: 25 },
    price: { basis: "$0.50 per 1M input tokens + $9.00 per 1M audio tokens (25 tokens/s) until 2026-12-31, then $1.00 / $18.00", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/speech-generation", watermark: SYNTHID, defaultRank: 2,
  },
  {
    id: "google/gemini-3.8-flash-lite-tts", provider: "google", kind: "speech", label: "Gemini 3.8 Flash-Lite TTS", remoteId: "gemini-3.8-flash-lite-tts",
    caps: { voices: ["Kore", "Puck", "Zephyr", "Charon"], style: true, languages: 100 },
    cost: { per: "tokens", inPerM: 0.5, outPerM: 6, outTokensPerSec: 25 },
    price: { basis: "$0.50 per 1M input tokens + $6.00 per 1M audio tokens until 2026-12-31, then $1.00 / $12.00", confidence: "list", url: G_PRICE },
    docs: "https://ai.google.dev/gemini-api/docs/generate-content/speech-generation", watermark: SYNTHID,
  },

  // ---------------- OpenAI ----------------
  {
    id: "openai/gpt-image-2.5-flare", provider: "openai", kind: "image", label: "GPT Image 2.5 Flare", remoteId: "gpt-image-2.5-flare",
    caps: { refs: 16, edit: true, transparent: true, freeSize: true, qualities: ["low", "medium", "high", "xhigh", "max"], aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.0132, byQuality: { low: 0.0059, medium: 0.0132, high: 0.0527, xhigh: 0.0937, max: 0.2107 } },
    tokenPrice: { textIn: 5, imageIn: 8, out: 30 },
    price: { basis: "~$0.013 per 1024² medium image ($0.006 low, $0.053 high); $30 per 1M output tokens, from OpenAI's calculator", confidence: "estimate", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/reference/resources/images/methods/generate", watermark: "C2PA", defaultRank: 2,
  },
  {
    id: "openai/gpt-image-2.5-sunburst", provider: "openai", kind: "image", label: "GPT Image 2.5 Sunburst", remoteId: "gpt-image-2.5-sunburst",
    caps: { refs: 16, edit: true, transparent: true, freeSize: true, qualities: ["low", "medium", "high", "xhigh", "max"], aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], note: "Best for precise edits." },
    cost: { per: "image", usd: 0.0132, byQuality: { low: 0.0059, medium: 0.0132, high: 0.0527, xhigh: 0.0937, max: 0.2107 } },
    tokenPrice: { textIn: 5, imageIn: 8, out: 30 },
    price: { basis: "~$0.013 per 1024² medium image; $30 per 1M output tokens, from OpenAI's calculator", confidence: "estimate", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/reference/resources/images/methods/edit", watermark: "C2PA",
  },
  {
    id: "openai/gpt-image-2", provider: "openai", kind: "image", label: "GPT Image 2", remoteId: "gpt-image-2",
    caps: { refs: 16, edit: true, transparent: "preview", freeSize: true, qualities: ["low", "medium", "high"], aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.053, byQuality: { low: 0.006, medium: 0.053, high: 0.211 } },
    tokenPrice: { textIn: 5, imageIn: 8, out: 30 },
    price: { basis: "$0.053 per 1024² medium image ($0.006 low, $0.211 high)", confidence: "list", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/reference/resources/images/methods/generate", watermark: "C2PA",
  },
  {
    id: "openai/gpt-image-1.5", provider: "openai", kind: "image", label: "GPT Image 1.5", remoteId: "gpt-image-1.5",
    caps: { refs: 16, edit: true, transparent: true, qualities: ["low", "medium", "high"], aspects: ["1:1", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.034, byQuality: { low: 0.009, medium: 0.034, high: 0.133 } },
    tokenPrice: { textIn: 5, imageIn: 8, out: 32 },
    price: { basis: "$0.034 per 1024² medium image ($0.009 low, $0.133 high)", confidence: "list", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/docs/deprecations", watermark: "C2PA", shutdown: "2026-12-01", replacedBy: "openai/gpt-image-2.5-flare",
  },
  {
    id: "openai/gpt-image-1-mini", provider: "openai", kind: "image", label: "GPT Image 1 Mini", remoteId: "gpt-image-1-mini",
    caps: { refs: 16, edit: true, transparent: true, qualities: ["low", "medium", "high"], aspects: ["1:1", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.011, byQuality: { low: 0.005, medium: 0.011, high: 0.036 } },
    tokenPrice: { textIn: 2, imageIn: 2.5, out: 8 },
    price: { basis: "$0.011 per 1024² medium image ($0.005 low, $0.036 high)", confidence: "list", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/docs/deprecations", watermark: "C2PA", shutdown: "2026-12-01", replacedBy: "openai/gpt-image-2.5-flare",
  },
  {
    id: "openai/gpt-4o-mini-tts", provider: "openai", kind: "speech", label: "GPT-4o mini TTS", remoteId: "gpt-4o-mini-tts",
    caps: { voices: ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"], style: true, maxChars: 4096, note: "OpenAI shuts this down 2027-01-06." },
    cost: { per: "minute", usd: 0.015, defaultSec: 30 },
    price: { basis: "$0.60 per 1M text tokens + $12 per 1M audio tokens (~$0.015 per minute)", confidence: "estimate", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create", shutdown: "2027-01-06", defaultRank: 3,
  },
  {
    id: "openai/tts-1-hd", provider: "openai", kind: "speech", label: "TTS-1 HD", remoteId: "tts-1-hd",
    caps: { voices: ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"], maxChars: 4096 },
    cost: { per: "kchars", usd: 0.03 },
    price: { basis: "$30 per 1M characters", confidence: "list", url: OAI_PRICE },
    docs: "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create", shutdown: "2027-01-06",
  },

  // ---------------- fal.ai: video ----------------
  {
    id: "fal/kling-2.6-pro", provider: "fal", kind: "video", label: "Kling 2.6 Pro", remoteId: "fal-ai/kling-video/v2.6/pro/text-to-video",
    fal: { text: "fal-ai/kling-video/v2.6/pro/text-to-video", image: "fal-ai/kling-video/v2.6/pro/image-to-video", imageField: "start_image_url", endImageField: "end_image_url", duration: "string", aspect: true, negative: true, audio: true },
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1"], durations: [5, 10], audio: true },
    cost: { per: "second", usd: 0.14, silentUsd: 0.07, defaultSec: 5 },
    price: { basis: "$0.14 per second with audio ($0.07 without)", confidence: "list", url: falDocs("fal-ai/kling-video/v2.6/pro/text-to-video") },
    docs: falDocs("fal-ai/kling-video/v2.6/pro/text-to-video"), defaultRank: 2,
  },
  {
    id: "fal/kling-3-pro", provider: "fal", kind: "video", label: "Kling 3 Pro", remoteId: "fal-ai/kling-video/v3/pro/text-to-video",
    fal: { text: "fal-ai/kling-video/v3/pro/text-to-video", image: "fal-ai/kling-video/v3/pro/image-to-video", imageField: "start_image_url", endImageField: "end_image_url", duration: "string", aspect: true, negative: true, audio: true },
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1"], durations: [3, 15], audio: true },
    cost: { per: "second", usd: 0.168, silentUsd: 0.112, defaultSec: 5 },
    price: { basis: "$0.168 per second with audio ($0.112 without)", confidence: "list", url: falDocs("fal-ai/kling-video/v3/pro/text-to-video") },
    docs: falDocs("fal-ai/kling-video/v3/pro/text-to-video"),
  },
  {
    id: "fal/kling-2.5-turbo-pro", provider: "fal", kind: "video", label: "Kling 2.5 Turbo Pro", remoteId: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    fal: { text: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", image: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", imageField: "image_url", endImageField: "tail_image_url", duration: "string", aspect: true, negative: true },
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1"], durations: [5, 10] },
    cost: { per: "second", usd: 0.07, defaultSec: 5 },
    price: { basis: "$0.35 for 5 s + $0.07 per extra second", confidence: "list", url: falDocs("fal-ai/kling-video/v2.5-turbo/pro/text-to-video") },
    docs: falDocs("fal-ai/kling-video/v2.5-turbo/pro/text-to-video"),
  },
  {
    id: "fal/seedance-2.0", provider: "fal", kind: "video", label: "Seedance 2.0", remoteId: "bytedance/seedance-2.0/text-to-video",
    fal: { text: "bytedance/seedance-2.0/text-to-video", image: "bytedance/seedance-2.0/image-to-video", imageField: "image_url", endImageField: "end_image_url", duration: "string", aspect: true, resolution: true, audio: true },
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p", "4k"], durations: [4, 15], audio: true },
    cost: { per: "second", usd: 0.3034, byResolution: { "720p": 0.3034, "1080p": 0.682 }, defaultSec: 5 },
    price: { basis: "$0.3034 per second 720p, $0.682 1080p", confidence: "list", url: falDocs("bytedance/seedance-2.0/text-to-video") },
    docs: falDocs("bytedance/seedance-2.0/text-to-video"),
  },
  {
    id: "fal/seedance-1.5-pro", provider: "fal", kind: "video", label: "Seedance 1.5 Pro", remoteId: "fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
    fal: { text: "fal-ai/bytedance/seedance/v1.5/pro/text-to-video", image: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video", imageField: "image_url", endImageField: "end_image_url", duration: "string", aspect: true, resolution: true, audio: true },
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p"], durations: [4, 12], audio: true },
    cost: { per: "second", usd: 0.052, defaultSec: 5 },
    price: { basis: "~$0.26 per 720p 5 s video with audio ($2.4 per 1M video tokens)", confidence: "estimate", url: falDocs("fal-ai/bytedance/seedance/v1.5/pro/text-to-video") },
    docs: falDocs("fal-ai/bytedance/seedance/v1.5/pro/text-to-video"),
  },
  {
    id: "fal/hailuo-2.3", provider: "fal", kind: "video", label: "MiniMax Hailuo 2.3", remoteId: "fal-ai/minimax/hailuo-2.3/standard/text-to-video",
    fal: { text: "fal-ai/minimax/hailuo-2.3/standard/text-to-video", image: "fal-ai/minimax/hailuo-2.3/standard/image-to-video", imageField: "image_url", duration: "string" },
    caps: { refs: 1, durations: [6, 10], note: "No aspect or resolution control." },
    cost: { per: "second", usd: 0.0467, defaultSec: 6 },
    price: { basis: "$0.28 per 6 s, $0.56 per 10 s", confidence: "list", url: falDocs("fal-ai/minimax/hailuo-2.3/standard/text-to-video") },
    docs: falDocs("fal-ai/minimax/hailuo-2.3/standard/text-to-video"),
  },
  {
    id: "fal/wan-2.6", provider: "fal", kind: "video", label: "Wan 2.6", remoteId: "wan/v2.6/text-to-video",
    fal: { text: "wan/v2.6/text-to-video", image: "wan/v2.6/image-to-video", imageField: "image_url", duration: "string", aspect: true, resolution: true, negative: true },
    caps: { refs: 1, aspects: ["16:9", "9:16", "1:1"], resolutions: ["720p", "1080p"], durations: [5, 10, 15] },
    cost: { per: "second", usd: 0.1, byResolution: { "720p": 0.1, "1080p": 0.15 }, defaultSec: 5 },
    price: { basis: "$0.10 per second 720p, $0.15 1080p", confidence: "list", url: falDocs("wan/v2.6/text-to-video") },
    docs: falDocs("wan/v2.6/text-to-video"),
  },

  // ---------------- fal.ai: images ----------------
  {
    id: "fal/flux-2-pro", provider: "fal", kind: "image", label: "FLUX.2 Pro", remoteId: "fal-ai/flux-2-pro",
    fal: { text: "fal-ai/flux-2-pro", image: "fal-ai/flux-2-pro/edit", imagesField: "image_urls", imageSize: true },
    caps: { refs: 4, edit: true, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.03 },
    price: { basis: "$0.03 for the first megapixel, $0.015 per extra megapixel", confidence: "list", url: falDocs("fal-ai/flux-2-pro") },
    docs: falDocs("fal-ai/flux-2-pro"), defaultRank: 3,
  },
  {
    id: "fal/flux-dev", provider: "fal", kind: "image", label: "FLUX.1 dev", remoteId: "fal-ai/flux/dev",
    fal: { text: "fal-ai/flux/dev", imageSize: true },
    caps: { refs: 0, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], n: 4 },
    cost: { per: "image", usd: 0.025 },
    price: { basis: "$0.025 per megapixel", confidence: "list", url: falDocs("fal-ai/flux/dev") },
    docs: falDocs("fal-ai/flux/dev"),
  },
  {
    id: "fal/flux-kontext-pro", provider: "fal", kind: "image", label: "FLUX.1 Kontext Pro (edit)", remoteId: "fal-ai/flux-pro/kontext",
    fal: { image: "fal-ai/flux-pro/kontext", imageField: "image_url", aspect: true },
    caps: { refs: 1, edit: true, needsRef: true },
    cost: { per: "image", usd: 0.04 },
    price: { basis: "$0.04 per image", confidence: "list", url: falDocs("fal-ai/flux-pro/kontext") },
    docs: falDocs("fal-ai/flux-pro/kontext"),
  },

  // ---------------- fal.ai: avatars / lip-sync ----------------
  {
    id: "fal/omnihuman-1.5", provider: "fal", kind: "avatar", label: "OmniHuman 1.5 (photo + audio)", remoteId: "fal-ai/bytedance/omnihuman/v1.5",
    fal: { text: "fal-ai/bytedance/omnihuman/v1.5", avatar: "image+audio", resolution: true },
    caps: { refs: 2, needs: ["image", "audio"], resolutions: ["720p", "1080p"] },
    cost: { per: "second", usd: 0.16, defaultSec: 10 },
    price: { basis: "$0.16 per second of output", confidence: "list", url: falDocs("fal-ai/bytedance/omnihuman/v1.5") },
    docs: falDocs("fal-ai/bytedance/omnihuman/v1.5"), defaultRank: 2,
  },
  {
    id: "fal/lipsync-2", provider: "fal", kind: "avatar", label: "Sync Lipsync 2 (video + audio)", remoteId: "fal-ai/sync-lipsync/v2",
    fal: { text: "fal-ai/sync-lipsync/v2", avatar: "video+audio" },
    caps: { refs: 2, needs: ["video", "audio"] },
    cost: { per: "minute", usd: 3, defaultSec: 10 },
    price: { basis: "$3.00 per minute", confidence: "list", url: falDocs("fal-ai/sync-lipsync/v2") },
    docs: falDocs("fal-ai/sync-lipsync/v2"),
  },
  {
    id: "fal/veed-lipsync", provider: "fal", kind: "avatar", label: "VEED Lipsync (video + audio)", remoteId: "veed/lipsync",
    fal: { text: "veed/lipsync", avatar: "video+audio" },
    caps: { refs: 2, needs: ["video", "audio"] },
    cost: { per: "minute", usd: 0.4, defaultSec: 10 },
    price: { basis: "$0.40 per minute", confidence: "list", url: falDocs("veed/lipsync") },
    docs: falDocs("veed/lipsync"),
  },

  // ---------------- ElevenLabs ----------------
  {
    id: "elevenlabs/multilingual-v2", provider: "elevenlabs", kind: "speech", label: "Eleven Multilingual v2", remoteId: "eleven_multilingual_v2",
    caps: { maxChars: 10000, voiceRequired: true, note: "Premade voices stop working 2026-12-31; set your own voice id." },
    cost: { per: "kchars", usd: 0.08 },
    price: { basis: "$0.08 per 1,000 characters", confidence: "list", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert", defaultRank: 1,
  },
  {
    id: "elevenlabs/v3", provider: "elevenlabs", kind: "speech", label: "Eleven v3", remoteId: "eleven_v3",
    caps: { maxChars: 5000, voiceRequired: true, audioTags: true },
    cost: { per: "kchars", usd: 0.08 },
    price: { basis: "$0.08 per 1,000 characters", confidence: "list", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
  },
  {
    id: "elevenlabs/flash-v2.5", provider: "elevenlabs", kind: "speech", label: "Eleven Flash v2.5", remoteId: "eleven_flash_v2_5",
    caps: { maxChars: 40000, voiceRequired: true, lowLatency: true },
    cost: { per: "kchars", usd: 0.04 },
    price: { basis: "$0.04 per 1,000 characters", confidence: "list", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
  },
  {
    id: "elevenlabs/sfx-v2", provider: "elevenlabs", kind: "sfx", label: "Eleven Sound Effects v2", remoteId: "eleven_text_to_sound_v2",
    caps: { durationRange: [0.5, 30], loop: true },
    cost: { per: "minute", usd: 0.12, defaultSec: 10 },
    price: { basis: "$0.12 per minute of sound (billed per generation; 10 s assumed when no duration is given)", confidence: "estimate", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert", defaultRank: 1, listed: false,
  },
  {
    id: "elevenlabs/music-v1", provider: "elevenlabs", kind: "music", label: "Eleven Music v1", remoteId: "music_v1",
    caps: { durationRange: [3, 600], instrumental: true },
    cost: { per: "minute", usd: 0.15, defaultSec: 30 },
    price: { basis: "$0.15 per minute of music", confidence: "list", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/music/compose", defaultRank: 2, listed: false,
  },
  {
    id: "elevenlabs/music-v2.5", provider: "elevenlabs", kind: "music", label: "Eleven Music v2.5", remoteId: "music_v2_5",
    caps: { durationRange: [3, 600], instrumental: true },
    cost: { per: "minute", usd: 0.15, defaultSec: 30 },
    price: { basis: "$0.15 per minute of music", confidence: "list", url: EL_PRICE },
    docs: "https://elevenlabs.io/docs/api-reference/music/compose", listed: false,
  },

  // ---------------- HeyGen ----------------
  {
    id: "heygen/avatar-iv", provider: "heygen", kind: "avatar", label: "HeyGen Avatar IV", remoteId: "avatar_iv",
    caps: { refs: 2, avatarId: true, photo: true, aspects: ["16:9", "9:16", "4:5", "1:1"], resolutions: ["720p", "1080p", "4k"], voiceRequired: true },
    cost: { per: "second", usd: 0.1, defaultSec: 20 },
    price: { basis: "~$0.05–0.10 per second (HeyGen shows self-serve API rates only in its dashboard; upper end used)", confidence: "estimate", url: "https://app.heygen.com/developers/api?modal=pricing" },
    docs: "https://developers.heygen.com/reference/create-video", defaultRank: 1, listed: false,
  },

  // ---------------- Runway (optional) ----------------
  {
    id: "runway/gen4.5", provider: "runway", kind: "video", label: "Runway Gen-4.5", remoteId: "gen4.5",
    caps: { refs: 1, textToVideo: true, aspects: ["16:9", "9:16", "1:1", "4:5", "3:2", "2:3"], durations: [2, 10] },
    cost: { per: "second", usd: 0.12, defaultSec: 5 },
    price: { basis: "12 credits ($0.12) per second", confidence: "list", url: RW_PRICE },
    docs: "https://docs.dev.runwayml.com/api", defaultRank: 3, listed: false,
  },
  {
    id: "runway/gen4-turbo", provider: "runway", kind: "video", label: "Runway Gen-4 Turbo (image to video)", remoteId: "gen4_turbo",
    caps: { refs: 1, needsRef: true, aspects: ["16:9", "9:16", "1:1", "4:5", "3:2", "2:3"], durations: [2, 10] },
    cost: { per: "second", usd: 0.05, defaultSec: 5 },
    price: { basis: "5 credits ($0.05) per second", confidence: "list", url: RW_PRICE },
    docs: "https://docs.dev.runwayml.com/api", listed: false,
  },
  {
    id: "runway/aleph2", provider: "runway", kind: "video", label: "Runway Aleph 2 (video edit)", remoteId: "aleph2",
    caps: { refs: 1, edit: true, needsRef: true, maxInputSec: 30 },
    cost: { per: "second", usd: 0.28, defaultSec: 5 },
    price: { basis: "28 credits ($0.28) per second, 56 credits minimum", confidence: "list", url: RW_PRICE },
    docs: "https://docs.dev.runwayml.com/api", listed: false,
  },
  {
    id: "runway/gen4-image", provider: "runway", kind: "image", label: "Runway Gen-4 Image", remoteId: "gen4_image",
    caps: { refs: 3, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"], resolutions: ["720p", "1080p"] },
    cost: { per: "image", usd: 0.08, byResolution: { "720p": 0.05, "1080p": 0.08 } },
    price: { basis: "5 credits ($0.05) per 720p image, 8 ($0.08) per 1080p", confidence: "list", url: RW_PRICE },
    docs: "https://docs.dev.runwayml.com/api", defaultRank: 5, listed: false,
  },

  // ---------------- BytePlus ModelArk (optional) ----------------
  {
    id: "byteplus/seedance-1.5-pro", provider: "byteplus", kind: "video", label: "Seedance 1.5 Pro (ModelArk)", remoteId: "seedance-1-5-pro-251215",
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p"], durations: [4, 12], audio: true },
    cost: { per: "second", usd: 0.052, defaultSec: 5 },
    price: { basis: "$2.4 per 1M video tokens with audio (~$0.26 per 720p 5 s)", confidence: "estimate", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1520757", defaultRank: 4, listed: false,
  },
  {
    id: "byteplus/seedance-2.0", provider: "byteplus", kind: "video", label: "Seedance 2.0 (ModelArk)", remoteId: "dreamina-seedance-2-0-260128",
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p"], durations: [4, 15], audio: true, note: "Needs activation on ModelArk (balance over $30, a savings plan or a resource pack)." },
    cost: { per: "second", usd: 0.15, byResolution: { "720p": 0.15, "1080p": 0.37 }, defaultSec: 5 },
    price: { basis: "$7.0 per 1M video tokens (~$0.15 per second 720p, ~$0.37 1080p)", confidence: "estimate", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1520757", listed: false,
  },
  {
    id: "byteplus/seedance-2.0-fast", provider: "byteplus", kind: "video", label: "Seedance 2.0 Fast (ModelArk)", remoteId: "dreamina-seedance-2-0-fast-260128",
    caps: { refs: 2, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p"], durations: [4, 15], audio: true },
    cost: { per: "second", usd: 0.12, defaultSec: 5 },
    price: { basis: "$5.6 per 1M video tokens (~$0.12 per second 720p)", confidence: "estimate", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1520757", listed: false,
  },
  {
    id: "byteplus/seedream-4.5", provider: "byteplus", kind: "image", label: "Seedream 4.5 (ModelArk)", remoteId: "seedream-4-5-251128",
    caps: { refs: 10, edit: true, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.04 },
    price: { basis: "$0.04 per image", confidence: "list", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1541523", defaultRank: 4, listed: false,
  },
  {
    id: "byteplus/seedream-5-flash", provider: "byteplus", kind: "image", label: "Seedream 5.0 Flash (ModelArk)", remoteId: "dola-seedream-5-0-flash-260915",
    caps: { refs: 10, edit: true, aspects: ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] },
    cost: { per: "image", usd: 0.018 },
    price: { basis: "$0.018 per image", confidence: "list", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1541523", listed: false,
  },
  {
    id: "byteplus/seedream-5-lite", provider: "byteplus", kind: "image", label: "Seedream 5.0 Lite (ModelArk)", remoteId: "seedream-5-0-lite-260128",
    caps: { refs: 10, edit: true, note: "BytePlus' model list shows seedream-5-0-260128; the pricing page shows seedream-5-0-lite-260128." },
    cost: { per: "image", usd: 0.035 },
    price: { basis: "$0.035 per image", confidence: "list", url: BP_PRICE },
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1541523", unverified: true, listed: false,
  },
];

const today = () => new Date().toISOString().slice(0, 10);

export const MODELS: ModelEntry[] = ROWS.map((r) => {
  const e: ModelEntry = {
    ...r,
    price: { ...r.price, asOf: r.price.asOf ?? ASOF },
    priceHint: r.priceHint ?? `${r.price.basis} (${r.price.confidence === "list" ? "list price" : "estimate"}, ${r.price.asOf ?? ASOF})`,
    remoteIds() {
      return this.fal ? [this.fal.text, this.fal.image].filter((x): x is string => !!x) : [this.remoteId];
    },
  };
  if (r.shutdown && r.shutdown <= today()) e.retired = true;
  return e;
});

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.remoteId === id);
}

/** Duration for avatar / lip-sync models: from a local audio ref when there is one, else guessed from the script. */
function avatarSeconds(req: GenerateRequest): number | undefined {
  if (req.durationSec !== undefined) return req.durationSec;
  for (const ref of req.refs ?? []) {
    if (/^(https?:|data:)/.test(ref)) continue;
    try {
      const r = readLocalRef(ref);
      if (r.mime.startsWith("audio/") || r.mime.startsWith("video/")) {
        const d = sniff(r.bytes!).durationSec;
        if (d) return d;
      }
    } catch {
      // missing file: generate() will report it
    }
  }
  return req.text ? Math.round(speechSeconds(req.text)) : undefined;
}

export function estimateFor(model: ModelEntry, req: GenerateRequest): Estimate {
  const listed = model.price.confidence === "list";
  if (model.kind === "avatar" && (model.cost.per === "second" || model.cost.per === "minute")) {
    const sec = avatarSeconds(req);
    const e = priceEstimate(model.cost, { ...req, durationSec: sec }, model.price.basis, listed);
    return req.durationSec === undefined ? { ...e, low: e.low ?? Math.round(e.usd * 0.7 * 10000) / 10000, high: e.high ?? Math.round(e.usd * 1.4 * 10000) / 10000, confidence: "estimate" } : e;
  }
  const e = priceEstimate(model.cost, req, model.price.basis, listed);
  // Video length decided by the model, or a default length we had to assume, makes it an estimate.
  if ((model.cost.per === "second" || model.cost.per === "minute") && req.durationSec === undefined && e.confidence === "list")
    return { ...e, confidence: "estimate", basis: `${e.basis} (default length)` };
  return e;
}
