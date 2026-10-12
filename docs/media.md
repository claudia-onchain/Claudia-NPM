# @useclaudia/media

Images, video, speech, music, sound effects and talking avatars for Claudia agents and apps, made with your own provider keys, priced before they run, and saved to a local library you own.

![@useclaudia/media: images, video, voice and music with your own keys](https://useclaudia.xyz/media/dev/banner-media.svg)

[npm](https://www.npmjs.com/package/@useclaudia/media) · [Package README](https://github.com/claudia-onchain/Claudia-NPM/tree/main/packages/media) · [Online docs](https://useclaudia.xyz/docs/developers/media) · [All docs](./README.md)

This guide covers version **0.3.0**. One small API talks to Google Gemini, OpenAI, fal.ai, ElevenLabs and HeyGen, with Runway and BytePlus ModelArk as options. Claudia hosts no provider keys and never sees yours: requests go straight from your machine to the provider, on your own account.

## Contents

[Install](#install) · [Quickstart](#quickstart) · [Core concepts](#core-concepts) · [Guides](#guides) · [API reference](#api-reference) · [Models](#models) · [Configuration](#configuration) · [Errors](#errors) · [Safety and cost](#safety-and-cost) · [Links](#links)

## Install

```sh
npm i @useclaudia/media
pnpm add @useclaudia/media
bun add @useclaudia/media
```

| Requirement | Detail |
|---|---|
| Node.js | 18.17 or newer (`engines.node: ">=18.17"`) |
| Module format | ESM only, with TypeScript types. One entry point: `@useclaudia/media` |
| Dependencies | None at runtime, no peer dependencies. Uses the global `fetch`, `node:crypto` and `node:fs` |
| Storage | Local files under `~/.claudia/media`, or `$CLAUDIA_HOME/media`, or `<dataDir>/media` |
| Keys | At least one provider key to generate. Dry runs need none |

From the terminal, the [`claudia` CLI](https://useclaudia.xyz/docs/developers/cli) wraps this package as `claudia generate` (`npm i -g @useclaudia/cli`; this package comes with it).

## Quickstart

Put one provider key in your environment. A Google Gemini key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) covers images, video, music and speech.

```sh
export CLAUDIA_KEY_GOOGLE=…
```

```ts
import { createMedia, envKeys } from "@useclaudia/media";

const media = createMedia({
  keys: envKeys(), // reads CLAUDIA_KEY_GOOGLE, CLAUDIA_KEY_OPENAI, …
  limits: { perJobUsd: 2, perDayUsd: 10, approveAboveUsd: 1 },
});

const req = { kind: "image", model: "google/nano-banana-2.1", prompt: "a disco ball on a trading desk", aspect: "1:1" } as const;
console.log(media.estimate(req));
// → { usd: 0.0336, basis: "$0.0336 per 1K image, $0.0504 2K, $0.113 4K", confidence: "list" }

const job = await media.generate(req);
if ("dryRun" in job) throw new Error("unexpected dry run");
const done = await media.wait(job.id);
console.log(done.status, done.outputs[0]?.path, done.provenance.costUsd);
// → succeeded /Users/you/.claudia/media/library/2026-10/mj_…-1.png 0.0336

await media.close();
```

Want to see the request first, with no key and no spend? Pass `{ dryRun: true }` to `generate()`. Here is the same idea from the CLI:

![claudia generate video --dry-run shows the model, the estimate, today's spend and the exact request with the key hidden](https://useclaudia.xyz/media/dev/media-generate.svg)

## Core concepts

### Providers and keys

Each provider has a key name. You pass keys in through a `KeyProvider`, an object with `get(name)` that returns a string or `null` (sync or async). `createMedia` always falls back to `CLAUDIA_KEY_<NAME>` environment variables when your provider has no answer.

```ts
import { chainKeys, envKeys, staticKeys, KEY_NAMES } from "@useclaudia/media";

const keys = chainKeys(myVault, envKeys());                 // your store first, then env vars
const forScripts = staticKeys({ google: process.env.G_KEY }); // a fixed map
KEY_NAMES; // → ["google", "openai", "fal", "elevenlabs", "heygen", "runway", "byteplus"]
```

`chainKeys` tries each provider in order. The first non-empty answer wins, and a provider that throws is skipped. Keys are read when a job needs them, not stored by the package.

`media.providers()` tells you which providers are configured:

```ts
(await media.providers()).filter((p) => p.configured).map((p) => p.id);
// → ["google", "fal"]
```

### Default models

Every request has a `kind`. If you leave out `model`, `generate()` walks the defaults for that kind in order and picks the first one whose provider key is set.

| Kind | Defaults, in order |
|---|---|
| image | `google/nano-banana-2.1`, `openai/gpt-image-2.5-flare`, `fal/flux-2-pro`, `byteplus/seedream-4.5`, `runway/gen4-image` |
| video | `google/omni-flash`, `fal/kling-2.6-pro`, `runway/gen4.5`, `byteplus/seedance-1.5-pro` |
| speech | `elevenlabs/multilingual-v2`, `google/gemini-3.8-flash-tts`, `openai/gpt-4o-mini-tts` |
| music | `google/lyria-3.5`, `elevenlabs/music-v1` |
| sfx | `elevenlabs/sfx-v2` |
| avatar | `heygen/avatar-iv`, `fal/omnihuman-1.5` |

`estimate()` is synchronous, so it only knows the keys the instance has already looked up. Pass `model` when you need the estimate to match the exact model `generate()` will use.

### Estimates

`media.estimate(req)` prices a request without running it. `generate()` makes the same estimate before it accepts a job.

```ts
media.estimate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 10, meta: { audio: false } });
// → { usd: 0.7, basis: "$0.14 per second with audio ($0.07 without) (without audio) × 10s", confidence: "list" }
```

`confidence` is one of:

- `"list"`: from the provider's public price page.
- `"estimate"`: our arithmetic. Token-billed audio, model-chosen lengths, HeyGen, and any per-second or per-minute model where you left out `durationSec` (the basis then says "default length"). Estimates may carry `low` and `high`.
- `"exact"`: reserved in the type. After a job, `provenance.costUsd` is exact for OpenAI images (from reported token usage) and Runway (from task credits), and is the estimate everywhere else.

### Spend caps

```ts
createMedia({
  keys,
  limits: {
    perJobUsd: 2,          // refuse any single job estimated above $2
    perDayUsd: 10,         // UTC day
    perMonthUsd: 100,      // UTC month
    approveAboveUsd: 0.5,  // jobs above $0.50 wait for approve(id)
    perProvider: { google: { perDayUsd: 5 }, fal: { perJobUsd: 1 } },
  },
});
```

- Caps are checked locally, before anything is sent. Global and per-provider caps both apply, so the stricter one wins.
- Day and month caps count money already spent, money reserved by queued jobs, and the new job together.
- A job that would break a cap throws `over_budget` from `generate()`. The message names the cap.
- Every job is recorded in an append-only ledger, `<dataDir>/media/spend.jsonl`. A job reserves its estimate when it is submitted. On success it settles at the final cost. It is voided when the job fails, is blocked or expires. A job canceled while running keeps its reservation, because the provider may still bill work it started.
- `media.spend()` returns `{ today, month, byProvider }`.

### Approvals

If a job's estimate is above `approveAboveUsd` (the lower of the global and per-provider values), the job is created with status `needs_approval` and nothing is sent.

```ts
const j = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 10 }); // ~$1.40
if (!("dryRun" in j) && j.status === "needs_approval") {
  await media.approve(j.id); // re-checks the caps, then queues it
  // or: await media.cancel(j.id);
}
await media.generate(req, { approve: true }); // pre-approved, still subject to the caps
```

`wait()` also resolves when a job reaches `needs_approval`, so a script never hangs on a job nobody approved.

### Job queue

`generate()` returns at once with a `queued` (or `needs_approval`) job. A scheduler inside the instance submits, polls and downloads.

| Status | Meaning |
|---|---|
| `needs_approval` | Waiting for `approve(id)` |
| `queued` | Accepted, waiting for a free provider slot, or retrying after a `429` / `5xx` |
| `running` | Submitted to the provider and being polled |
| `downloading` | Saving outputs to the library |
| `succeeded` | Outputs are on disk |
| `failed` | See `job.error` (`code`, `message`, `hint`) |
| `blocked` | A provider safety filter or a brand kit's banned list refused it |
| `expired` | The provider deleted the result before it was downloaded |
| `canceled` | You canceled it |

- **Polling** starts after 5 s and backs off ×1.5 up to 15 s (`poll` option).
- **Concurrency** is 2 running jobs per provider, 1 for HeyGen and Runway (`concurrency` option).
- **Retries.** A `429` or `5xx` on submit puts the job back in the queue (up to 3 times), honouring `Retry-After`. A network error on submit fails the job, so you never pay twice.
- **Persistence.** Jobs are written atomically to `<dataDir>/media/jobs.json` with the provider's operation id. After a restart, polling resumes without resubmitting.
- **Crash during submit.** The job is marked failed with a hint to check the provider dashboard, since it is unknown whether the provider accepted it.
- **Two processes, one data dir.** A per-job lease stops two processes (for example the CLI and Claudia Local) from polling the same job.
- **Time limit.** A job still running after 6 hours fails. Up to 1,000 jobs are kept in `jobs.json`; the oldest finished ones are dropped first.
- **Cancel** also asks the provider to stop where it can: fal, Runway, BytePlus (queued tasks only) and Gemini Omni.

### Library and provenance

Outputs are downloaded as soon as the provider is done. Google deletes Veo videos after 2 days, and fal, Runway, HeyGen and BytePlus links expire too.

```
<dataDir>/media/library/2026-10/mj_…-1.mp4
<dataDir>/media/library/2026-10/mj_…-1.mp4.json   ← { jobId, output, provenance }
```

- Each `MediaOutput` has `path`, `mime`, `bytes` and `sha256`. When they are cheap to read from the file header it also has `width` / `height` (PNG, JPEG, WebP, GIF, MP4/MOV) and `durationSec` (WAV, MP4, MP3).
- `job.provenance` holds the final `prompt` (brand style included), `model`, `provider`, `costUsd`, `watermark` (`"SynthID"` for Google, `"C2PA"` for OpenAI images), `terms` (the provider's terms URL) and `at`.
- Keep the `.json` sidecar next to the file. `@useclaudia/social` reads it to add AI labels.

### Brand kits

A brand kit adds reference images, a voice, a style line and banned words to any request that names it.

```ts
media.brands.save({
  id: "my-coin",
  name: "My Coin",
  refs: ["/path/to/mascot.png"],                            // used when a visual request has no refs
  voice: { provider: "elevenlabs", voiceId: "<voice id>" }, // used for speech / avatar on that provider
  style: "neon, playful, bold outlines",                    // appended to image / video / avatar prompts
  banned: ["guaranteed", "100x"],                           // a prompt containing these is blocked
});
await media.generate({ kind: "image", prompt: "mascot on a rocket", brand: "my-coin" });
```

Kits live in `<dataDir>/media/brands.json`. A default `claudia` kit (`DEFAULT_BRAND`) is seeded on first run with a style line and no reference images. Pass `defaultBrand: false` to skip it. Brand ids are 1 to 64 letters, digits, dashes or underscores.

### Dry runs

All HTTP goes through one transport. In a dry run it returns the exact request instead of sending it, with secret headers (`Authorization`, `x-goog-api-key`, `xi-api-key`, `X-Api-Key` and similar) and query keys (`key`, `api_key`, `token`) shown as `"***"`.

```ts
const r = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…", durationSec: 5 }, { dryRun: true });
// { dryRun: true,
//   request: { method: "POST", url: "https://queue.fal.run/fal-ai/kling-video/v2.6/pro/text-to-video",
//              headers: { Authorization: "***", "Content-Type": "application/json" },
//              body: { prompt: "…", duration: "5" } },
//   estimate: { usd: 0.7, basis: "$0.14 per second with audio ($0.07 without) × 5s", confidence: "list" } }
```

A dry run needs no key, creates no job, skips the spend caps and spends nothing. `createMedia({ dryRun: true })` makes every call dry. Input checks still run: an unknown model, a retired model, a banned word or a HeyGen photo avatar without a voice still throw.

## Guides

Each example assumes a `media` instance from the quickstart. Every `generate()` returns `Job | DryRun`; the guard `"dryRun" in job` narrows it.

### Images

```ts
const job = await media.generate({
  kind: "image",
  model: "openai/gpt-image-2.5-flare",
  prompt: "a sticker of a peach disco ball",
  aspect: "1:1",
  meta: { quality: "high", background: "transparent", format: "png" },
});
```

- `refs` are reference images or images to edit. OpenAI takes up to 16, Nano Banana up to 14.
- OpenAI `meta`: `quality` (`"low"` to `"max"`, default `"medium"`), `background: "transparent"`, `format` (`"png"`, `"jpeg"`, `"webp"`), `moderation`.
- `resolution`: `"1K"`, `"2K"`, `"4K"` for Nano Banana; `"WxH"` for OpenAI.
- `launchCardPrompt()` writes a ready prompt for a coin's launch card:

```ts
import { launchCardPrompt } from "@useclaudia/media";
const prompt = launchCardPrompt({ name: "Disco Ball", symbol: "DISCO", chain: "hood", launchpad: "pons" });
// → "Launch announcement card for the coin Disco Ball ($DISCO) on Robinhood Chain (Pons V2). Bold, clean composition …"
```

Solana is the default chain. The ticker is the only text on the image, with no prices, rising charts or promises.

### Video

Video takes seconds to minutes, so give `wait()` a timeout or listen for events.

```ts
const v = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "a coin spins on a mirror, slow dolly-in", aspect: "9:16", durationSec: 5 });
if (!("dryRun" in v)) {
  const out = await media.wait(v.id, { timeoutMs: 10 * 60_000 });
  console.log(out.status, out.outputs[0]?.path);
}
```

- Image refs are the first and last frame. For Veo, `meta.refMode: "reference"` uses up to three as asset references instead.
- `meta.audio: false` turns off generated audio on fal and BytePlus models that support it; Kling 2.6 Pro and Kling 3 Pro then estimate at their silent rate.
- `runway/aleph2` edits a video: pass the source video (30 s or shorter) in `refs`. `runway/gen4-turbo` needs a start image.
- Gemini Omni Flash picks its own length; its estimate assumes 8 s.

### Speech

```ts
const s = await media.generate({ kind: "speech", model: "elevenlabs/flash-v2.5", text: "gm. Here are today's top movers.", voice: "<your ElevenLabs voice id>" });
```

- `text` is what to say. `voice` is the provider's voice id or name.
- Without `voice`: Gemini TTS uses `Kore`, `gpt-4o-mini-tts` uses `marin`, `tts-1-hd` uses `alloy`, and ElevenLabs uses the example voice from its own docs. ElevenLabs premade voices stop working on 2026-12-31, so set your own.
- `meta.style` gives speaking instructions to Gemini TTS and `gpt-4o-mini-tts`. `meta.voiceSettings` goes to ElevenLabs.
- Gemini TTS returns WAV; OpenAI and ElevenLabs return MP3.

### Music and sound effects

```ts
await media.generate({ kind: "music", model: "elevenlabs/music-v1", prompt: "lofi beat for a launch clip", durationSec: 30, meta: { instrumental: true } });
await media.generate({ kind: "sfx", prompt: "coin drop on glass", durationSec: 2 });
```

- Lyria 3.5 makes a full song for a flat price; `meta.format: "wav"` asks Google for WAV. Lyria 3 Clip makes 30-second clips.
- ElevenLabs music takes `durationSec` from 3 to 600 s. Sound effects take 0.5 to 30 s, plus `meta.promptInfluence` and `meta.loop`.

### Avatars and lip-sync

```ts
await media.generate({ kind: "avatar", model: "heygen/avatar-iv", text: "gm, here's today's recap.", voice: "<HeyGen voice id>", meta: { avatarId: "<look id>" } });
await media.generate({ kind: "avatar", model: "fal/omnihuman-1.5", refs: ["face.png", "voice.mp3"], prompt: "warm, direct" });
```

- **HeyGen** takes a stock or custom avatar (`meta.avatarId`, a look id from `GET /v3/avatars/looks`) or a face photo in `refs`, plus `text` and a HeyGen `voice`. Instead of `text` + `voice` you can pass an audio ref, but HeyGen needs it as a public http(s) URL. A photo avatar with no voice, no audio ref and no `avatarId` fails with `invalid` before any job is created.
- **OmniHuman 1.5** takes `[face image, audio]`. Make the audio first with `kind: "speech"`.
- **Lip-sync** (`fal/lipsync-2`, `fal/veed-lipsync`) takes `[video, audio]`.
- Avatar estimates use `durationSec`, else the length of a local audio ref, else a guess from the script.

## API reference

### Exports

| Export | What it is |
|---|---|
| `createMedia(options)` | Creates a `Media` instance. Throws `invalid` without `keys`. See [Configuration](#configuration) for options |
| `envKeys(env?)` | `KeyProvider` that reads `CLAUDIA_KEY_<NAME>` (defaults to `process.env`) |
| `chainKeys(...providers)` | `KeyProvider` that tries each provider in order |
| `staticKeys(map)` | `KeyProvider` from a fixed `{ name: key }` map |
| `KEY_NAMES` | The seven key names the package asks for |
| `launchCardPrompt({ name, symbol, chain?, launchpad?, idea? })` | Prompt string for a coin launch card. `chain`: `"sol"` (default) or `"hood"`. `launchpad`: `pump`, `pons`, `pools`, `flap`, `bags`, `clanker`, `dyor` or any name |
| `DEFAULT_BRAND` | The seeded `claudia` brand kit |
| `MODEL_TABLE` | Every model entry: ids, caps, prices, `shutdown`, `replacedBy`, `unverified` |
| `findModel(id)` | Looks up a model by Claudia id or provider id |
| `CONNECTORS` | Provider connectors by id (`name`, `kinds`, `docs`, `keyUrl`, `terms`, `submit`, `poll`, …) |
| `createTransport({ fetch?, dryRun? })` | The HTTP layer all connectors use |
| `redactRequest(request)` | A request as a dry run shows it, secrets as `"***"` |
| `sniff(bytes)` | `{ mime?, width?, height?, durationSec? }` from a file header |
| `pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16)` | Wraps raw PCM in a WAV header |
| `ClaudiaMediaError`, `isMediaError(e)` | The error class and its type guard |
| Types | `MediaKind`, `ProviderId`, `GenerateRequest`, `Job`, `JobStatus`, `MediaOutput`, `Provenance`, `Estimate`, `ModelInfo`, `PriceInfo`, `SpendLimits`, `SpendSummary`, `Brand`, `DryRun`, `DryRunRequest`, `ProviderSummary`, `KeyProvider`, `MediaOptions`, `Media`, `JobListener`, `CheckModelsResult`, `ModelEntry`, `Connector`, `ConnectorContext`, `ConnectorStep`, `RemoteOutput`, `Transport`, `HttpRequest`, `HttpResponse`, `DryRunResult`, `FormPart`, `MediaErrorCode` |

### `Media` methods

| Method | Returns | Notes |
|---|---|---|
| `providers()` | `Promise<ProviderSummary[]>` | `id`, `name`, `kinds`, `configured`, `docs` |
| `models({ kind?, provider? })` | `ModelInfo[]` | Includes retired models, flagged `retired: true` |
| `estimate(req)` | `Estimate` | `usd`, `low?`, `high?`, `basis`, `confidence` |
| `generate(req, { dryRun?, approve? })` | `Promise<Job \| DryRun>` | Returns at once; the queue does the rest |
| `wait(id, { timeoutMs? })` | `Promise<Job>` | Resolves when finished or at `needs_approval`; on timeout, the job as it is |
| `getJob(id)` | `Job \| null` | |
| `listJobs({ status?, limit? })` | `Job[]` | Newest first |
| `approve(id)` | `Promise<Job>` | Re-checks caps; throws `over_budget` if a cap would break now |
| `cancel(id)` | `Promise<Job>` | Asks the provider to cancel where it can |
| `spend()` | `SpendSummary` | `{ today, month, byProvider }`, UTC |
| `brands.list()` · `brands.get(id)` · `brands.save(brand)` | `Brand[]` · `Brand \| null` · `Brand` | `save` throws `invalid` on a bad id |
| `checkModels({ provider?, dryRun? })` | `Promise<CheckModelsResult[]>` | Reports model ids a provider no longer lists |
| `on("job", cb)` · `off("job", cb)` | `void` | Called on every status or progress change |
| `close()` | `Promise<void>` | Stops polling; unfinished jobs resume next time |

### `GenerateRequest`

| Field | Type | Notes |
|---|---|---|
| `kind` | `"image" \| "video" \| "speech" \| "music" \| "sfx" \| "avatar"` | Required |
| `model` | `string` | Claudia model id, e.g. `"google/veo-3.1-fast"`. Default per kind |
| `prompt`, `negativePrompt` | `string` | |
| `text` | `string` | Speech: the words. Avatar: the script |
| `voice` | `string` | Provider voice id or name |
| `refs` | `string[]` | Local paths, http(s) URLs or `data:` URIs |
| `aspect` | `"1:1" \| "16:9" \| "9:16" \| "4:5" \| "3:2" \| "2:3"` | |
| `resolution` | `string` | `"1K"`/`"2K"`/`"4K"` (images), `"720p"`/`"1080p"`/`"4k"` (video), `"WxH"` (OpenAI) |
| `durationSec`, `n`, `seed` | `number` | |
| `brand` | `string` | Brand kit id |
| `meta` | `Record<string, unknown>` | Provider extras (below) |

| `meta` key | Applies to | Effect |
|---|---|---|
| `quality` | OpenAI images | `"low"`, `"medium"` (default), `"high"`, `"xhigh"`, `"max"` (model-dependent) |
| `background` | OpenAI images | `"transparent"` |
| `format` | OpenAI images, Google music | `"png"` / `"jpeg"` / `"webp"`; `"wav"` for Lyria |
| `moderation` | OpenAI images | Passed through as `moderation` |
| `style` | Gemini TTS, `gpt-4o-mini-tts` | Speaking instructions |
| `voiceSettings` | ElevenLabs speech | Voice settings object |
| `promptInfluence`, `loop` | ElevenLabs SFX | Prompt adherence; loopable sound |
| `instrumental` | ElevenLabs music | No vocals |
| `audio` | fal, BytePlus video | `false` turns generated audio off |
| `refMode` | Veo | `"reference"` uses refs as asset references |
| `avatarId`, `title` | HeyGen | Avatar look id; video title |
| `providerOptions` | All providers | Merged as-is into the provider request body |

## Models

Prices as of 2026-10-08, from each provider's page (`list`) or our arithmetic (`estimate`). Check the provider before you rely on them; `media.models()` returns the live table with `price.url`.

| Model | Kind | Price | Notes |
|---|---|---|---|
| `google/nano-banana-2.1` | image | $0.0336 per 1K image, $0.0504 2K, $0.113 4K | SynthID |
| `google/nano-banana-2` | image | $0.067 per 1K image ($0.045 512px, $0.101 2K, $0.151 4K) | SynthID |
| `google/nano-banana-lite` | image | $0.0336 per image (1K only) | SynthID |
| `google/nano-banana-pro` | image | $0.134 per 1K/2K image, $0.24 4K | SynthID |
| `google/gemini-2.5-flash-image` | image | $0.039 per image | Retired 2026-10-02 → `google/nano-banana-2.1` |
| `google/imagen-4` | image | — | Retired 2026-08-17 → `google/nano-banana-2.1` |
| `openai/gpt-image-2.5-flare` | image | ~$0.013 per 1024² medium image (estimate) | C2PA, exact cost from usage |
| `openai/gpt-image-2.5-sunburst` | image | ~$0.013 per 1024² medium image (estimate) | C2PA, best for precise edits |
| `openai/gpt-image-2` | image | $0.053 per 1024² medium image ($0.006 low, $0.211 high) | C2PA |
| `openai/gpt-image-1.5` | image | $0.034 per 1024² medium image | Shuts down 2026-12-01 |
| `openai/gpt-image-1-mini` | image | $0.011 per 1024² medium image | Shuts down 2026-12-01 |
| `fal/flux-2-pro` | image | $0.03 first megapixel, $0.015 per extra | |
| `fal/flux-dev` | image | $0.025 per megapixel | No refs |
| `fal/flux-kontext-pro` | image | $0.04 per image | Edit; needs an image ref |
| `runway/gen4-image` | image | $0.05 per 720p image, $0.08 per 1080p | |
| `byteplus/seedream-4.5` | image | $0.04 per image | |
| `byteplus/seedream-5-flash` | image | $0.018 per image | |
| `byteplus/seedream-5-lite` | image | $0.035 per image | Provider id unconfirmed (`unverified`) |
| `google/omni-flash` | video | ~$0.10 per second at 720p, 8 s assumed (estimate) | SynthID; length set by the model |
| `google/veo-3.1` | video | $0.40 per second (720p/1080p), $0.60 4K | Shuts down 2026-10-22 → `google/omni-flash` |
| `google/veo-3.1-fast` | video | $0.10 per second 720p, $0.12 1080p, $0.30 4K | Shuts down 2026-10-22 |
| `google/veo-3.1-lite` | video | $0.05 per second 720p, $0.08 1080p | Shuts down 2026-10-22 |
| `fal/kling-2.6-pro` | video | $0.14 per second with audio ($0.07 without) | 5 or 10 s |
| `fal/kling-3-pro` | video | $0.168 per second with audio ($0.112 without) | 3–15 s |
| `fal/kling-2.5-turbo-pro` | video | $0.35 for 5 s + $0.07 per extra second | |
| `fal/seedance-2.0` | video | $0.3034 per second 720p, $0.682 1080p | |
| `fal/seedance-1.5-pro` | video | ~$0.26 per 720p 5 s video with audio (estimate) | |
| `fal/hailuo-2.3` | video | $0.28 per 6 s, $0.56 per 10 s | No aspect or resolution control |
| `fal/wan-2.6` | video | $0.10 per second 720p, $0.15 1080p | |
| `runway/gen4.5` | video | $0.12 per second | Text or image to video |
| `runway/gen4-turbo` | video | $0.05 per second | Needs a start image |
| `runway/aleph2` | video | $0.28 per second, 56 credits minimum | Video edit |
| `byteplus/seedance-1.5-pro` | video | ~$0.26 per 720p 5 s (estimate) | |
| `byteplus/seedance-2.0` | video | ~$0.15 per second 720p, ~$0.37 1080p (estimate) | Needs activation on ModelArk |
| `byteplus/seedance-2.0-fast` | video | ~$0.12 per second 720p (estimate) | |
| `google/gemini-3.8-flash-tts` | speech | $0.50 / 1M input + $9.00 / 1M audio tokens until 2026-12-31 | SynthID, WAV |
| `google/gemini-3.8-flash-lite-tts` | speech | $0.50 / 1M input + $6.00 / 1M audio tokens until 2026-12-31 | SynthID, WAV |
| `openai/gpt-4o-mini-tts` | speech | ~$0.015 per minute (estimate) | Shuts down 2027-01-06 |
| `openai/tts-1-hd` | speech | $30 per 1M characters | Shuts down 2027-01-06 |
| `elevenlabs/multilingual-v2` | speech | $0.08 per 1,000 characters | |
| `elevenlabs/v3` | speech | $0.08 per 1,000 characters | |
| `elevenlabs/flash-v2.5` | speech | $0.04 per 1,000 characters | Low latency |
| `google/lyria-3.5` | music | $0.08 per song | SynthID |
| `google/lyria-3-clip` | music | $0.04 per 30-second clip | SynthID |
| `elevenlabs/music-v1` | music | $0.15 per minute | |
| `elevenlabs/music-v2.5` | music | $0.15 per minute | |
| `elevenlabs/sfx-v2` | sfx | $0.12 per minute, 10 s assumed (estimate) | |
| `heygen/avatar-iv` | avatar | ~$0.05–0.10 per second, upper end used (estimate) | Needs a voice |
| `fal/omnihuman-1.5` | avatar | $0.16 per second | `[face image, audio]` |
| `fal/lipsync-2` | avatar | $3.00 per minute | `[video, audio]` |
| `fal/veed-lipsync` | avatar | $0.40 per minute | `[video, audio]` |

`generate()` refuses a model whose shutdown date has passed with `unsupported`; the hint names the replacement. `checkModels()` asks the providers with a model list endpoint (Google, OpenAI, fal, ElevenLabs) which ids still exist. HeyGen, Runway and BytePlus report `checked: false`. OpenAI makes no video here: the Sora / Videos API shut down on 2026-09-24.

### Providers

| Provider | Key name | Env var | Makes | Get a key |
|---|---|---|---|---|
| Google Gemini | `google` | `CLAUDIA_KEY_GOOGLE` | image, video, music, speech | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| OpenAI | `openai` | `CLAUDIA_KEY_OPENAI` | image, speech | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| fal.ai | `fal` | `CLAUDIA_KEY_FAL` | image, video, avatar | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| ElevenLabs | `elevenlabs` | `CLAUDIA_KEY_ELEVENLABS` | speech, sfx, music | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) |
| HeyGen | `heygen` | `CLAUDIA_KEY_HEYGEN` | avatar (v3 API) | [app.heygen.com → Settings → API](https://app.heygen.com/settings?nav=API) |
| Runway (optional) | `runway` | `CLAUDIA_KEY_RUNWAY` | video, image | [dev.runwayml.com](https://dev.runwayml.com/) |
| BytePlus ModelArk (optional) | `byteplus` | `CLAUDIA_KEY_BYTEPLUS` | video, image | [console.byteplus.com → ModelArk → API keys](https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey) |

## Configuration

### `createMedia` options

| Option | Default | What it does |
|---|---|---|
| `keys` | required | A `KeyProvider`. `CLAUDIA_KEY_*` env vars are always the fallback |
| `dataDir` | `$CLAUDIA_HOME`, else `~/.claudia` | Files live in `<dataDir>/media` |
| `limits` | none | `perJobUsd`, `perDayUsd`, `perMonthUsd`, `approveAboveUsd`, `perProvider` |
| `dryRun` | `false` | Every call returns the request it would send |
| `fetch` | global `fetch` | Send all HTTP through a mock or a proxy |
| `concurrency` | `{ heygen: 1, runway: 1 }`, others 2 | Running jobs per provider, e.g. `{ google: 1, fal: 4 }` |
| `poll` | `{ minMs: 5000, maxMs: 15000 }` | Poll timing; backoff ×1.5 |
| `defaultBrand` | `true` | Seed the `claudia` brand kit |

### Environment variables

| Variable | Read by | Purpose |
|---|---|---|
| `CLAUDIA_KEY_GOOGLE`, `CLAUDIA_KEY_OPENAI`, `CLAUDIA_KEY_FAL`, `CLAUDIA_KEY_ELEVENLABS`, `CLAUDIA_KEY_HEYGEN`, `CLAUDIA_KEY_RUNWAY`, `CLAUDIA_KEY_BYTEPLUS` | `envKeys()`, and `createMedia` as a fallback | Provider API keys |
| `CLAUDIA_HOME` | `createMedia` | Data dir when `dataDir` is not set |
| `CLAUDIA_MCP_MEDIA_PER_DAY_USD` | `@useclaudia/mcp` (not this package) | Daily media ceiling for the local MCP server, default 5 |

### Files on disk

| Path under `<dataDir>/media` | Contents |
|---|---|
| `jobs.json` | Jobs and the provider state needed to resume polling (atomic writes) |
| `spend.jsonl` | Append-only spend ledger |
| `brands.json` | Brand kits |
| `library/YYYY-MM/<jobId>-<n>.<ext>` | Outputs, each with a `.json` provenance sidecar (UTC month) |

Files are written with mode `0600` and directories with `0700`.

## Errors

Everything thrown on purpose is a `ClaudiaMediaError` with `code`, `message`, an optional `hint` (a plain-English next step), `retryAfterMs` for rate limits, and `status` when the provider returned an HTTP status.

```ts
import { isMediaError } from "@useclaudia/media";

try {
  await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "…" });
} catch (e) {
  if (isMediaError(e)) console.log(e.code, e.message, e.hint);
}
// → no_key No fal.ai key set Add your fal.ai API key as "fal" (… or the CLAUDIA_KEY_FAL environment variable). Get one at https://fal.ai/dashboard/keys
```

| `code` | When | What to do |
|---|---|---|
| `no_key` | No key for that provider | The hint says where to add one and where to get it |
| `rate_limited` | The provider sent `429`; `retryAfterMs` is set | Inside the queue it is retried for you; or lower `concurrency` |
| `over_budget` | A cap would be exceeded, or the provider says the account is out of credit (`402`) | Raise the cap, pick a cheaper model, or top up |
| `needs_approval` | Reserved for hosts that turn approvals into errors | The queue itself uses the `needs_approval` status |
| `provider_error` | The provider failed, refused the key (`401`/`403`), or the network failed | Check the key; `5xx` on submit is retried |
| `unsupported` | A retired model, an unknown provider, or no `fetch` available | The hint names the replacement |
| `expired` | The provider no longer has the result (`404`/`410`) | Run the job again |
| `blocked` | A safety filter, or a brand kit's `banned` word | Change the prompt |
| `invalid` | Bad input: unknown kind, model or brand, nothing to generate, a missing ref file, a missing required ref, a HeyGen photo avatar without a voice, a closed instance, or a `400`/`422` from the provider | Fix the request |

Failed jobs carry the same `{ code, message, hint }` in `job.error`. A job canceled while running has `job.error.code` `"canceled"`.

## Safety and cost

- **Your keys, your account.** Keys are read from your `KeyProvider` when a job needs them and sent only to that provider. Dry runs show them as `***`.
- **Nothing uploads to Claudia.** Prompts, files and outputs stay between your machine and the provider.
- **Caps are local.** They are checked before anything is sent, and the ledger is append-only.
- **Agents start, people approve.** Keep `approveAboveUsd` set for any agent; an agent should never approve its own jobs. The local MCP server never approves paid jobs.
- **Estimates are not bills.** Token-billed audio, model-chosen lengths and HeyGen are estimates. A job canceled mid-run may still be billed, so its reservation stays in the ledger.
- **Download fast.** Providers delete results (2 days for Veo, 24–48 h for Runway and BytePlus). A closed app can leave a job `expired`.
- **Label AI content.** Outputs carry provider watermarks (SynthID, C2PA) and a provenance sidecar. Keep both when you post.
- **Dates to know.** Veo 3.1 previews shut down 2026-10-22. HeyGen v1/v2 endpoints retire after 2026-10-31 (this package uses v3). GPT Image 1.5 and 1 Mini shut down 2026-12-01. ElevenLabs premade voices stop 2026-12-31. OpenAI TTS shuts down 2027-01-06.

## Links

- npm: [@useclaudia/media](https://www.npmjs.com/package/@useclaudia/media)
- Package README: [packages/media](https://github.com/claudia-onchain/Claudia-NPM/tree/main/packages/media)
- Online docs: [useclaudia.xyz/docs/developers/media](https://useclaudia.xyz/docs/developers/media) · [Changelog](https://useclaudia.xyz/docs/developers/changelog)
- Other packages: [sdk](https://useclaudia.xyz/docs/developers/sdk) · [social](https://useclaudia.xyz/docs/developers/social) · [cli](https://useclaudia.xyz/docs/developers/cli) · [mcp](https://useclaudia.xyz/docs/developers/mcp)
- [Back to all docs](./README.md)

MIT © Claudia ([useclaudia.xyz](https://useclaudia.xyz))
