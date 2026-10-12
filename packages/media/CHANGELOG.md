# Changelog

## 0.3.0 — 2026-10-10

- Kling 2.6 Pro and Kling 3 Pro estimates honour `meta.audio: false` (the lower silent-video rate).
- HeyGen photo avatars without a voice id now fail up front with a clear `invalid` error (before any job or dry run), instead of at submit time.
- New `launchCardPrompt()` for launch-announcement images: Solana by default, Robinhood Chain (beta) with the launchpad name.
- `publishConfig` sets `access: public` only (provenance comes back once publishing moves to GitHub Actions); depends on nothing new.

## 0.2.1 — 2026-10-08

- The default `claudia` brand kit now describes her accurately (black bob with one peach-orange streak in the bangs, a peach star clip, a thin headset mic, rose accent) and always as an adult in her late twenties, so image models don't drift younger.

## 0.2.0 — 2026-10-08

First release of `@useclaudia/media`.

- `createMedia({ keys, dataDir, limits, fetch, dryRun, concurrency, poll })` gives one API for images, video, speech, music, sound effects and talking avatars. It has no runtime dependencies.
- Provider connectors. All seven follow the same shape and go through one transport. Every request shape was checked against the providers' docs on 2026-10-08:
  - **Google Gemini API:**
    - Nano Banana 2.1 / 2 / Lite / Pro images.
    - Gemini Omni Flash video through the Interactions API.
    - Veo 3.1 / Fast / Lite as long-running operations. Downloads start right away because Google deletes the videos after 2 days.
    - Lyria 3.5 and Lyria 3 Clip music.
    - Gemini 3.8 Flash and Flash-Lite TTS (WAV output).
  - **OpenAI:** GPT Image 2.5 Flare / Sunburst, GPT Image 2, GPT Image 1.5 and 1 Mini. Covers generate, edit with up to 16 reference images, and transparent backgrounds. Cost is calculated exactly from token usage. Also `gpt-4o-mini-tts` and `tts-1-hd`. There is no video, because Sora shut down on 2026-09-24.
  - **fal.ai queue API:** Kling 2.5 Turbo / 2.6 / 3, Seedance 1.5 / 2.0, Hailuo 2.3, Wan 2.6, FLUX.2 Pro, FLUX.1 dev, FLUX Kontext, OmniHuman 1.5, Sync Lipsync 2 and VEED Lipsync.
  - **ElevenLabs:** text to speech (Multilingual v2, v3, Flash v2.5), sound effects and music.
  - **HeyGen v3:** `/v3/videos` from an avatar look or a photo, then `/v3/videos/{id}` to poll.
  - **Runway (optional):** Gen-4.5, Gen-4 Turbo, Aleph 2 video edit and Gen-4 Image.
  - **BytePlus ModelArk (optional):** Seedance 1.5 / 2.0 / 2.0 Fast and Seedream 4.5 / 5.0.
- Model table with prices. Each price records its basis, confidence (`list` / `estimate`), date and source URL. Shutdown dates make a model `retired` from that day on. `unverified` marks provider ids that couldn't be confirmed. `checkModels()` reports models that a provider no longer lists, and it is safe to run as a dry run.
- Job queue:
  - Persists to `jobs.json` with atomic writes and resumes polling after a restart.
  - Polls every 5–15 s with backoff and honours `429` / `Retry-After`.
  - Has per-provider concurrency and leases, so two processes can share a data dir.
- Spend control: an estimate before every job; per-job, per-day and per-month caps, both global and per provider; `approveAboveUsd` approvals; and an append-only `spend.jsonl` ledger.
- Library: outputs go to `library/YYYY-MM/` with sha256, mime, size and, where cheaply readable, dimensions and duration. Each file gets a provenance sidecar recording prompt, model, provider, cost, watermark (SynthID / C2PA) and terms.
- Brand kits (`brands.json`), seeded with a default `claudia` kit. A kit's reference images, voice, style line and banned words are applied to requests that name the brand.
- Dry runs return the exact request with secrets shown as `***`. `scripts/dry-run.mjs` prints every model's request and runs a mock end-to-end lifecycle, including a restart.
- `ClaudiaMediaError` with `code`, `hint` and `retryAfterMs`. Events via `on("job")` / `off`.
