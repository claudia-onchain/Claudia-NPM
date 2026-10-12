<!-- site:skip -->
![@useclaudia/media: images, video, voice and music with your own keys](https://useclaudia.xyz/media/dev/banner-media.svg)

# @useclaudia/media

**Images, video, speech, music, sound effects and talking avatars for Claudia agents and apps, made with your own provider keys, priced before they run, and saved to a local library you own.**

[Docs](https://useclaudia.xyz/docs/developers/media) · [Changelog](https://useclaudia.xyz/docs/developers/changelog) · [All five packages](https://useclaudia.xyz/docs/developers) · [useclaudia.xyz](https://useclaudia.xyz)
<!-- /site:skip -->

One small API covers Google Gemini, OpenAI, fal.ai, ElevenLabs and HeyGen, with Runway and BytePlus ModelArk as options. Jobs go into a queue that survives restarts. Every job is priced before it runs, spend caps and approvals keep the bill in check, and each result is downloaded straight into a local library with a provenance record.

Claudia hosts no provider keys and never sees yours. Requests go straight from your machine to the provider, on your own account.

## Install

```sh
npm i @useclaudia/media
pnpm add @useclaudia/media
bun add @useclaudia/media
```

- **Runtime:** Node.js 18.17 or newer. ESM with types.
- **Dependencies:** none at runtime. It uses the global `fetch`, `node:crypto` and `node:fs`.
- **Storage:** everything stays on your machine under `~/.claudia/media`, or `$CLAUDIA_HOME/media`.
- **From the terminal:** the [`claudia` CLI](https://useclaudia.xyz/docs/developers/cli) wraps this package as `claudia generate` (`npm i -g @useclaudia/cli`; this package comes with it).

## 60-second quickstart

Get one key (for example a Google Gemini key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and put it in your environment:

```sh
export CLAUDIA_KEY_GOOGLE=…
```

```ts
import { createMedia, envKeys } from "@useclaudia/media";

const media = createMedia({
  keys: envKeys(),                                       // reads CLAUDIA_KEY_GOOGLE, CLAUDIA_KEY_OPENAI, …
  limits: { perJobUsd: 2, perDayUsd: 10, approveAboveUsd: 1 },
});

console.log(media.estimate({ kind: "image", prompt: "a disco ball on a trading desk", aspect: "1:1" }));
// → { usd: 0.0336, basis: "$0.0336 per 1K image, $0.0504 2K, $0.113 4K", confidence: "list" }

const job = await media.generate({ kind: "image", prompt: "a disco ball on a trading desk", aspect: "1:1" });
if ("dryRun" in job) throw new Error("unexpected dry run");
const done = await media.wait(job.id);
console.log(done.status, done.outputs[0]?.path, done.provenance.costUsd);
// → succeeded /Users/you/.claudia/media/library/2026-10/mj_7Qk…-1.png 0.0336

await media.close();
```

Want to see the request first, with no key and no spend? Every call can be a dry run. Here is the same thing from the CLI:

![claudia generate video --dry-run shows the model, the estimate, today's spend and the exact request with the key hidden](https://useclaudia.xyz/media/dev/media-generate.svg)

## What's new in 0.3

- **`launchCardPrompt({ name, symbol, chain?, launchpad?, idea? })`**: a ready prompt for a coin's launch card on Solana or Robinhood Chain (beta). The ticker is the only text; no prices, rising charts or promises.
- **Kling silent video is priced right.** With `meta: { audio: false }`, `fal/kling-2.6-pro` and `fal/kling-3-pro` estimate at the cheaper silent rate ($0.07/s and $0.112/s).
- **HeyGen photo avatars** without a voice now fail fast with `invalid` before any job is created (pass `voice`, an audio ref, or `meta.avatarId`). An audio ref must be a public http(s) URL; a local audio file fails with `invalid` at submit.
- Everything else is unchanged: code written for 0.2 keeps working.

Full list: [Changelog](https://useclaudia.xyz/docs/developers/changelog).

## Contents

[Providers and keys](#providers-and-keys) · [Models](#models) · [API reference](#api-reference) · [Requests](#requests) · [Spend limits](#spend-limits) · [Approvals](#approvals) · [Jobs and resume](#jobs-and-resume) · [Library and provenance](#library-and-provenance) · [Brand kits](#brand-kits) · [Dry runs](#dry-runs) · [Media for coins on each chain](#media-for-coins-on-each-chain) · [Errors](#errors) · [Rate limits](#rate-limits) · [Events](#events) · [Recipes](#recipes) · [Model reference](#model-reference) · [Export reference](#export-reference) · [Dates to know](#dates-to-know) · [Troubleshooting and FAQ](#troubleshooting-and-faq) · [Security](#security-notes)

## Providers and keys

Each provider needs its own API key, under the name below. Hosts pass keys in through a `KeyProvider` (`{ get(name) }`). If a key is missing there, the `CLAUDIA_KEY_<NAME>` environment variable is used instead.

| Provider | Key name (env var) | What it makes here | Get a key | Price hints (checked 2026-10-08) |
|---|---|---|---|---|
| **Google Gemini API** | `google` (`CLAUDIA_KEY_GOOGLE`) | images (Nano Banana), video (Gemini Omni Flash, Veo 3.1), music (Lyria), speech (Gemini TTS) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | image $0.034–0.24 · Veo $0.05–0.60/s · Omni ~$0.10/s · Lyria $0.04–0.08 per song |
| **OpenAI** | `openai` (`CLAUDIA_KEY_OPENAI`) | images (GPT Image: generate, edit with reference images, transparent background), speech | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | image ~$0.005–0.21 · TTS ~$0.015/min |
| **fal.ai** | `fal` (`CLAUDIA_KEY_FAL`) | video (Kling, Seedance, Hailuo, Wan), images (FLUX), avatars (OmniHuman), lip-sync | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) | video $0.05–0.68/s · FLUX $0.025–0.04 · OmniHuman $0.16/s |
| **ElevenLabs** | `elevenlabs` (`CLAUDIA_KEY_ELEVENLABS`) | speech (your voice id; without `voice`, ElevenLabs' example voice `JBFqnCBsd6RMkjVDRZzb`), sound effects, music | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) | $0.04–0.08 per 1K chars · SFX $0.12/min · music $0.15/min |
| **HeyGen** | `heygen` (`CLAUDIA_KEY_HEYGEN`) | talking-head avatar video (stock or custom avatar, or a photo) | [app.heygen.com → Settings → API](https://app.heygen.com/settings?nav=API) | ~$0.05–0.10/s (estimate; HeyGen shows API rates only in its dashboard) |
| Runway (optional) | `runway` (`CLAUDIA_KEY_RUNWAY`) | image-to-video, text-to-video, video edit (Aleph 2), images | [dev.runwayml.com](https://dev.runwayml.com/) | $0.05–0.28/s (1 credit = $0.01) |
| BytePlus ModelArk (optional) | `byteplus` (`CLAUDIA_KEY_BYTEPLUS`) | video (Seedance), images (Seedream) | [console.byteplus.com → ModelArk → API keys](https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey) | Seedance ~$0.05–0.37/s · Seedream $0.018–0.04 |

Prices move. Every model carries its own `price: { basis, confidence: "list" | "estimate", asOf, url }`:

- `"list"`: read off the provider's price page.
- `"estimate"`: worked out by us, for example from token rates, an assumed length or a third-party figure.

```ts
import { chainKeys, envKeys, staticKeys } from "@useclaudia/media";

const keys = chainKeys(myVault, envKeys());                 // the host's store first, then env vars
const forTests = staticKeys({ google: process.env.G_KEY }); // a fixed map, for scripts

console.log(await createMedia({ keys }).providers());
// → [{ id: "google", name: "Google Gemini", kinds: ["image", "video", "music", "speech"], configured: true, docs: "https://ai.google.dev/…" },
//    { id: "openai", name: "OpenAI", kinds: ["image", "speech"], configured: false, docs: "…" }, …]
```

`KEY_NAMES` lists every key name the package asks for.

## Models

`media.models({ kind, provider })` returns the model table, and `media.estimate(req)` prices a request without running it. If you leave out `model`, the default for that kind is used: defaults are tried in the order below, and the first provider whose key is set is picked. `estimate()` is synchronous, so without `model` it only knows the keys looked up so far and may price a different default than `generate()` would pick; pass `model` when the number matters.

| Kind | Defaults, in order | Also available |
|---|---|---|
| image | `google/nano-banana-2.1`, `openai/gpt-image-2.5-flare`, `fal/flux-2-pro`, `byteplus/seedream-4.5`, `runway/gen4-image` | `google/nano-banana-2`, `-lite`, `-pro`, `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2`, `openai/gpt-image-1.5`, `openai/gpt-image-1-mini`, `fal/flux-dev`, `fal/flux-kontext-pro`, `byteplus/seedream-5-flash`, `byteplus/seedream-5-lite` |
| video | `google/omni-flash`, `fal/kling-2.6-pro`, `runway/gen4.5`, `byteplus/seedance-1.5-pro` | `google/veo-3.1`, `-fast`, `-lite` (until 2026-10-22), `fal/kling-3-pro`, `fal/kling-2.5-turbo-pro`, `fal/seedance-2.0`, `fal/seedance-1.5-pro`, `fal/hailuo-2.3`, `fal/wan-2.6`, `runway/gen4-turbo`, `runway/aleph2` (edit), `byteplus/seedance-2.0`, `-fast` |
| speech | `elevenlabs/multilingual-v2`, `google/gemini-3.8-flash-tts`, `openai/gpt-4o-mini-tts` | `elevenlabs/v3`, `elevenlabs/flash-v2.5`, `google/gemini-3.8-flash-lite-tts`, `openai/tts-1-hd` |
| music | `google/lyria-3.5`, `elevenlabs/music-v1` | `google/lyria-3-clip`, `elevenlabs/music-v2.5` |
| sfx | `elevenlabs/sfx-v2` | |
| avatar | `heygen/avatar-iv`, `fal/omnihuman-1.5` | `fal/lipsync-2`, `fal/veed-lipsync` |

```ts
for (const m of media.models({ kind: "video", provider: "fal" }).slice(0, 2)) console.log(m.id, "·", m.price?.basis);
// → fal/kling-2.6-pro · $0.14 per second with audio ($0.07 without)
//   fal/kling-3-pro · $0.168 per second with audio ($0.112 without)
```

How the model table works:

- **One table.** Model ids, provider endpoint ids, field names and prices live in `MODEL_TABLE` (exported). Connector code doesn't hard-code them. `findModel(id)` looks one up.
- **Retired models.** A model whose `shutdown` date has passed is flagged `retired: true`, and `generate()` refuses it; the error's hint names the replacement. Already retired: `google/imagen-4` (2026-08-17) and `google/gemini-2.5-flash-image`. Retiring soon: the three Veo 3.1 previews on 2026-10-22, GPT Image 1.5 and 1 Mini on 2026-12-01, OpenAI TTS on 2027-01-06.
- **Unconfirmed ids.** `unverified: true` marks a provider id we could not confirm in the docs (today only `byteplus/seedream-5-lite`).
- **`checkModels()`** asks each provider's model list endpoint which ids still exist and reports the ones that are gone.

```ts
await media.checkModels();                 // [{ provider: "google", checked: true, missing: [], retired: ["google/imagen-4"] }, …]
await media.checkModels({ dryRun: true }); // only shows the requests it would send
```

Google, OpenAI, fal and ElevenLabs have list endpoints. HeyGen, Runway and BytePlus don't, so they report `checked: false`. OpenAI never makes video here: the Sora / Videos API shut down on 2026-09-24.

## API reference

```ts
import { createMedia } from "@useclaudia/media";
const media = createMedia(options);
```

| Option | Default | What it does |
|---|---|---|
| `keys` | required | A `KeyProvider` (`{ get(name) }`); `envKeys()` is the built-in fallback |
| `dataDir` | `$CLAUDIA_HOME` or `~/.claudia` | Files live in `<dataDir>/media` |
| `limits` | none | Spend caps and the approval threshold ([Spend limits](#spend-limits)) |
| `dryRun` | `false` | Every call returns the request it would send |
| `fetch` | global `fetch` | Point the whole package at a mock or a proxy |
| `concurrency` | 2 per provider (HeyGen and Runway 1) | Jobs running at once per provider |
| `poll` | `{ minMs: 5000, maxMs: 15000 }` | Poll timing, backoff ×1.5 |
| `defaultBrand` | `true` | Seed the `claudia` brand kit on first run |

| Method | Returns | Example → result |
|---|---|---|
| `providers()` | `ProviderSummary[]` | `configured: true` for each key that is set |
| `models({ kind?, provider? })` | `ModelInfo[]` | `media.models({ kind: "music" }).map((m) => m.id)` → `["google/lyria-3.5", …]` |
| `estimate(req)` | `Estimate` (`usd`, `low?`, `high?`, `basis`, `confidence`) | `media.estimate({ kind: "video", model: "fal/kling-2.6-pro", durationSec: 5, prompt })` → `{ usd: 0.7, confidence: "list", … }` |
| `generate(req, { dryRun?, approve? })` | `Job` (queued or `needs_approval`) or `DryRun` | Returns at once; the queue does the rest |
| `wait(id, { timeoutMs? })` | `Job` | Resolves when done, failed or waiting for approval; on timeout, the job as it is |
| `getJob(id)` · `listJobs({ status?, limit? })` | `Job` / `Job[]` | `media.listJobs({ status: "running" })` |
| `approve(id)` · `cancel(id)` | `Job` | Approve re-checks the caps first |
| `spend()` | `SpendSummary` | `{ today: 1.23, month: 8.4, byProvider: { google: { today: 0.8, month: 5 } } }` |
| `brands.list()` · `brands.get(id)` · `brands.save(brand)` | `Brand` | [Brand kits](#brand-kits) |
| `checkModels({ provider?, dryRun? })` | `CheckModelsResult[]` | [Models](#models) |
| `on("job", cb)` · `off("job", cb)` | — | Every status or progress change |
| `close()` | — | Stop polling; running jobs resume next time |

Also exported: `launchCardPrompt`, `ClaudiaMediaError`, `isMediaError`, `envKeys`, `chainKeys`, `staticKeys`, `KEY_NAMES`, `DEFAULT_BRAND`, `MODEL_TABLE`, `findModel`, `CONNECTORS`, `createTransport`, `redactRequest`, `sniff`, `pcmToWav`, and the types (`GenerateRequest`, `Job`, `JobStatus`, `MediaOutput`, `Estimate`, `Brand`, `SpendLimits`, …).

## Requests

```ts
interface GenerateRequest {
  kind: "image" | "video" | "speech" | "music" | "sfx" | "avatar";
  model?: string;              // "google/veo-3.1-fast"; default per kind
  prompt?: string; negativePrompt?: string;
  text?: string;               // speech: what to say; avatar: the script
  voice?: string;              // provider voice id / name
  refs?: string[];             // local paths, http(s) URLs or data: URIs
  aspect?: "1:1" | "16:9" | "9:16" | "4:5" | "3:2" | "2:3";
  resolution?: string;         // "1K" | "2K" | "4K" (images), "720p" | "1080p" | "4k" (video), or "WxH" (OpenAI)
  durationSec?: number; n?: number; seed?: number;
  brand?: string;              // brand-kit id, e.g. "claudia"
  meta?: Record<string, unknown>;
}
```

A video (seconds to minutes, so give `wait` a timeout or listen for events):

```ts
const v = await media.generate({ kind: "video", model: "google/veo-3.1-fast", prompt: "a coin spins on a mirror, slow dolly-in", aspect: "9:16", durationSec: 8 });
if (!("dryRun" in v)) {
  const out = await media.wait(v.id, { timeoutMs: 10 * 60_000 });
  console.log(out.status, out.outputs[0]);
  // → succeeded { path: "…/mj_…-1.mp4", mime: "video/mp4", bytes: 4194304, width: 720, height: 1280, durationSec: 8, sha256: "…" }
}
```

Speech:

```ts
const s = await media.generate({ kind: "speech", model: "elevenlabs/flash-v2.5", text: "gm. Here are today's top movers.", voice: "<your ElevenLabs voice id>" });
```

**Refs.** Local files are read and sent the way each provider wants them: inline base64 for Google; a data URI for OpenAI, fal, Runway and BytePlus; a base64 image for HeyGen. http(s) URLs and `data:` URIs are passed through, or downloaded (or decoded) first when the provider only takes bytes (Google). What a ref does depends on the model:

- Image models treat refs as references or images to edit.
- Video models treat them as the first and last frame. Veo: set `meta.refMode = "reference"` to use up to three as asset references instead.
- Video-edit models (Aleph 2) take the source video.
- OmniHuman takes `[face image, audio]`; lip-sync takes `[video, audio]`.
- HeyGen takes a face photo, or `meta.avatarId` set to a look id from `GET /v3/avatars/looks`.

**`meta` keys this package understands:**

| Key | Applies to | What it does |
|---|---|---|
| `quality` | OpenAI images | `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"` |
| `background` | OpenAI images | `"transparent"` gives a transparent background |
| `moderation` | OpenAI images | Passed as OpenAI's `moderation` setting (`"auto"` or `"low"`) |
| `format` | OpenAI images, Lyria 3.5 | `"png"`, `"jpeg"` or `"webp"` for OpenAI; `"wav"` for Lyria 3.5 |
| `style` | Gemini TTS, OpenAI `gpt-4o-mini-tts` | Speaking style instructions |
| `voiceSettings` | ElevenLabs speech | Voice settings object |
| `promptInfluence`, `loop` | ElevenLabs SFX | How closely to follow the prompt; whether the sound loops |
| `instrumental` | ElevenLabs music | No vocals |
| `audio` | fal, BytePlus video | `false` turns off generated audio |
| `avatarId`, `title` | HeyGen | Avatar look id; video title |
| `refMode` | Veo | `"reference"` uses refs as asset references |
| `providerOptions` | All providers | Merged as-is into the provider's request body, for any field we don't model |

## Spend limits

```ts
createMedia({
  keys,
  limits: {
    perJobUsd: 2,          // refuse any single job estimated above $2
    perDayUsd: 10,         // UTC day
    perMonthUsd: 100,      // UTC month
    approveAboveUsd: 0.5,  // jobs above $0.50 wait for approve(id)
    perProvider: { google: { perDayUsd: 5 }, fal: { perJobUsd: 1 } }, // the stricter of global and provider wins
  },
});
```

- Every job is estimated before it is accepted.
- The day and month caps count money already spent, money reserved by queued jobs, and the new job together.
- A job that would go over a cap is refused with `ClaudiaMediaError("over_budget")`; the hint says which cap.

**The ledger** (`<dataDir>/media/spend.jsonl`, append-only): a job's estimate is reserved when it is submitted; on success the entry is settled at the final cost (exact when the provider reports it: OpenAI image token usage, Runway task credits; otherwise the estimate); it is voided when a job fails or is blocked; a job canceled while running keeps its reservation, because the provider may still bill work it started.

## Approvals

If a job's estimate is above `approveAboveUsd`, it is created with status `needs_approval` and nothing is sent. A person (or a policy in your host) decides:

```ts
const j = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 10 }); // ~$1.40
console.log(j.status);       // "needs_approval"
await media.approve(j.id);   // re-checks the caps, then queues it
await media.cancel(j.id);    // or drop it
await media.generate(req, { approve: true }); // pre-approved (still subject to the caps)
```

`wait()` also resolves when a job reaches `needs_approval`, so a script never hangs on a job nobody approved. For agents, keep `approveAboveUsd` set: an agent should never approve its own jobs.

## Jobs and resume

| Status | Meaning |
|---|---|
| `needs_approval` | Waiting for `approve(id)` |
| `queued` | Accepted and waiting for a free provider slot (or retrying after a 429) |
| `running` | Submitted to the provider and being polled |
| `downloading` | Saving outputs to the library |
| `succeeded` | Outputs are on disk |
| `failed` | Something went wrong: see `job.error.code`, `message` and `hint` |
| `blocked` | A provider safety filter or a brand-kit rule refused it |
| `expired` | The provider deleted the result before it could be downloaded |
| `canceled` | You canceled it |

- `generate()` returns straight away. A scheduler in the instance submits, polls and downloads.
- **Polling** starts at 5 s and backs off ×1.5 up to 15 s.
- **429s** honour `Retry-After`. A 429 or 5xx on submit puts the job back in the queue; a network error on submit fails the job, so you don't pay twice.
- **Persistence.** Jobs are written atomically to `<dataDir>/media/jobs.json`, with the provider's operation id, so after a restart polling picks up where it stopped without resubmitting.
- **Crash during submit.** That job is marked failed with a hint to check the provider dashboard: we can't know whether the provider accepted it, and failing is cheaper than paying twice.
- **Two processes, one data dir.** A per-job lease stops the CLI and Claudia Local polling the same job.

```ts
media.getJob(id);
media.listJobs({ status: "running", limit: 20 });
await media.cancel(id); // also asks the provider to cancel where it can (fal, Runway, BytePlus, Gemini Omni)
```

## Library and provenance

Outputs are downloaded as soon as the provider is done. This matters: Google deletes Veo videos after 2 days, and fal, Runway, HeyGen and BytePlus links expire too.

```
<dataDir>/media/library/2026-10/mj_…-1.mp4
<dataDir>/media/library/2026-10/mj_…-1.mp4.json   ← { jobId, output, provenance }
```

Each `MediaOutput` has `path`, `mime`, `bytes` and `sha256`; and, when they can be read cheaply from the file header, `width`/`height` (PNG, JPEG, WebP, GIF, MP4/MOV) and `durationSec` (WAV, MP4, constant-bitrate MP3).

`job.provenance`: `prompt` (the final prompt, brand style included), `model`, `provider`, `costUsd`, `watermark` ("SynthID" for Google outputs, "C2PA" for OpenAI images), `terms` (the provider's terms URL) and `at`. Keep the sidecar next to the file if you post it: the disclosure rules in `@useclaudia/social` use it.

## Brand kits

```ts
media.brands.save({
  id: "my-coin",
  name: "My Coin",
  refs: ["/path/to/mascot.png"],                              // used when a request has no refs
  voice: { provider: "elevenlabs", voiceId: "<voice id>" },   // used for speech / avatar on that provider
  style: "neon, playful, bold outlines",                      // appended to image / video / avatar prompts
  banned: ["guaranteed", "100x"],                             // prompts containing these are refused (blocked)
});
await media.generate({ kind: "image", prompt: "mascot on a rocket", brand: "my-coin" });
```

Kits are stored in `<dataDir>/media/brands.json`. A default `claudia` kit is seeded the first time. It describes her look: an adult woman in her late twenties with a black bob, one peach-orange streak in the bangs, a peach star clip and a thin headset mic, with a rose accent. Its reference images start empty; add your own approved images with `brands.save({ ...media.brands.get("claudia")!, refs: [...] })`. Pass `defaultBrand: false` to skip seeding it.

## Dry runs

All HTTP goes through one transport. With `dryRun` it returns the exact request instead of sending it, with secret headers and query keys shown as `"***"`:

```ts
const r = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 5 }, { dryRun: true });
// { dryRun: true,
//   request: { method: "POST", url: "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/text-to-video",
//              headers: { Authorization: "***", "Content-Type": "application/json" },
//              body: { prompt: "…", duration: "5" } },
//   estimate: { usd: 0.7, basis: "$0.14 per second with audio ($0.07 without) × 5s", confidence: "list" } }
```

`createMedia({ dryRun: true })` makes every call dry. A dry run needs no key, creates no job and spends nothing.

The source repository has `packages/media/scripts/dry-run.mjs` (not shipped in the npm package). It needs no keys and no network: it prints the dry-run request for every model and checks that no key ever appears, then runs real jobs against a mock `fetch` (submit → poll with a 429 → download → library and sidecar → spend ledger → restart mid-job → resume without resubmitting), exercising approvals, caps, cancel, brand kits and missing keys.

```sh
npm run build -w @useclaudia/media && node packages/media/scripts/dry-run.mjs   # add --full to print every body
```

## Media for coins on each chain

Media itself doesn't touch a chain: it makes files on your machine. What changes per chain is the launch card's wording and where the art goes next. `launchCardPrompt` writes the prompt; the image becomes a coin's `imageUri` (through `uploadImage` in [@useclaudia/sdk](https://useclaudia.xyz/docs/developers/sdk)), and clips go to your socials through [@useclaudia/social](https://useclaudia.xyz/docs/developers/social).

<!-- chains -->
#### Solana

```ts
import { readFile } from "node:fs/promises";
import { launchCardPrompt } from "@useclaudia/media";
import { ClaudiaHome } from "@useclaudia/sdk/node";

const prompt = launchCardPrompt({ name: "Disco Ball", symbol: "DISCO", idea: "a peach disco ball, studio light" });
// → "Launch announcement card for the coin Disco Ball ($DISCO) on Solana. Theme: a peach disco ball, studio light.
//    Bold, clean composition with the ticker $DISCO as the only text; no prices, charts going up, or promises."
const art = await media.wait((await media.generate({ kind: "image", prompt, aspect: "1:1" }) as { id: string }).id);
const agent = await new ClaudiaHome().client();
const { uri } = await agent.uploadImage(await readFile(art.outputs[0].path), "coin.png");
const planned = await agent.launchPlan({ name: "Disco Ball", symbol: "DISCO", imageUri: uri, devBuyNative: 0 });
// → planned.plan.split: 70% creator / 30% platform, pump.fun fee sharing
```

pump.fun takes PNG, JPEG, GIF or WebP up to 4 MB. Square art reads best on the board.

#### Robinhood Chain (beta)

```ts
import { ClaudiaClient } from "@useclaudia/sdk";
import { ClaudiaEvm } from "@useclaudia/sdk/evm";

const prompt = launchCardPrompt({ name: "Disco Ball", symbol: "DISCO", chain: "hood", launchpad: "pons" });
// → "Launch announcement card for the coin Disco Ball ($DISCO) on Robinhood Chain (Pons V2). Bold, clean composition …"
const art = await media.wait((await media.generate({ kind: "image", prompt, aspect: "1:1" }) as { id: string }).id);
const client = new ClaudiaClient();
const { uri } = await client.uploadImage(await readFile(art.outputs[0].path), "coin.png");
const evm = new ClaudiaEvm(client, { privateKey: process.env.EVM_KEY! });
const planned = await evm.planLaunch({ launchpad: "pons", name: "Disco Ball", symbol: "DISCO", imageUri: uri, devBuyNative: 0.001 });
```

Same image rules. The launch page and the coin page on Claudia show it the same way on both chains.

#### BNB Chain (coming soon)

Nothing to launch on yet, and `launchCardPrompt` only knows `sol` and `hood`. When BNB Chain opens, the same art and the same upload will work.
<!-- /chains -->

## Errors

Everything thrown on purpose is a `ClaudiaMediaError` with `code`, `message`, `hint` and, for rate limits, `retryAfterMs`:

```ts
import { ClaudiaMediaError } from "@useclaudia/media";
try {
  await media.generate(req);
} catch (e) {
  if (e instanceof ClaudiaMediaError) console.log(e.code, e.message, e.hint);
}
// → no_key No fal.ai key set Add your fal.ai API key as "fal" (Claudia Local → Settings → Keys, `claudia keys set fal`, or the CLAUDIA_KEY_FAL environment variable). Get one at …
```

| `code` | When | What to do |
|---|---|---|
| `no_key` | No key for that provider | The hint says where to add it and where to get one |
| `rate_limited` | The provider sent `429`; `retryAfterMs` is set | Inside the queue this is retried for you |
| `over_budget` | A cap would be exceeded, or the provider says the account is out of credit (`402`) | Raise the cap, pick a cheaper model, or top up |
| `needs_approval` | Reserved for hosts that turn approvals into errors | The queue itself uses the `needs_approval` status |
| `provider_error` | The provider failed, or refused the key (`401`/`403`) | Retried where safe; check the key |
| `unsupported` | A retired model, or a kind the provider doesn't make | The hint names the replacement |
| `expired` | The provider no longer has the result (`404`/`410`) | Run the job again |
| `blocked` | A safety filter, or a brand kit's `banned` list | Change the prompt |
| `invalid` | Bad input: unknown model, missing refs, a missing file, a HeyGen photo avatar without a voice, or a `400`/`422` from the provider | Fix the request |

Failed jobs carry the same `{ code, message, hint }` in `job.error`.

## Rate limits

- **Provider limits apply, on your account.** A `429` is retried with the provider's `Retry-After`; you never pay twice for a resubmit.
- **Concurrency** defaults to 2 jobs per provider (1 for HeyGen and Runway): `concurrency: { google: 1, fal: 4 }`.
- **Your own caps** are the real limiter: `perJobUsd`, `perDayUsd`, `perMonthUsd`, `perProvider`.
- **The MCP server** (local mode) adds a daily media ceiling, `CLAUDIA_MCP_MEDIA_PER_DAY_USD` (default $5).

## Events

```ts
const onJob = (job) => ui.update(job);
media.on("job", onJob);   // every status / progress change
media.off("job", onJob);
```

## Recipes

### Launch a coin with your own art

Make the image here, then launch with the SDK (see [Media for coins on each chain](#media-for-coins-on-each-chain)). From the terminal it's two commands:

```sh
claudia generate image "a peach disco ball, studio light" --aspect 1:1
claudia launch --name "Disco Ball" --symbol DISCO --image ~/.claudia/media/library/2026-10/mj_…-1.png --dry-run
```

### Run an agent that makes clips on a budget

```ts
const media = createMedia({ keys: envKeys(), limits: { perJobUsd: 1, perDayUsd: 5, approveAboveUsd: 0.25 } });
media.on("job", (j) => j.status === "needs_approval" && notifyAHuman(j));
```

The agent can start jobs all day; anything above 25 cents waits for a person, and nothing goes past $5 a day.

### Post as your agent, with media

```ts
import { createSocial, envKeys as socialKeys } from "@useclaudia/social";

const clip = await media.wait(jobId);
const social = createSocial({ keys: socialKeys() });
const post = social.draft({ text: "New on the board today.", media: [{ path: clip.outputs[0].path }], targets: [{ account }] });
social.submit(post.id); // a person approves, then social.publish(post.id)
```

`@useclaudia/social` reads the provenance sidecar and adds the AI label each network needs.

### Connect Claude or Cursor (MCP)

```sh
claude mcp add --transport stdio claudia-local -- npx -y @useclaudia/mcp --server all
```

The local MCP server exposes `generate_media`, `get_media_job` and `list_media` with your keys. The assistant can start jobs; it can't approve a paid job. See [@useclaudia/mcp](https://useclaudia.xyz/docs/developers/mcp).

## Model reference

Every model in `MODEL_TABLE`, generated from the package. Prices are the provider's list price or our estimate (`confidence`), as of the date shown; check the provider before you rely on them.

### Image

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `google/nano-banana-2.1` | Nano Banana 2.1 | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 1K, 2K, 4K · 14 refs · edit | $0.0336 per 1K image, $0.0504 2K, $0.113 4K (list, 2026-10-08) | watermark SynthID |
| `google/nano-banana-2` | Nano Banana 2 | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 512, 1K, 2K, 4K · 14 refs · edit | $0.067 per 1K image ($0.045 512px, $0.101 2K, $0.151 4K) (list, 2026-10-08) | watermark SynthID |
| `google/nano-banana-lite` | Nano Banana Lite | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 1K · 14 refs · edit | $0.0336 per image (1K only) (list, 2026-10-08) | watermark SynthID |
| `google/nano-banana-pro` | Nano Banana Pro | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 1K, 2K, 4K · 14 refs · edit | $0.134 per 1K/2K image, $0.24 4K (list, 2026-10-08) | watermark SynthID |
| `google/gemini-2.5-flash-image` | Nano Banana (Gemini 2.5 Flash Image) | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 3 refs | $0.039 per image (list, 2026-10-08) | shuts down 2026-10-02 → `google/nano-banana-2.1`; watermark SynthID |
| `google/imagen-4` | Imagen 4 | — | retired (list, 2026-10-08) | shuts down 2026-08-17 → `google/nano-banana-2.1`; watermark SynthID |
| `openai/gpt-image-2.5-flare` | GPT Image 2.5 Flare | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 16 refs · transparent · edit | ~$0.013 per 1024² medium image ($0.006 low, $0.053 high); $30 per 1M output tokens, from OpenAI's calculator (estimate, 2026-10-08) | watermark C2PA |
| `openai/gpt-image-2.5-sunburst` | GPT Image 2.5 Sunburst | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 16 refs · transparent · edit | ~$0.013 per 1024² medium image; $30 per 1M output tokens, from OpenAI's calculator (estimate, 2026-10-08) | watermark C2PA |
| `openai/gpt-image-2` | GPT Image 2 | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 16 refs · transparent · edit | $0.053 per 1024² medium image ($0.006 low, $0.211 high) (list, 2026-10-08) | watermark C2PA |
| `openai/gpt-image-1.5` | GPT Image 1.5 | aspects 1:1, 3:2, 2:3 · 16 refs · transparent · edit | $0.034 per 1024² medium image ($0.009 low, $0.133 high) (list, 2026-10-08) | shuts down 2026-12-01 → `openai/gpt-image-2.5-flare`; watermark C2PA |
| `openai/gpt-image-1-mini` | GPT Image 1 Mini | aspects 1:1, 3:2, 2:3 · 16 refs · transparent · edit | $0.011 per 1024² medium image ($0.005 low, $0.036 high) (list, 2026-10-08) | shuts down 2026-12-01 → `openai/gpt-image-2.5-flare`; watermark C2PA |
| `fal/flux-2-pro` | FLUX.2 Pro | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 4 refs · edit | $0.03 for the first megapixel, $0.015 per extra megapixel (list, 2026-10-08) | — |
| `fal/flux-dev` | FLUX.1 dev | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 | $0.025 per megapixel (list, 2026-10-08) | — |
| `fal/flux-kontext-pro` | FLUX.1 Kontext Pro (edit) | 1 ref · edit | $0.04 per image (list, 2026-10-08) | — |
| `runway/gen4-image` | Runway Gen-4 Image | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 720p, 1080p · 3 refs | 5 credits ($0.05) per 720p image, 8 ($0.08) per 1080p (list, 2026-10-08) | — |
| `byteplus/seedream-4.5` | Seedream 4.5 (ModelArk) | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 10 refs · edit | $0.04 per image (list, 2026-10-08) | — |
| `byteplus/seedream-5-flash` | Seedream 5.0 Flash (ModelArk) | aspects 1:1, 16:9, 9:16, 4:5, 3:2, 2:3 · 10 refs · edit | $0.018 per image (list, 2026-10-08) | — |
| `byteplus/seedream-5-lite` | Seedream 5.0 Lite (ModelArk) | 10 refs · edit | $0.035 per image (list, 2026-10-08) | id unconfirmed |

### Video

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `google/omni-flash` | Gemini Omni Flash | aspects 16:9, 9:16 · 360p, 720p, 1080p, 4k · 3 refs · audio | ~$0.10 per second at 720p ($17.50 per 1M output tokens, 5,792 tokens/s); length set by the model, 8 s assumed (estimate, 2026-10-08) | watermark SynthID |
| `google/veo-3.1` | Veo 3.1 | aspects 16:9, 9:16 · 4–6–8 s · 720p, 1080p, 4k · 3 refs · audio | $0.40 per second (720p/1080p), $0.60 4K, audio included, billed only on success (list, 2026-10-08) | shuts down 2026-10-22 → `google/omni-flash`; watermark SynthID |
| `google/veo-3.1-fast` | Veo 3.1 Fast | aspects 16:9, 9:16 · 4–6–8 s · 720p, 1080p, 4k · 3 refs · audio | $0.10 per second 720p, $0.12 1080p, $0.30 4K, audio included (list, 2026-10-08) | shuts down 2026-10-22 → `google/omni-flash`; watermark SynthID |
| `google/veo-3.1-lite` | Veo 3.1 Lite | aspects 16:9, 9:16 · 4–6–8 s · 720p, 1080p · 2 refs · audio | $0.05 per second 720p, $0.08 1080p, audio included (list, 2026-10-08) | shuts down 2026-10-22 → `google/omni-flash`; watermark SynthID |
| `fal/kling-2.6-pro` | Kling 2.6 Pro | aspects 16:9, 9:16, 1:1 · 5–10 s · 2 refs · audio | $0.14 per second with audio ($0.07 without) (list, 2026-10-08) | — |
| `fal/kling-3-pro` | Kling 3 Pro | aspects 16:9, 9:16, 1:1 · 3–15 s · 2 refs · audio | $0.168 per second with audio ($0.112 without) (list, 2026-10-08) | — |
| `fal/kling-2.5-turbo-pro` | Kling 2.5 Turbo Pro | aspects 16:9, 9:16, 1:1 · 5–10 s · 2 refs | $0.35 for 5 s + $0.07 per extra second (list, 2026-10-08) | — |
| `fal/seedance-2.0` | Seedance 2.0 | aspects 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 · 4–15 s · 480p, 720p, 1080p, 4k · 2 refs · audio | $0.3034 per second 720p, $0.682 1080p (list, 2026-10-08) | — |
| `fal/seedance-1.5-pro` | Seedance 1.5 Pro | aspects 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 · 4–12 s · 480p, 720p, 1080p · 2 refs · audio | ~$0.26 per 720p 5 s video with audio ($2.4 per 1M video tokens) (estimate, 2026-10-08) | — |
| `fal/hailuo-2.3` | MiniMax Hailuo 2.3 | 6–10 s · 1 ref | $0.28 per 6 s, $0.56 per 10 s (list, 2026-10-08) | — |
| `fal/wan-2.6` | Wan 2.6 | aspects 16:9, 9:16, 1:1 · 5–10–15 s · 720p, 1080p · 1 ref | $0.10 per second 720p, $0.15 1080p (list, 2026-10-08) | — |
| `runway/gen4.5` | Runway Gen-4.5 | aspects 16:9, 9:16, 1:1, 4:5, 3:2, 2:3 · 2–10 s · 1 ref | 12 credits ($0.12) per second (list, 2026-10-08) | — |
| `runway/gen4-turbo` | Runway Gen-4 Turbo (image to video) | aspects 16:9, 9:16, 1:1, 4:5, 3:2, 2:3 · 2–10 s · 1 ref | 5 credits ($0.05) per second (list, 2026-10-08) | — |
| `runway/aleph2` | Runway Aleph 2 (video edit) | 1 ref · edit | 28 credits ($0.28) per second, 56 credits minimum (list, 2026-10-08) | — |
| `byteplus/seedance-1.5-pro` | Seedance 1.5 Pro (ModelArk) | aspects 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 · 4–12 s · 480p, 720p, 1080p · 2 refs · audio | $2.4 per 1M video tokens with audio (~$0.26 per 720p 5 s) (estimate, 2026-10-08) | — |
| `byteplus/seedance-2.0` | Seedance 2.0 (ModelArk) | aspects 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 · 4–15 s · 480p, 720p, 1080p · 2 refs · audio | $7.0 per 1M video tokens (~$0.15 per second 720p, ~$0.37 1080p) (estimate, 2026-10-08) | — |
| `byteplus/seedance-2.0-fast` | Seedance 2.0 Fast (ModelArk) | aspects 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 · 4–15 s · 480p, 720p, 1080p · 2 refs · audio | $5.6 per 1M video tokens (~$0.12 per second 720p) (estimate, 2026-10-08) | — |

### Speech

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` | Gemini 3.8 Flash TTS | — | $0.50 per 1M input tokens + $9.00 per 1M audio tokens (25 tokens/s) until 2026-12-31, then $1.00 / $18.00 (list, 2026-10-08) | watermark SynthID |
| `google/gemini-3.8-flash-lite-tts` | Gemini 3.8 Flash-Lite TTS | — | $0.50 per 1M input tokens + $6.00 per 1M audio tokens until 2026-12-31, then $1.00 / $12.00 (list, 2026-10-08) | watermark SynthID |
| `openai/gpt-4o-mini-tts` | GPT-4o mini TTS | — | $0.60 per 1M text tokens + $12 per 1M audio tokens (~$0.015 per minute) (estimate, 2026-10-08) | shuts down 2027-01-06 |
| `openai/tts-1-hd` | TTS-1 HD | — | $30 per 1M characters (list, 2026-10-08) | shuts down 2027-01-06 |
| `elevenlabs/multilingual-v2` | Eleven Multilingual v2 | — | $0.08 per 1,000 characters (list, 2026-10-08) | — |
| `elevenlabs/v3` | Eleven v3 | — | $0.08 per 1,000 characters (list, 2026-10-08) | — |
| `elevenlabs/flash-v2.5` | Eleven Flash v2.5 | — | $0.04 per 1,000 characters (list, 2026-10-08) | — |

### Music

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `google/lyria-3.5` | Lyria 3.5 | 1 ref | $0.08 per song (list, 2026-10-08) | watermark SynthID |
| `google/lyria-3-clip` | Lyria 3 Clip | 30 s · 1 ref | $0.04 per 30-second clip (list, 2026-10-08) | watermark SynthID |
| `elevenlabs/music-v1` | Eleven Music v1 | — | $0.15 per minute of music (list, 2026-10-08) | — |
| `elevenlabs/music-v2.5` | Eleven Music v2.5 | — | $0.15 per minute of music (list, 2026-10-08) | — |

### Sfx

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `elevenlabs/sfx-v2` | Eleven Sound Effects v2 | — | $0.12 per minute of sound (billed per generation; 10 s assumed when no duration is given) (estimate, 2026-10-08) | — |

### Avatar

| Model | Label | What it takes | Price | Notes |
|---|---|---|---|---|
| `fal/omnihuman-1.5` | OmniHuman 1.5 (photo + audio) | 720p, 1080p · 2 refs | $0.16 per second of output (list, 2026-10-08) | — |
| `fal/lipsync-2` | Sync Lipsync 2 (video + audio) | 2 refs | $3.00 per minute (list, 2026-10-08) | — |
| `fal/veed-lipsync` | VEED Lipsync (video + audio) | 2 refs | $0.40 per minute (list, 2026-10-08) | — |
| `heygen/avatar-iv` | HeyGen Avatar IV | aspects 16:9, 9:16, 4:5, 1:1 · 720p, 1080p, 4k · 2 refs | ~$0.05–0.10 per second (HeyGen shows self-serve API rates only in its dashboard; upper end used) (estimate, 2026-10-08) | — |


## Export reference

Every export, with a short example and what it returns. `media` is an instance from `createMedia`. Amounts and ids in the samples are illustrative.

### `createMedia(options)` → `Media`

```ts
const media = createMedia({ keys: envKeys(), limits: { perDayUsd: 10, approveAboveUsd: 1 }, dataDir: "/srv/agent" });
// → a Media instance; it starts polling any jobs it finds in /srv/agent/media/jobs.json
```

### `media.providers()` → `Promise<ProviderSummary[]>`

```ts
(await media.providers()).filter((p) => p.configured).map((p) => p.id);
// → ["google", "fal"]
```

### `media.models(filter?)` → `ModelInfo[]`

```ts
media.models({ kind: "speech" }).map((m) => `${m.id}${m.retired ? " (retired)" : ""}`);
// → ["elevenlabs/multilingual-v2", "google/gemini-3.8-flash-tts", "openai/gpt-4o-mini-tts", "elevenlabs/v3", …]
```

### `media.estimate(request)` → `Estimate`

```ts
media.estimate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 10, meta: { audio: false } });
// → { usd: 0.7, basis: "$0.14 per second with audio ($0.07 without) (without audio) × 10s", confidence: "list" }
```

### `media.generate(request, { dryRun?, approve? })` → `Promise<Job | DryRun>`

```ts
const job = await media.generate({ kind: "music", prompt: "lofi beat for a launch clip", durationSec: 30 });
// → { id: "mj_…", status: "queued", model: "google/lyria-3.5", provider: "google", estimate: { usd: 0.08, … }, outputs: [], … }
```

### `media.wait(id, { timeoutMs? })` → `Promise<Job>`

```ts
const done = await media.wait(job.id, { timeoutMs: 120_000 });
// → { status: "succeeded", outputs: [{ path: "…/mj_…-1.mp3", mime: "audio/mpeg", bytes: 482113, durationSec: 30, sha256: "…" }], … }
```

### `media.getJob(id)` · `media.listJobs({ status?, limit? })`

```ts
media.getJob("mj_…")?.status;                                      // → "running"
media.listJobs({ status: "needs_approval" }).map((j) => j.estimate.usd); // → [1.4]
```

### `media.approve(id)` · `media.cancel(id)` → `Promise<Job>`

```ts
await media.approve("mj_…"); // → { status: "queued", … } (or throws over_budget if a cap would break now)
await media.cancel("mj_…");  // → { status: "canceled", … }
```

### `media.spend()` → `SpendSummary`

```ts
media.spend();
// → { today: 1.23, month: 8.4, byProvider: { google: { today: 0.8, month: 5 }, fal: { today: 0.43, month: 3.4 } } }
```

### `media.brands.list()` · `.get(id)` · `.save(brand)`

```ts
media.brands.list().map((b) => b.id);   // → ["claudia", "my-coin"]
media.brands.get("claudia")?.style;     // → the look described above
media.brands.save({ id: "my-coin", name: "My Coin", refs: [], style: "neon, playful" }); // → the saved Brand
```

### `media.checkModels({ provider?, dryRun? })` → `Promise<CheckModelsResult[]>`

```ts
await media.checkModels({ provider: "openai" });
// → [{ provider: "openai", checked: true, missing: [], retired: [] }]
```

### `media.on("job", cb)` · `media.off("job", cb)` · `media.close()`

```ts
media.on("job", (j) => console.log(j.id, j.status, j.progress ?? ""));
// → mj_… running 0.4
//   mj_… downloading
//   mj_… succeeded
await media.close(); // stops polling; unfinished jobs resume next time
```

### `launchCardPrompt({ name, symbol, chain?, launchpad?, idea? })` → `string`

```ts
launchCardPrompt({ name: "Kitty", symbol: "$kitty", chain: "hood", launchpad: "clanker", idea: "a cat in a silver jacket" });
// → "Launch announcement card for the coin Kitty ($KITTY) on Robinhood Chain (Clanker). Theme: a cat in a silver jacket.
//    Bold, clean composition with the ticker $KITTY as the only text; no prices, charts going up, or promises."
```

### `envKeys(env?)` · `chainKeys(...providers)` · `staticKeys(map)` · `KEY_NAMES`

```ts
KEY_NAMES;                                             // → ["google", "openai", "fal", "elevenlabs", "heygen", "runway", "byteplus"]
await envKeys().get("google");                         // → the value of CLAUDIA_KEY_GOOGLE, or null
await chainKeys(staticKeys({ fal: "k1" }), envKeys()).get("fal"); // → "k1" (first provider that has it)
```

### `findModel(id)` · `MODEL_TABLE`

```ts
findModel("google/veo-3.1-fast")?.shutdown; // → "2026-10-22"
MODEL_TABLE.length;                         // → the number of models in the table
```

### `DEFAULT_BRAND`

The seeded `claudia` brand kit (`{ id: "claudia", name: "Claudia", refs: [], style: "…" }`). `createMedia({ defaultBrand: false })` skips seeding it.

### `CONNECTORS`

The provider connectors, by id (`google`, `openai`, `fal`, `elevenlabs`, `heygen`, `runway`, `byteplus`). Read them to see each provider's `name`, `kinds` and `keyUrl`, or add your own.

### `createTransport({ fetch?, dryRun? })` · `redactRequest(request)`

The one HTTP layer every connector uses. `redactRequest` turns a request into what a dry run shows:

```ts
redactRequest({ method: "POST", url: "https://api.openai.com/v1/images", headers: { Authorization: "Bearer sk-…" }, body: { prompt: "…" } });
// → { method: "POST", url: "https://api.openai.com/v1/images", headers: { Authorization: "***" }, body: { prompt: "…" } }
```

### `sniff(bytes)` · `pcmToWav(pcm, sampleRate?, channels?, bitsPerSample?)`

```ts
sniff(await readFile("clip.mp4"));        // → { mime: "video/mp4", width: 720, height: 1280, durationSec: 8 }
const wav = pcmToWav(rawPcm, 24000);      // raw 16-bit PCM (e.g. Gemini TTS) → a playable WAV file's bytes
```

### `ClaudiaMediaError` · `isMediaError(e)`

```ts
try { await media.generate({ kind: "avatar", model: "heygen/avatar-iv", text: "gm", refs: ["face.png"] }); }
catch (e) { if (isMediaError(e)) console.log(e.code, e.message); }
// → invalid HeyGen photo avatars need a voice id
```


## Dates to know

| Date | What happens |
|---|---|
| 2026-10-22 | Google shuts down the Veo 3.1 previews (standard, fast, lite). Use `google/omni-flash` |
| 2026-10-31 | HeyGen v1/v2 endpoints are retired. This package already uses v3 |
| 2026-12-01 | OpenAI shuts down GPT Image 1.5 and 1 Mini. Use GPT Image 2.5 |
| 2026-12-31 | ElevenLabs premade voices stop working. Use your own voice ids |
| 2027-01-06 | OpenAI shuts down `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` |

## Troubleshooting and FAQ

**Does Claudia see my keys or my media?** No. Keys come from your own store or env vars, requests go straight from your machine to the provider, and files stay in your data dir.

**Why did my job end as `expired`?** The provider deleted the result before it could be downloaded, usually because the app was closed longer than the provider keeps files (2 days for Veo, 24–48 h for Runway and BytePlus). Run it again.

**Why `blocked`?** A provider safety filter refused the prompt or the output, or the prompt contains a word from the brand kit's `banned` list. `job.error.message` says which.

**My job sits at `needs_approval`.** Its estimate is above `approveAboveUsd`. Call `approve(id)`, or approve it in Claudia Local or the CLI.

**How exact are the estimates?** Image prices per image and video prices per second are list prices. TTS, Omni (whose length the model chooses), HeyGen, and anything with an assumed default length are estimates. After the job, `provenance.costUsd` is exact for OpenAI images and Runway, and the estimate everywhere else.

**`unsupported` for a model I used last month.** It retired. The hint names the replacement; [Dates to know](#dates-to-know) lists what's next.

**Can I add a provider or a model?** A model: add a row to `MODEL_TABLE` (`src/models.ts`). A provider: write a connector (`capabilities → estimate → submit → poll → download`, see `src/providers/base.ts`) and register it. Connectors only use `ctx.http`, so dry runs and mocks work for them automatically.

**Is Imagen supported?** No. Imagen 4 shut down on 2026-08-17. Use the Nano Banana models.

## Security notes

- **Your keys, your account.** Keys are read from your `KeyProvider` at call time and sent only to that provider. Dry runs and logs replace them with `***`.
- **Nothing uploads to Claudia.** Prompts, files and outputs stay between your machine and the provider. (Posting through `@useclaudia/social` may use the short-lived Claudia media relay for networks that need a public URL.)
- **Spend is capped locally**, before anything is sent, and the ledger is append-only.
- **Agents start, people approve.** Keep `approveAboveUsd` for any agent; the MCP server never approves paid jobs on its own.
- **Label AI content.** Outputs carry provider watermarks (SynthID, C2PA) and a provenance sidecar; keep them when you post.

## Links

- Page on the site: [useclaudia.xyz/docs/developers/media](https://useclaudia.xyz/docs/developers/media) ([Markdown](https://useclaudia.xyz/docs/developers/media.md))
- [Changelog](https://useclaudia.xyz/docs/developers/changelog) · [Generators on Claudia](https://useclaudia.xyz/docs/generators)
- The other packages: [sdk](https://useclaudia.xyz/docs/developers/sdk) · [social](https://useclaudia.xyz/docs/developers/social) · [cli](https://useclaudia.xyz/docs/developers/cli) · [mcp](https://useclaudia.xyz/docs/developers/mcp)

MIT © Claudia ([useclaudia.xyz](https://useclaudia.xyz))
