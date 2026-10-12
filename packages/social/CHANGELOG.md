# Changelog

## 0.3.0 — 2026-10-10

- New `launchAnnouncement()` template: a plain, rule-safe post for a coin launched through Claudia on Solana (pump.fun) or Robinhood Chain (beta: Pons V2, Pools, Flap, Bags, Clanker, Dyor), with the coin page or explorer link (Solscan / Blockscout). BNB Chain is refused as coming soon.
- `publishConfig.provenance`.

## 0.2.1 — 2026-10-08

- TikTok paid partnerships: `labels.ad` sets `brand_content_toggle` ("Branded content"); `options.tiktok.ownBrand` sets `brand_organic_toggle` ("Your brand"). Private branded posts are refused with a hint, as TikTok requires.

## 0.2.0 — 2026-10-08

First release.

- `createSocial()` with the contract API: `networks`, `connect` / `completeOAuth` / `disconnect` / `accounts`, `draft` / `update` / `preview` / `submit` / `approve` / `reject` / `schedule` / `publish`, `posts` / `getPost`, `inbox` / `reply`, `killSwitch`, `tick`, `on` / `off`, `ready`, `close`.
- Direct connectors: X (OAuth 2.0 PKCE, v2 media upload, threads, mentions, DMs, made_with_ai, pay-per-use cost estimate), Telegram (bot API, all media, media groups, topics, getUpdates), Discord (webhooks or bot, forum posts), Bluesky (app password, facets, image/video blobs, threads, stable record keys), Mastodon (instance app registration + PKCE, or access token; Idempotency-Key), Farcaster via Neynar (idem keys), Nostr (NIP-01/10/19/27/92, BIP-340, Blossom uploads, built-in WebSocket client for Node 18/20), LinkedIn personal profile (Posts/Images/Videos API, `Linkedin-Version: 202609`, 60-day expiry reminders), YouTube (resumable upload, private by default, containsSyntheticMedia, comment inbox).
- Posting services: Buffer (GraphQL), Zernio (formerly Late) and Upload-Post, with one Claudia account per connected channel.
- v2 direct connectors: Instagram (Instagram Login, containers, reels, carousels, is_ai_generated), Facebook Pages, Threads, TikTok Content Posting (FILE_UPLOAD, SELF_ONLY until audited, is_aigc), Pinterest v5 (ai_disclosures).
- Listed with a reason, no connector: WhatsApp, Snapchat, Reddit, Zora, Lemon8, Weibo, Douyin.
- Approval queue with once-only publishing: per (post, account) idempotency keys, "in flight" marks saved before every send, crash recovery that never resends uncertain posts on its own, thread resume.
- Rules inside preview/publish: AI labels per network, "Not financial advice." on coin/ticker/price talk, blocked price/return promises, #ad, X reply rule and cashtag limit, daily caps, near-duplicate detection, link frequency, kill switch, audit log.
- Scheduling with `tick()`; schedules missed by more than 10 minutes go back to approval.
- Tokens sealed with AES-256-GCM (key "social-vault", HKDF-SHA256) or a host-provided `TokenStore`; refuses to save tokens without a vault key.
- Media relay support (`POST https://useclaudia.xyz/relay/media`, deleted after publish) with an optional request-signing hook.
- Dry runs everywhere (secrets redacted) and `scripts/dry-run.mjs`.
