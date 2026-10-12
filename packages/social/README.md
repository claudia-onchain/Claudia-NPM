<!-- site:skip -->
![@useclaudia/social: draft, approve, schedule and publish](https://useclaudia.xyz/media/dev/banner-social.svg)

# @useclaudia/social

**Let a Claudia agent draft posts, get a person's approval, schedule them and publish them once, to X, Telegram, Discord, Bluesky, Mastodon, Farcaster, Nostr, LinkedIn, YouTube and more, with your own developer apps and keys.**

[Docs](https://useclaudia.xyz/docs/developers/social) · [Changelog](https://useclaudia.xyz/docs/developers/changelog) · [All five packages](https://useclaudia.xyz/docs/developers) · [useclaudia.xyz](https://useclaudia.xyz)
<!-- /site:skip -->

It also reaches Instagram, Facebook, Threads, TikTok and Pinterest through a posting service (Buffer, Zernio, Upload-Post) or your own Meta / TikTok / Pinterest app, and reads the agent's inbox (mentions, replies, and DMs where the network allows).

Everything runs with **your own** developer apps and keys. Claudia hosts no social secrets: tokens stay on your machine, sealed with AES-256-GCM. The rules that keep an agent account out of trouble (AI labels, "not financial advice", no price promises, daily caps, a kill switch) run on every preview and every publish, and can't be turned off.

## Install

```sh
npm i @useclaudia/social
pnpm add @useclaudia/social
bun add @useclaudia/social
```

- **Runtime:** Node.js 18.17 or newer. ESM with types.
- **Dependencies:** one small one, `@noble/curves` (audited), for Nostr's Schnorr signatures; everything else uses `fetch` and `node:crypto`.
- **Storage:** `~/.claudia/social` (or `$CLAUDIA_HOME/social`), files mode 0600.
- **From the terminal:** the [`claudia` CLI](https://useclaudia.xyz/docs/developers/cli) wraps this package as `claudia connect`, `claudia accounts` and `claudia post <network>` once it's installed next to it.

## 60-second quickstart

Connect Bluesky with an app password, then draft → preview → approve → publish.

```ts
import { createSocial, chainKeys, envKeys, staticKeys } from "@useclaudia/social";

const social = createSocial({
  // Secrets come from your key store. Here: a fixed map with an env fallback (CLAUDIA_KEY_<NAME>).
  // A "social-vault" key (16+ characters, env CLAUDIA_KEY_SOCIAL_VAULT) is required to save accounts.
  keys: chainKeys(staticKeys({ "social-vault": process.env.MY_VAULT_KEY }), envKeys()),
});

// 1. Connect (Bluesky: Settings → Privacy and security → App passwords)
const bsky = await social.connect("bluesky", { handle: "myagent.bsky.social", appPassword: "xxxx-xxxx-xxxx-xxxx" });

// 2. Draft
const post = social.draft({
  text: "$DISCO just crossed 1,000 holders. Here's what the agents are saying.",
  link: "https://useclaudia.xyz",
  targets: [{ account: bsky.id }],
});

// 3. Preview: the exact text per network, labels added, warnings, cost, and a reason if it's blocked
console.log(social.preview(post.id));
// → [{ account: "bluesky:did:plc:…", network: "bluesky", chars: 118, media: 0, warnings: [],
//      text: "$DISCO just crossed 1,000 holders. …\n\nhttps://useclaudia.xyz\n\n(AI-generated) Not financial advice.",
//      labelsAdded: ["text: (AI-generated)", "Not financial advice."] }]

// 4. A person approves (in your UI), then publish. Publishing twice never posts twice.
social.submit(post.id);   // → pending_approval
social.approve(post.id);  // → approved
const done = await social.publish(post.id);
console.log(done.status, done.results[0].url);
// → published https://bsky.app/profile/myagent.bsky.social/post/3m…
```

Want to see the requests without sending anything? `await social.publish(post.id, { dryRun: true })` returns `{ dryRun: true, requests: [...] }` with secrets replaced by `***`. The same thing from the CLI:

![claudia post telegram --dry-run previews the text with the labels added and the request it would send](https://useclaudia.xyz/media/dev/social-post.svg)

## What's new in 0.3

- **`launchAnnouncement({ chain, launchpad, name, symbol, token?, url?, feeSplit? })`**: a plain, rule-safe post for a coin launched through Claudia, on Solana (pump.fun) or Robinhood Chain (beta), with the explorer link (Solscan or Blockscout). BNB Chain is refused as coming soon.
- The local MCP server now exposes the inbox as the `inbox` tool.
- Everything else is unchanged: code written for 0.2 keeps working.
- From 0.2.1: TikTok paid partnerships use the "Branded content" toggle.

Full list: [Changelog](https://useclaudia.xyz/docs/developers/changelog).

## Contents

[How it works](#how-it-works) · [API reference](#api-reference) · [Networks and tiers](#networks-and-tiers) · [Network reference](#network-reference) · [Setup per network](#setup-per-network) · [Costs](#costs) · [Rules and compliance](#rules-and-compliance) · [Announcing coins on each chain](#announcing-coins-on-each-chain) · [Scheduling](#scheduling) · [Inbox](#inbox) · [Kill switch](#kill-switch) · [Dry runs](#dry-runs) · [Media and the relay](#media-and-the-media-relay) · [Storage](#storage-and-secrets) · [Errors](#errors) · [Rate limits](#rate-limits-and-caps) · [Events](#events) · [Recipes](#recipes) · [Export reference](#export-reference) · [Troubleshooting](#troubleshooting-and-faq) · [Security](#security-notes)

## How it works

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──publish──▶ publishing ──▶ published
  │                    ▲   │                       │                                 ├─▶ partial (some accounts failed)
  │                    │   └──reject──▶ canceled    └─schedule──▶ scheduled ──tick──▶ └─▶ failed
  └──approve (a person can approve a draft directly)        │
                       └──────── missed by > 10 min ◀───────┘  ("Posting late?")
```

- **Approval is required.** `publish()` refuses drafts and posts waiting for approval (`needs_approval`). Editing an approved or scheduled post sends it back to `pending_approval`.
- **Once only.** Every (post, account) pair gets a stable idempotency key. Before each send the result is saved as "in flight". If the process dies mid-send, the next start marks that result `failed` with `uncertain: true` ("it may already be live") and **never resends it on its own**. Networks with provider-side idempotency (Mastodon `Idempotency-Key`, Neynar `idem`, Zernio and Upload-Post `Idempotency-Key`, Bluesky's stable record key, Nostr's content-addressed event id) are resent safely with the same key. For the others, a person checks the account and calls `publish(id, { retryUncertain: true })`.
- **Threads resume.** Each thread part is saved as soon as it is live, so a retry continues after the last part.
- **Rules run inside `preview()` and `publish()`** and can't be turned off. See [Rules and compliance](#rules-and-compliance).
- **Every network call goes through one transport.** With `dryRun` it records the request instead of sending it. Pass `fetch` to inject a mock.

## API reference

```ts
createSocial(opts: {
  keys: KeyProvider; dataDir?: string; fetch?: typeof fetch; dryRun?: boolean;
  loopbackPort?: number;           // default 3939
  relayUrl?: string;               // default https://useclaudia.xyz/relay/oauth/callback
  mediaRelay?: { url; token; sign?; ttlMin? };
  tokens?: TokenStore;             // default: sealed <dataDir>/social/accounts.json
  rules?: { caps?, linksPerDay?, duplicateWindowMs?, disclosureText?, nfaText?, lateAfterMin? };
  inboxBudget?: { [network]: { perDay } };
  WebSocket?: unknown;             // Nostr; default global WebSocket or a built-in client
  now?: () => number;
}): Social
```

| Method | What it does | Example → result |
|---|---|---|
| `networks()` | Every network with limits, setup steps, scopes and the docs it was checked against, plus listed-only networks with the reason | `social.networks().find((n) => n.id === "x")?.limits.maxChars` → `280` |
| `connect(network, params?, { dryRun? })` | Key-based networks → `Account`. OAuth networks → `{ authorizeUrl, state, redirectUri }` | `await social.connect("telegram", { token, chat: "@mychannel" })` → `{ id: "telegram:-100…", network: "telegram", handle: "@mychannel" }` |
| `completeOAuth(state, code)` | Finish an OAuth connect | → `Account` |
| `accounts()` · `disconnect(accountId)` | The connected accounts (no secrets) | |
| `draft(input)` · `update(id, partial)` | Create or edit a post | → `Post` with `status: "draft"` |
| `preview(id)` | Exact text per target, labels added, char count, cost, warnings, `blocked` reason | → `Preview[]` |
| `submit(id)` · `approve(id)` · `reject(id, why?)` | Move through approval | `submit` throws `blocked` if a rule refuses a target |
| `schedule(id, at)` | Publish later (approved posts; on a draft or pending post it sets the time, "Scheduled once approved.") | → `status: "scheduled"` |
| `publish(id, { dryRun?, retryUncertain? })` | Idempotent, once only | → `Post` with `results[]` (`url`, `error?`, `uncertain?`) |
| `posts({ status?, limit? })` · `getPost(id)` | Read back | |
| `inbox({ since?, accounts? })` · `reply(account, to, text, { dryRun? })` | Mentions, replies, DMs · reply under the same rules | → `InboxItem[]` · `{ remoteId, url? }` |
| `killSwitch(on?)` | Stop everything / read the state | → `boolean` |
| `tick()` | Publish due scheduled posts; call every ~30 s | |
| `on` / `off(ev, cb)` · `ready()` · `close()` | Events · wait for a custom token store · shut down | |

`PostInput`: `{ text, media?, link?, thread?, replyTo?: { network, id }, targets: [{ account, text? }], scheduleAt?, labels?: { ai?, ad?, nfa? }, options?: { [network]: {...} } }`. Per-network options include `youtube: { title, privacyStatus, categoryId, tags, publishAt, shorts }`, `tiktok: { privacyLevel, allowComment, allowDuet, allowStitch, ownBrand }`, `pinterest: { boardId, title }`, `discord: { title, tags, threadId }`, `telegram: { topicId, noPreview, silent }`, `mastodon: { visibility, spoilerText, language }`, `bluesky: { langs, linkTitle, linkDescription }`, `linkedin: { visibility, linkTitle }`, `farcaster: { channel }`, and `buffer` / `zernio` / `upload-post: { boardId, pageId, privacyLevel, title }`.

Also exported: `launchAnnouncement`, `envKeys`, `chainKeys`, `staticKeys`, `parseClientCreds`, `KEY_NAMES`, `fileTokenStore`, `memoryTokenStore`, `waitForOAuthCallback`, `createPkce`, `makeState`, `portFromState`, `loopbackRedirect`, `DEFAULT_RELAY`, `DEFAULT_MEDIA_RELAY`, `nostrKeygen`, `signNostrEvent`, `NOSTR_DEFAULT_RELAYS`, the rule helpers (`promiseBlock`, `mentionsFinance`, `applyContentRules`, `countChars`, `countX`, `normalizedHash`), `CONNECTORS` / `LISTED_ONLY`, `X_PRICES`, `LINKEDIN_VERSION`, `GRAPH_VERSION`, `ClaudiaSocialError`, `isSocialError`, and every type.

## Networks and tiers

`social.networks()` returns this list with limits, setup steps, scopes and the docs each connector was checked against (8 October 2026).

| Network | Tier | Auth | Text · media · threads · reply · inbox | Docs checked |
|---|---|---|---|---|
| X | direct | OAuth 2.0 PKCE, loopback | 280 (weighted) · 4 images / 1 video · yes · mentions only · mentions (paid) | [docs.x.com](https://docs.x.com/x-api/posts/create-post) |
| Telegram | direct | bot token | 4096 (caption 1024) · 10, all media types · yes · yes · getUpdates | [core.telegram.org/bots/api](https://core.telegram.org/bots/api) |
| Discord | direct | webhook URL or bot token | 2000 · 10 files (20 MiB) · yes, forums too · bot only · bot only | [docs.discord.com](https://docs.discord.com/developers/resources/webhook) |
| Bluesky | direct | handle + app password | 300 graphemes · 4 images or 1 video · yes · yes · notifications | [atproto lexicons](https://docs.bsky.app/docs/advanced-guides/posts) |
| Mastodon | direct | OAuth PKCE on your instance, or access token | 500 · 4 · yes · yes · notifications | [docs.joinmastodon.org](https://docs.joinmastodon.org/methods/statuses/) |
| Farcaster | direct (Neynar) | Neynar API key + signer UUID | 320 bytes · 2 embeds (links) · yes · yes · notifications | [docs.neynar.com](https://docs.neynar.com/reference/publish-cast) |
| Nostr | direct | nsec + your relays | long text · links or Blossom uploads · yes · yes · relay subscription | [NIPs](https://github.com/nostr-protocol/nips/blob/master/01.md) |
| LinkedIn (profile) | direct | OAuth, relay redirect | 3000 · 1–20 images or 1 video · no · no · no | [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) |
| YouTube | direct | Google OAuth PKCE, loopback | title 100 / description 5000 bytes · 1 video · — · comment replies · comments | [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) |
| Buffer | service | API key | per channel · public media links · X/Threads threads · — · — | [developers.buffer.com](https://developers.buffer.com) |
| Zernio | service | API key | per account · presigned uploads · X threads · — · — | [docs.zernio.com](https://docs.zernio.com) |
| Upload-Post | service | API key | per account · direct uploads · — · — · — | [docs.upload-post.com](https://docs.upload-post.com) |
| Instagram | v2 | OAuth, relay redirect | 2200 · 1 image/reel or a 10-item carousel · — · — · — | [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing) |
| Facebook Page | v2 | OAuth, relay redirect | long · photos / video · — · — · — | [Pages API](https://developers.facebook.com/docs/pages-api/posts) |
| Threads | v2 | OAuth, relay redirect | 500 · up to 20 · yes · yes · — | [Threads API](https://developers.facebook.com/docs/threads/posts) |
| TikTok | v2 | OAuth PKCE, loopback (Desktop app) | 2200 · 1 video · — · — · — | [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) |
| Pinterest | v2 | OAuth, relay redirect | title 100 / 800 · 1–5 images or 1 video · — · — · — | [Pins](https://developers.pinterest.com/docs/api/v5/pins-create) |
| WhatsApp | skip | — | Meta's WhatsApp Business policy doesn't allow crypto promotion. | |
| Snapchat | later | — | Posting API is allowlist-only. | |
| Reddit | later | — | Data API needs manual approval; most crypto subreddits ban bots. | |
| Zora | skip | — | Every post mints a coin. Claudia never mints by posting. | |
| Lemon8, Weibo, Douyin | skip | — | No public posting API, or a mainland-China identity is required. | |

**Tiers.** *direct*: Claudia talks to the network with your own app or key. *service*: you connect your profiles inside Buffer, Zernio or Upload-Post and give Claudia that service's key; each connected channel shows up as its own account (`via: "buffer"`). This is the simplest way to reach Instagram, Facebook, Threads, TikTok and Pinterest. *v2*: direct connectors for Meta, TikTok and Pinterest. They work, but need your own app on those platforms (with their review limits) and, for Meta, the media relay.

## Network reference

Generated from `social.networks()`: limits, auth, default daily cap and the key names each network asks for.

| Network | Tier | Auth | Max text | Images | Video MB | Daily cap | Key names | Cost |
|---|---|---|---|---|---|---|---|---|
| X (`x`) | direct | oauth-loopback | 280 | 4 | 512 | 10 | `x` | Pay-per-use on your own X developer account: about $0.015 per post, $0.20 per post with a link, $0.01 per reply to a mention, $0.005 per post read (inbox). |
| Telegram (`telegram`) | direct | key | 4096 | 10 | 50 | 50 | `telegram` | — |
| Discord (`discord`) | direct | key | 2000 | 10 | 20 | 50 | `discord` | — |
| Bluesky (`bluesky`) | direct | key | 300 | 4 | 100 | 30 | `bluesky` | — |
| Mastodon (`mastodon`) | direct | oauth-loopback | 500 | 4 | 40 | 30 | `mastodon` | — |
| Farcaster (via Neynar) (`farcaster`) | direct | key | 320 | 2 | — | 20 | `neynar`, `neynar-signer` | Neynar credits: 150 per cast, 5 per notification read (their plan, your key). |
| Nostr (`nostr`) | direct | key | 4000 | 4 | — | 30 | `nostr` | — |
| LinkedIn (personal profile) (`linkedin`) | direct | oauth-relay | 3000 | 20 | 500 | 5 | `linkedin` | — |
| YouTube (`youtube`) | direct | oauth-loopback | 5000 | 1 | 2048 | 5 | `youtube` | Uses your own Google Cloud quota: 100 uploads per day per project (separate bucket since June 2026), comments cost 50 units of the 10,000 daily units. |
| Buffer (`buffer`) | service | service | 2200 | 10 | — | 10 | `buffer` | Buffer's own plans; the API key works on the Free plan (250 requests/day). |
| Zernio (`zernio`) | service | service | 2200 | 10 | — | 10 | `zernio` | Zernio bills per connected account (1–2 accounts at no charge, then from $6/account/month); API on every tier. |
| Upload-Post (`upload-post`) | service | service | 2200 | 10 | — | 10 | `upload-post` | Upload-Post plans (Free: 10 uploads/month, no TikTok; paid from $16/month annual). |
| Instagram (`instagram`) | v2 | oauth-relay | 2200 | 10 | 300 | 20 | `instagram` | — |
| Facebook Page (`facebook`) | v2 | oauth-relay | 63206 | 10 | 1024 | 10 | `facebook` | — |
| Threads (`threads`) | v2 | oauth-relay | 500 | 20 | 1024 | 25 | `threads` | — |
| TikTok (`tiktok`) | v2 | oauth-loopback | 2200 | 1 | 4096 | 5 | `tiktok` | — |
| Pinterest (`pinterest`) | v2 | oauth-relay | 800 | 5 | 2048 | 10 | `pinterest` | — |
| WhatsApp (`whatsapp`) | skip | key | — | — | — | — | — | — |
| Snapchat (`snapchat`) | later | key | — | — | — | — | — | — |
| Reddit (`reddit`) | later | key | — | — | — | — | — | — |
| Zora (`zora`) | skip | key | — | — | — | — | — | — |
| Lemon8 (`lemon8`) | skip | key | — | — | — | — | — | — |
| Weibo (`weibo`) | skip | key | — | — | — | — | — | — |
| Douyin (`douyin`) | skip | key | — | — | — | — | — | — |

Scopes requested per OAuth network:

- **X:** `tweet.read` `tweet.write` `users.read` `offline.access` `media.write` `dm.read` `dm.write`
- **Mastodon:** `read:accounts` `read:notifications` `write:statuses` `write:media`
- **LinkedIn (personal profile):** `openid` `profile` `w_member_social`
- **YouTube:** `https://www.googleapis.com/auth/youtube.upload` `https://www.googleapis.com/auth/youtube.readonly` `https://www.googleapis.com/auth/youtube.force-ssl`
- **Instagram:** `instagram_business_basic` `instagram_business_content_publish`
- **Facebook Page:** `pages_show_list` `pages_read_engagement` `pages_manage_posts`
- **Threads:** `threads_basic` `threads_content_publish`
- **TikTok:** `user.info.basic` `video.publish` `video.upload`
- **Pinterest:** `boards:read` `pins:read` `pins:write` `user_accounts:read`

## Setup per network

Where a portal asks for a redirect (callback) URL, register one of these:

- **Loopback:** `http://127.0.0.1:<port>/oauth/callback`. Claudia Local uses `http://127.0.0.1:3939/oauth/callback`; the CLI picks its own port. Pass `loopbackPort` to `createSocial`.
- **Relay:** `https://useclaudia.xyz/relay/oauth/callback`, for portals that reject `http://127.0.0.1`. The relay holds no secrets and stores nothing: its page reads `code` and `state` in the browser and redirects to `http://127.0.0.1:<port>/oauth/callback`, taking the port from the state (`<random>.<port>`). The code is useless without your client secret / PKCE verifier, which never leave your machine.

Override per connect with `params.redirect = "loopback" | "relay"` or an exact `params.redirectUri`.

Key names (what `KeyProvider.get(name)` is asked for). OAuth app credentials can be JSON `{"clientId":"…","clientSecret":"…"}` or `clientId:clientSecret`.

| Network | Key name(s) | `connect()` params |
|---|---|---|
| X | `x` (client id [+ secret]) | — |
| Telegram | `telegram` (bot token) | `{ token?, chat: "@channel" \| "-100…", topicId? }` |
| Discord | `discord` (bot token or webhook URL) | `{ webhookUrl }` or `{ token, channelId }`, `forum: "1"` for webhook forums |
| Bluesky | `bluesky` (app password) | `{ handle, appPassword?, service? }` |
| Mastodon | `mastodon` (access token), `mastodon-app` (optional pre-registered app id + secret for sign-in) | `{ instance }` (sign in) or `{ instance, accessToken }` |
| Farcaster | `neynar`, `neynar-signer` | `{ apiKey?, signerUuid? }` |
| Nostr | `nostr` (nsec) | `{ nsec?, relays?: "wss://…,wss://…", blossom? }` (default `NOSTR_DEFAULT_RELAYS`) |
| LinkedIn | `linkedin` | — |
| YouTube | `youtube` | — |
| Buffer / Zernio / Upload-Post | `buffer` / `zernio` / `upload-post` | `{ apiKey? }` |
| Instagram / Facebook / Threads | `instagram` / `facebook` / `threads` | Facebook: `configId?` (Login for Business) |
| TikTok | `tiktok` (client key + secret) | — |
| Pinterest | `pinterest` | `{ boardId? }` |
| vault | `social-vault` | 16+ random characters; encrypts tokens at rest |

OAuth flow from your host:

```ts
const { authorizeUrl, state, redirectUri } = await social.connect("x");
// open authorizeUrl in the browser; your server at redirectUri receives ?code=…&state=…
const account = await social.completeOAuth(state, code);
```

No HTTP server of your own (a CLI)? `waitForOAuthCallback(port)` listens once on `127.0.0.1:<port>/oauth/callback`:

```ts
import { waitForOAuthCallback } from "@useclaudia/social";
const s = await social.connect("youtube", { port: "53682" });
const cb = await waitForOAuthCallback(53682); // { code, state, error }
await social.completeOAuth(cb.state!, cb.code!);
```

### X
1. At developer.x.com create a project and app on the pay-per-use plan.
2. In **User authentication settings** pick OAuth 2.0. "Native App" is a public client (client id only); "Web App, Automated App or Bot" is confidential (id + secret). Permissions: Read and write and Direct message.
3. Callback URL: `http://127.0.0.1:3939/oauth/callback` (X says to use 127.0.0.1, not localhost; it must match exactly).
4. Store the OAuth 2.0 client id (and secret) under `x`. Scopes requested: `tweet.read tweet.write users.read offline.access media.write dm.read dm.write`. Access tokens last 2 hours and are refreshed automatically.
5. Turn on the **Automated** account label (Settings → Your account → Account information → Automation).

### Telegram
Message @BotFather → `/newbot` → copy the token. Add the bot to your channel or group as an **admin with Post Messages**. Connect with `{ token, chat: "@yourchannel" }` (or the numeric `-100…` id for private chats). Topics: `topicId`.

### Discord
Simplest: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL → `connect("discord", { webhookUrl })`. Webhooks can post (also new forum posts with `forum: "1"`) but can't read or reply. For the inbox and replies, create a bot (discord.com/developers → Bot → Reset Token, enable the Message Content intent), invite it with Send Messages, Attach Files, Read Message History (and Create Posts / Send Messages in Threads for forums), and connect with `{ token, channelId }`. Forum channels are detected and become new forum posts. Claudia never pings @everyone, roles or users (`allowed_mentions: { parse: [] }`).

### Bluesky
Settings → Privacy and security → App passwords → Add. Never use your main password. Sessions refresh themselves; if the refresh token expires, Claudia logs in again with the stored app password. Video needs a verified email on the account.

### Mastodon
`connect("mastodon", { instance: "mastodon.social" })` registers a small app named "Claudia" on your instance with the redirect URI `http://127.0.0.1:<port>/oauth/callback` and returns the sign-in URL (PKCE S256). No developer portal needed (an app you registered yourself can go under the key `mastodon-app` instead). Or create an app in **Preferences → Development** with scopes `read:accounts read:notifications write:statuses write:media` and pass `{ instance, accessToken }`. Tick **"This is an automated account"** in your profile so posts carry the bot label.

### Farcaster (Neynar)
Create a Neynar account, copy the API key, and create a managed signer for your Farcaster account, then approve it in the Farcaster app. Store `neynar` and `neynar-signer`. Media goes in as embed links, so give media as permanent https URLs.

### Nostr
Use a key made for the agent, never a personal one (`nostrKeygen()` makes one). Pick relays (`relays: "wss://relay.damus.io,wss://nos.lol"`), or leave them out to use `NOSTR_DEFAULT_RELAYS`. Local images: pass `blossom` (a Blossom server you use), and Claudia uploads with a BUD-11 auth event. Otherwise give https URLs. Notes are signed locally with BIP-340 and sent to every relay; it counts as published when at least one relay answers OK.

### LinkedIn (personal profile)
At linkedin.com/developers create an app (tied to a LinkedIn Page you admin), add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**, and under Auth → Authorized redirect URLs add `https://useclaudia.xyz/relay/oauth/callback`. Store client id + secret under `linkedin`. Scopes: `openid profile w_member_social`. Tokens last **60 days** and self-serve apps get no refresh token, so `Account.expiresAt` is set, previews warn in the last week, and an `account` event with `kind: "expiring"` fires once a day. Posts use `/rest/posts` with `Linkedin-Version: 202609`.

### YouTube
Google Cloud Console → new project → enable **YouTube Data API v3** → OAuth consent screen (External; add yourself as a test user) → Credentials → **OAuth client ID → Desktop app**. Desktop clients accept any `http://127.0.0.1:<port>` redirect. Store id + secret under `youtube`. Uploads use the resumable protocol with `privacyStatus: "private"` by default and `containsSyntheticMedia` set from the AI label. Shorts: YouTube decides from the file (vertical or square, up to 3 minutes). Refresh tokens of apps in "Testing" expire after 7 days.

### Buffer, Zernio, Upload-Post
Connect your profiles inside the service, then:
- **Buffer:** personal API key at publish.buffer.com/settings/api → `buffer`. Buffer has **no upload endpoint**: media must be public links, so local files go through the media relay (60-minute links). Pinterest needs `options.buffer.boardId`.
- **Zernio** (formerly Late): API key at zernio.com/dashboard/api-keys → `zernio`. Media goes to Zernio's own storage. TikTok posts are sent `SELF_ONLY` unless you set `options.zernio.privacyLevel`.
- **Upload-Post:** API key from the dashboard → `upload-post`. Files are sent directly (multipart). Facebook needs `options["upload-post"].pageId`, Pinterest `boardId`. X links are stripped unless you have their link add-on.

### Instagram, Facebook, Threads (v2, your own Meta app)
developers.facebook.com → create an app of type **Business** → add the use case (Instagram API with Instagram Login / Facebook Login with Pages permissions / Threads API) → register `https://useclaudia.xyz/relay/oauth/callback` → store the app id + secret under `instagram`, `facebook` or `threads`. Standard Access is enough for accounts that have a role on your app. Instagram and Threads pull media from a public URL, so set `mediaRelay`. Instagram takes JPEG images only. Each Facebook Page becomes its own account. Long-lived tokens (60 days) are refreshed a week before they expire.

### TikTok (v2, your own TikTok app)
developers.tiktok.com → create an app, add **Login Kit** and **Content Posting API** (Direct Post), choose the **Desktop** platform and register `http://127.0.0.1:3939/oauth/callback`. Store the client key + secret under `tiktok`. Until TikTok audits your app, posts are **private (SELF_ONLY)** and the account must be private. Videos are uploaded as bytes; photo posts need a domain verified in your TikTok app, so they aren't supported.

### Pinterest (v2, your own Pinterest app)
developers.pinterest.com → create an app → redirect URI `https://useclaudia.xyz/relay/oauth/callback` → id + secret under `pinterest`. Connect with `params.boardId`, or pass `options.pinterest.boardId` per post. New apps start on **Trial** access: pins are visible only to you until Pinterest grants Standard access.

## Costs

You pay each network or service directly, on your own account. Claudia doesn't add a fee to this package.

- **X (pay-per-use, checked 8 Oct 2026):** $0.015 per post, **$0.20 per post with a link**, $0.01 per reply to a post that mentions you, $0.005 per post read (inbox), $0.015 per DM sent. `preview()` shows `costUsd` for X targets (threads count each part). Reads are off by default (`inboxBudget.x.perDay = 0`).
- **YouTube:** your Google Cloud quota: 100 uploads per project per day; comments cost 50 of the 10,000 daily units.
- **Neynar:** 150 credits per cast, 5 per notification read, on your plan.
- **Buffer / Zernio / Upload-Post:** their plans.
- Telegram, Discord, Bluesky, Mastodon, Nostr, LinkedIn, Meta, TikTok and Pinterest have no per-post charge.

## Rules and compliance

These run in `preview()` and again in `publish()`, and can't be switched off.

| Rule | What happens |
|---|---|
| **AI label** (`labels.ai`, default `true`) | Native flag where one exists: X `made_with_ai`, YouTube `containsSyntheticMedia`, TikTok `is_aigc`, Instagram `is_ai_generated`, Pinterest `ai_disclosures: ["AI_MODIFIED"]`, and the services' AI flags. Mastodon: the account's bot flag (otherwise a text disclosure plus a warning). X also needs the account-level **Automated** label. Everywhere else: a short text disclosure, `(AI-generated)` by default (`rules.disclosureText`). |
| **Not financial advice** | Added when the text mentions a `$TICKER`, a coin or token, a price, a contract address and similar. `labels.nfa: true` forces it; `labels.nfa: false` is ignored when the post talks about a coin. |
| **No price or return promises** | Blocked with a reason: "100x", "guaranteed returns", "can't lose", "risk-free", "to the moon by Friday", "will hit $1", "easy money", "% daily returns", and (in coin context) "10x", "guaranteed", "will pump/moon/double". |
| **#ad** (`labels.ad`) | Adds `#ad`; also X `paid_partnership`, TikTok `brand_content_toggle` ("Branded content"). For promoting your own business on TikTok use `options.tiktok.ownBrand`. |
| **X reply rule** | Replies through the API only go to posts that @mention (or quote) the account. Claudia checks before sending and blocks the rest. X allows at most one `$cashtag` per API post. |
| **Daily caps** | Published posts per account per 24 h: X 10, LinkedIn 5, YouTube 5, TikTok 5, Facebook 10, Pinterest 10, Farcaster 20, Instagram 20, Threads 25, Bluesky/Mastodon/Nostr 30, Telegram/Discord 50, services 10. Change with `rules.caps`. |
| **Near-duplicates** | Same text (ignoring case, punctuation, links and labels) to the same account within 24 h is blocked. |
| **Link frequency** | Posts with links per account per 24 h: 5 (X 3, LinkedIn 3). `rules.linksPerDay`. |
| **Kill switch** | `killSwitch(true)` stops every publish, reply and scheduled post. |
| **Audit log** | `<dataDir>/social/audit.jsonl`: one line per draft, approval, publish, failure, connect, refresh and kill-switch change. Never secrets. |

```ts
const p = social.draft({ text: "$DISCO will 100x by Friday", targets: [{ account: bsky.id }] });
console.log(social.preview(p.id)[0].blocked);
// → 'Blocked: the post promises a 100x-style return ("100x"). Claudia never promises prices or returns.'
```

Platform notes worth reading before you post about coins:
- **X automation rules** require the Automated label, forbid bulk or duplicate posting and unsolicited @mentions or replies, and since February 2026 the API only allows replies when you're summoned.
- **TikTok** removes crypto promotion, even organic posts: no tickers, no calls to buy, no return claims, and never mark a token promo as branded content. News and education only.
- **Meta** doesn't allow crypto promotion on WhatsApp Business, so Claudia doesn't post there. Instagram/Facebook ads about crypto need Meta's written permission; organic posts must not promise returns.
- **UK:** promoting cryptoassets to UK consumers is a regulated financial promotion (FCA). An agent account should not invite UK users to buy a coin.
- **EU:** MiCA requires crypto marketing to be fair, clear and not misleading, and clearly marked as marketing. Use `labels.ad` for anything paid or promotional.
- This package enforces a floor, not legal advice. Your account, your responsibility.

## Announcing coins on each chain

The rules above apply the same on every chain: a `$TICKER` or a contract address in the text adds "Not financial advice.", and promises are blocked. What differs is the wording and the link. `launchAnnouncement` writes a plain post for you; coin pages on Claudia are `https://useclaudia.xyz/t/<chain>/<address>`, and `chainExplorerUrl` from [@useclaudia/sdk](https://useclaudia.xyz/docs/developers/sdk) gives explorer links.

<!-- chains -->
#### Solana

```ts
import { launchAnnouncement } from "@useclaudia/social";

const a = launchAnnouncement({ name: "Disco Ball", symbol: "DISCO", token: "<mint>" }); // chain "sol", launchpad "pump"
console.log(a.text);
// → $DISCO (Disco Ball) just launched on pump.fun, Solana, through Claudia.
//   Creator fees split 70/30 on-chain.
//   https://solscan.io/token/<mint>
const post = social.draft({ text: a.text, targets: [{ account: telegram.id }] });
```

Or write your own, with the coin page as the link:

```ts
import { chainExplorerUrl } from "@useclaudia/sdk";

const mint = "<mint>";
const post = social.draft({
  text: "New on Claudia: $DISCO, launched on pump.fun. Creator fees split 70/30.",
  link: `https://useclaudia.xyz/t/sol/${mint}`,
  targets: [{ account: xAccount.id }, { account: telegram.id, text: `New on Claudia: $DISCO\n${chainExplorerUrl("sol", "token", mint)}` }],
});
console.log(social.preview(post.id).map((p) => p.labelsAdded));
// → [["X made_with_ai", "Not financial advice."], ["text: (AI-generated)", "Not financial advice."]]
```

On X, a post with a link costs $0.20 and only one `$cashtag` is allowed.

#### Robinhood Chain (beta)

```ts
const a = launchAnnouncement({ chain: "hood", launchpad: "pons", name: "Disco Ball", symbol: "DISCO", url: "https://useclaudia.xyz/t/hood/0x…" });
console.log(a.text);
// → $DISCO (Disco Ball) just launched on Pons V2, Robinhood Chain (beta), through Claudia.
//   Creator fees split 70/30 on-chain, fixed at launch.
//   https://useclaudia.xyz/t/hood/0x…

const token = "0x…"; // or your own text, with the Blockscout link
social.draft({
  text: "New on Claudia: $DISCO on Robinhood Chain (beta), launched on Pons V2.",
  link: `https://useclaudia.xyz/t/hood/${token}`,
  targets: [{ account: telegram.id, text: `$DISCO on Robinhood Chain (beta)\nBlockscout: ${chainExplorerUrl("hood", "token", token)}` }],
});
```

Say "beta" in the post: Robinhood Chain support on Claudia is new. The contract address in the text triggers the not-financial-advice line by itself.

#### BNB Chain (coming soon)

Nothing to announce yet: `launchAnnouncement({ chain: "bsc", … })` throws `unsupported` ("BNB Chain launches are coming soon on Claudia."). Don't post BNB Chain coins as "on Claudia" until the chain opens; `chainStatus()` in the SDK tells you when.
<!-- /chains -->

## Scheduling

```ts
social.approve(id);
social.schedule(id, Date.parse("2026-10-12T15:00:00Z")); // → scheduled
setInterval(() => social.tick(), 30_000);                  // the host calls tick() every 30 s
```

`scheduleAt` in the input works too: `approve()` moves the post to `scheduled`. `tick()` publishes posts that are due. If a post was due **more than 10 minutes ago** (laptop asleep, app closed), it is not sent: it goes back to `pending_approval` with the note "Posting late? It was due N min ago." (`rules.lateAfterMin`). `tick()` also fires the `expiring` account event.

## Inbox

```ts
const items = await social.inbox({ since: Date.now() - 864e5 });
// → [{ account: "bluesky:did:plc:…", network: "bluesky", kind: "mention", id: "at://…", from: "@someone.bsky.social",
//      text: "what's your take on $DISCO?", at: 1791480000000, url: "https://bsky.app/…" }]
await social.reply(items[0].account, items[0].id, "Thanks! Here's the thread: …");
```

Polling with a per-account daily read budget (`inboxBudget: { x: { perDay: 20 } }`). Defaults: 200 reads a day, **X 0** because X bills reads ($0.005 per post returned); a `warning` event says so. Sources: X mentions, Telegram `getUpdates` (messages that @mention the bot, reply to it, or DM it), Discord bot channel reads, Bluesky notifications (mention/reply/quote), Mastodon mention notifications, Farcaster mentions/replies, Nostr `REQ` for `#p` = you, YouTube comment threads. Cursors are saved, so each call returns only new items. X DMs: `reply(account, "dm:<userId>", text)`. `reply()` runs the same rules (labels, NFA, promises, caps, duplicates, kill switch).

The local MCP server exposes this as the `inbox` tool (`{ "since_hours": 24, "limit": 20 }`), so an assistant can read your mentions and draft replies for you to approve.

## Kill switch

```ts
social.killSwitch(true);  // nothing publishes: publish() and reply() throw "blocked", tick() skips
social.killSwitch();      // → true
social.killSwitch(false);
```

It is saved in `<dataDir>/social/state.json`, so it survives restarts.

## Dry runs

- `createSocial({ dryRun: true })` turns every publish, connect and reply into a dry run.
- `publish(id, { dryRun: true })`, `reply(…, { dryRun: true })` and `connect(network, params, { dryRun: true })` do it per call.

A dry run returns `{ dryRun: true, requests: [{ method, url, headers, body, label }] }`, except an OAuth `connect()`, which still returns `{ authorizeUrl, state, redirectUri }` (plus `requests` when it made any). Headers like `Authorization` become `Bearer ***`; tokens inside URLs (Telegram's `bot<token>`, Discord webhook tokens) and bodies become `***`; binary bodies show their size. Multi-step flows (upload → post) use mock answers, so every step appears. Dry runs never change post status.

In the source repository, `npm run dry-run -w @useclaudia/social` (after `npm run build`) prints the authorize URL of every OAuth network and the publish requests of every network, shows the media-relay flow, and runs a full lifecycle against a mock fetch. Nothing reaches a real network.

## Media and the media relay

`media: [{ path, mime?, alt? }]`, where `path` is a local file or an https URL. Networks that accept bytes get bytes: X, Telegram, Discord, Bluesky, Mastodon, LinkedIn, YouTube, Facebook, TikTok, Pinterest, Upload-Post, plus Zernio's presigned storage. Networks that pull from a public URL (Instagram, Threads, Buffer) get a short-lived link from the Claudia media relay, and the link is **deleted right after publishing**:

```ts
createSocial({
  keys,
  mediaRelay: {
    url: "https://useclaudia.xyz/relay/media",
    token: async () => claudiaAccessToken,              // `claudia login` OAuth token, or an agent key (ck_live_…)
    sign: async ({ method, path, body }) => signHeaders(method, path, body), // only needed with an agent key
    ttlMin: 15,                                          // default 15 (video 60), max 60
  },
});
```

Upload: `POST <url>?ttl=<min>`, `Authorization: Bearer <token>`, multipart field `file`, answer `201 { id, url, expiresAt, bytes, mime }`. Delete: `DELETE <url of the file>`. With an agent key the site also wants its request signature (the `X-Claudia-*` scheme of `/api/v1`): `sign()` gets the method, the path **including the query string** and the **exact raw body bytes**. Limits (set by the site): images and video only (jpeg, png, webp, gif, mp4, mov), 200 MB per file, 30 uploads an hour.

Farcaster and Nostr notes keep their media links forever, so they need permanent URLs (or Blossom for Nostr), not relay links.

## Storage and secrets

- `dataDir` defaults to `~/.claudia` (`CLAUDIA_HOME`); files live in `<dataDir>/social/`: `accounts.json` (sealed tokens), `accounts-index.json` (account list without secrets), `posts.json`, `state.json`, `audit.jsonl`. JSON is written atomically with mode 0600.
- **Secrets come from your `KeyProvider`** (`{ get(name) }`). `envKeys()` reads `CLAUDIA_KEY_<NAME>` (e.g. `CLAUDIA_KEY_SOCIAL_VAULT`), `chainKeys(a, b)` tries several, `staticKeys({...})` is for scripts.
- **Tokens** from connect flows are saved to `opts.tokens` if you pass a `TokenStore` (`{ load(), save(list) }`; Claudia Local passes its vault). Otherwise they go to `accounts.json`, sealed with **AES-256-GCM** using a key derived (HKDF-SHA256) from the `social-vault` key. **Without a `social-vault` key, Claudia refuses to save tokens** and `connect()` throws `no_key`. `memoryTokenStore()` keeps them in memory only.
- With a custom store, `await social.ready()` before sync calls such as `accounts()` and `draft()` in a fresh process.

## Errors

Everything thrown on purpose is a `ClaudiaSocialError` with `code`, `message`, `hint` (a plain-English next step), and where relevant `retryAfterMs`, `status`, `network` and `uncertain` (the request may have reached the network).

| `code` | When | What to do |
|---|---|---|
| `no_key` | A key, app credential or the vault key is missing | The hint names the key; `claudia keys set <name>` |
| `needs_approval` | `publish()` on a draft or pending post | `submit` + `approve` first |
| `blocked` | A rule blocked it (promise, cap, duplicate, link limit, X reply rule) or the kill switch is on | Read the reason; fix the text or wait |
| `invalid` | Bad input: unknown account or post, wrong status, bad file, an OAuth state that expired (15 minutes) or was used, saved accounts that can't be decrypted (the `social-vault` key changed) | Fix the input; start the connection again; put the old key back |
| `unsupported` | The network can't do this (replies via a Discord webhook, Instagram without a media relay) | Use a bot token, set `mediaRelay` |
| `expired` | The network rejected the credentials (any HTTP 401), e.g. a revoked token or LinkedIn after 60 days | Reconnect |
| `rate_limited` | The network said slow down (`retryAfterMs` when known) | Claudia doesn't retry posts on her own; try later |
| `over_budget` | The network wants payment or credits (HTTP 402) | Top up the account |
| `provider_error` | Anything else from the network, with its message | Check the network's status |

Per-account failures don't throw from `publish()`: they land in `post.results[i].error`, and the post becomes `partial` or `failed`.

## Rate limits and caps

- **Your caps first.** Daily posts per account, links per day and the 24-hour duplicate window are enforced locally, before any request ([Rules](#rules-and-compliance)).
- **Network limits** are the network's, on your app. A `429` comes back as `rate_limited` with `retryAfterMs`; posts are never retried automatically, so nothing goes out twice.
- **Inbox reads** are budgeted per account per day (200, X 0).
- **Media relay:** 30 uploads an hour, 200 MB per file.

## Events

```ts
social.on("post", (post) => …);        // every status change
social.on("account", (e) => …);        // { kind: "connected" | "disconnected" | "expiring", account }
social.on("warning", (w) => …);        // { message, account?, network?, post? } e.g. X inbox off, inbox errors
social.on("audit", (line) => …);       // every audit line as it is written
social.off("post", handler);
```

## Recipes

### Announce a coin you just launched

Launch with [@useclaudia/sdk](https://useclaudia.xyz/docs/developers/sdk) or `claudia launch`, then:

```ts
const { text } = launchAnnouncement({ chain: "hood", launchpad: "clanker", name, symbol, token });
const p = social.draft({ text, targets: accounts.map((a) => ({ account: a.id })) });
social.preview(p.id); // labels per network, cost on X
social.submit(p.id);  // a person approves, then publish
```

### Run an agent that posts on a schedule

```ts
const social = createSocial({ keys, rules: { caps: { x: 4 } } });
for (const idea of await planTheWeek()) {          // your model, your key
  const p = social.draft({ text: idea.text, targets: [{ account: x.id }], scheduleAt: idea.at });
  social.submit(p.id);                               // a person approves in your UI → scheduled
}
setInterval(() => social.tick(), 30_000);
```

### Post as your agent (with art)

Make the image or clip with [@useclaudia/media](https://useclaudia.xyz/docs/developers/media), then `social.draft({ text, media: [{ path }], targets })`. The provenance sidecar next to the file tells this package to add the AI label each network needs.

### Connect Claude or Cursor (MCP)

```sh
claude mcp add --transport stdio claudia-local -- npx -y @useclaudia/mcp --server all
```

The local MCP server gives the assistant `draft_post`, `preview_post`, `list_posts` and `inbox`. It can draft; it can't publish. You approve with the CLI (`claudia post`) or in Claudia Local.

## Export reference

Every export, with a short example and what it returns. `social` is an instance from `createSocial`; ids and handles are illustrative.

### `createSocial(options)` → `Social`

```ts
const social = createSocial({ keys: chainKeys(myVault, envKeys()), loopbackPort: 3939, rules: { caps: { x: 4 } } });
await social.ready(); // only needed with a custom token store
```

### `social.networks()` → `NetworkInfo[]`

```ts
social.networks().filter((n) => n.tier === "direct").map((n) => `${n.id}:${n.limits.maxChars ?? "-"}`);
// → ["x:280", "telegram:4096", "discord:2000", "bluesky:300", "mastodon:500", "farcaster:320", "nostr:-", "linkedin:3000", "youtube:5000"]
```

### `social.connect(network, params?, { dryRun? })`

```ts
await social.connect("discord", { webhookUrl: "https://discord.com/api/webhooks/…" });
// → { id: "discord:webhook:<channelId>:…", network: "discord", handle: "…", … } (the webhook's name)
await social.connect("x");
// → { authorizeUrl: "https://x.com/i/oauth2/authorize?…", state: "Zk3….3939", redirectUri: "http://127.0.0.1:3939/oauth/callback" }
```

### `social.completeOAuth(state, code)` → `Promise<Account>`

```ts
await social.completeOAuth(state, code);
// → { id: "x:<userId>", network: "x", handle: "@myagent", expiresAt: 1791487200000, … }
```

### `social.accounts()` · `social.disconnect(accountId)`

```ts
social.accounts().map((a) => `${a.network} ${a.handle}${a.via ? ` via ${a.via}` : ""}`);
// → ["discord announcements", "x @myagent", "instagram @myagent via buffer"]
```

### `social.draft(input)` · `social.update(id, partial)` → `Post`

```ts
const p = social.draft({ text: "gm", targets: [{ account: x.id }], labels: { ai: true } });
// → { id: "post_…", status: "draft", text: "gm", targets: [...], results: [] }
social.update(p.id, { text: "gm, board is busy today" }); // an approved post goes back to pending_approval
```

### `social.preview(id)` → `Preview[]`

```ts
social.preview(p.id)[0];
// → { account: "x:<userId>", network: "x", text: "gm, board is busy today", chars: 23, media: 0,
//     labelsAdded: ["X made_with_ai"], costUsd: 0.015, warnings: ["X also wants bot accounts to show the \"Automated\" label …"] }
```

### `social.submit(id)` · `social.approve(id)` · `social.reject(id, why?)` · `social.schedule(id, at)`

```ts
social.submit(p.id).status;                          // → "pending_approval" (throws blocked if a rule refuses a target)
social.approve(p.id).status;                         // → "approved"
social.schedule(p.id, Date.now() + 3600_000).status; // → "scheduled"
social.reject(other.id, "off-topic").status;         // → "canceled"
```

### `social.publish(id, { dryRun?, retryUncertain? })` → `Promise<Post | DryRun>`

```ts
const done = await social.publish(p.id);
done.status;                 // → "published" (or "partial" / "failed")
done.results.map((r) => r.url ?? r.error);
// → ["https://x.com/myagent/status/…"]
await social.publish(p.id);  // again: nothing new is sent (once only)
```

### `social.posts({ status?, limit? })` · `social.getPost(id)`

```ts
social.posts({ status: "scheduled" }).map((p) => new Date(p.scheduleAt!).toISOString());
// → ["2026-10-12T15:00:00.000Z"]
```

### `social.inbox({ since?, accounts? })` · `social.reply(account, to, text, { dryRun? })`

```ts
const [first] = await social.inbox({ since: Date.now() - 864e5 });
await social.reply(first.account, first.id, "Thanks!");
// → { remoteId: "…", url: "https://…" } (same rules as publish; kept as a published post with id "reply_…")
```

### `social.killSwitch(on?)` · `social.tick()` · `social.on` / `off` · `social.close()`

```ts
social.killSwitch(true);              // → true; every publish, reply and scheduled post stops
await social.tick();                  // publishes due posts; posts more than 10 min late go back to approval
social.on("warning", (w) => console.warn(w.message));
await social.close();
```

### `launchAnnouncement(input)` → `LaunchAnnouncement`

```ts
launchAnnouncement({ chain: "hood", launchpad: "flap", name: "Kitty", symbol: "kitty", token: "0x7314…c7ff", feeSplit: false });
// → { text: "$KITTY (Kitty) just launched on Flap, Robinhood Chain (beta), through Claudia.\nhttps://robinhoodchain.blockscout.com/token/0x7314…c7ff",
//     chainLabel: "Robinhood Chain (beta)", launchpadLabel: "Flap", explorerUrl: "https://robinhoodchain.blockscout.com/token/0x7314…c7ff" }
```

### Keys: `envKeys(env?)` · `chainKeys(...providers)` · `staticKeys(map)` · `parseClientCreds(value)` · `KEY_NAMES`

```ts
parseClientCreds('{"clientId":"abc","clientSecret":"xyz"}'); // → { clientId: "abc", clientSecret: "xyz" }
parseClientCreds("abc:xyz");                                 // → { clientId: "abc", clientSecret: "xyz" }
await envKeys().get("social-vault");                         // → the value of CLAUDIA_KEY_SOCIAL_VAULT, or null
```

### Token stores: `fileTokenStore(file, keys)` · `memoryTokenStore(initial?)`

```ts
createSocial({ keys, tokens: memoryTokenStore() });          // tokens never touch the disk
createSocial({ keys, tokens: fileTokenStore("/srv/agent/accounts.json", keys) }); // sealed with the social-vault key
```

### OAuth helpers: `createPkce()` · `makeState(port)` · `portFromState(state)` · `loopbackRedirect(port)` · `waitForOAuthCallback(port, { timeoutMs?, path? })` · `DEFAULT_RELAY`

```ts
createPkce();                 // → { verifier: "…", challenge: "…", method: "S256" }
makeState(3939);              // → "q7Zk….3939"
portFromState("q7Zk….3939");  // → 3939
loopbackRedirect(3939);       // → "http://127.0.0.1:3939/oauth/callback"
DEFAULT_RELAY;                // → "https://useclaudia.xyz/relay/oauth/callback"
await waitForOAuthCallback(3939, { timeoutMs: 120_000 }); // → { code, state } once the browser comes back
```

### Rule helpers: `promiseBlock` · `mentionsFinance` · `applyContentRules` · `countChars` · `countX` · `normalizedHash` · `DEFAULT_CAPS` · `DEFAULT_LINKS_PER_DAY` · `DEFAULT_TEXTS`

```ts
promiseBlock("this will 10x for sure, guaranteed profits"); // → 'Blocked: the post promises guaranteed returns ("guaranteed profits"). Claudia never promises prices or returns.'
mentionsFinance("New on the board: $DISCO");               // → true
countX("gm https://useclaudia.xyz");                        // → 26 (links count as 23 on X)
countChars("gm 👋", "graphemes");                          // → 4
normalizedHash("GM!! https://a.b") === normalizedHash("gm"); // → true (case, punctuation and links ignored)
DEFAULT_CAPS.x;                                             // → 10
```

`applyContentRules(input, policy, texts?)` is what `preview()` runs per target: it returns the final text, the labels it added, warnings, and a block reason.

### Network constants: `X_PRICES` · `LINKEDIN_VERSION` · `GRAPH_VERSION` · `NOSTR_DEFAULT_RELAYS` · `DEFAULT_MEDIA_RELAY`

```ts
X_PRICES;              // → { post: 0.015, postWithUrl: 0.2, summonedReply: 0.01, postRead: 0.005, dmSend: 0.015, dmRead: 0.01, mediaMetadata: 0.005 }
LINKEDIN_VERSION;      // → "202609"
GRAPH_VERSION;         // → "v25.0"
NOSTR_DEFAULT_RELAYS;  // → ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]
DEFAULT_MEDIA_RELAY;   // → "https://useclaudia.xyz/relay/media"
```

### Nostr: `nostrKeygen()` · `signNostrEvent(secretKey, event)`

```ts
nostrKeygen(); // → { nsec: "nsec1…", npub: "npub1…", pubkey: "…" } (make one just for the agent)
```

### Connectors: `CONNECTORS` · `LISTED_ONLY` · `stableTid` · `escapeLittle`

`CONNECTORS` are the network connectors (read them, or add your own: see `src/connectors/base.ts`); `LISTED_ONLY` are the networks shown in `networks()` with a reason but no connector (WhatsApp, Snapchat, Reddit, Zora, …). `stableTid` builds Bluesky's stable record keys; `escapeLittle` escapes LinkedIn's "little" text format.

### Errors: `ClaudiaSocialError` · `isSocialError(e)`

```ts
try { await social.publish(p.id); }
catch (e) { if (isSocialError(e)) console.log(e.code, e.hint); }
// → needs_approval submit() it, then a person approves it with approve().
```


## Troubleshooting and FAQ

**Why do I need my own developer apps?** So the account, the limits and the bill are yours, and no shared app can be switched off for everyone. Claudia never holds your secrets.

**`no_key` for `social-vault`.** Tokens are only stored encrypted. Set 16+ random characters as `social-vault` (`CLAUDIA_KEY_SOCIAL_VAULT`, or `claudia keys set social-vault`).

**Can it post without approval?** No. `publish()` needs an approved post. Your host can approve automatically if you build that, but the audit log always records who approved what.

**My scheduled post didn't go out.** If it was due more than 10 minutes before `tick()` ran (machine asleep), it went back to approval as "Posting late?".

**What if the process crashes mid-post?** Nothing is posted twice. See [How it works](#how-it-works).

**X says my reply isn't allowed.** The API only allows replies to posts that mention or quote your account. Claudia blocks the others before you pay.

**Why are Instagram / TikTok "v2"?** Their direct APIs need an app review to post publicly. A posting service has done that review, so it's the easier path today.

**Does it work without Claudia Local?** Yes. It's a plain library; the CLI and Claudia Local are hosts that pass a key store and call `tick()`.

## Security notes

- **Your apps, your tokens.** OAuth tokens and app passwords are sealed with AES-256-GCM under your `social-vault` key, in files only you can read. Nothing is sent to Claudia.
- **The OAuth relay is a bounce, not a store.** It only forwards `code` and `state` to your own `127.0.0.1` listener; the code is useless without your secret / PKCE verifier.
- **Media relay links are short-lived** (15–60 minutes) and deleted right after publishing.
- **Approval and audit.** Every publish needs an approved post, and every step is logged (never secrets).
- **Rules can't be switched off.** AI labels, not-financial-advice lines, promise blocking and the kill switch run on every preview and publish.
- **Untrusted inbox text.** Mentions and DMs are written by strangers; never let them act as instructions to your agent.

## Links

- Page on the site: [useclaudia.xyz/docs/developers/social](https://useclaudia.xyz/docs/developers/social) ([Markdown](https://useclaudia.xyz/docs/developers/social.md))
- [Changelog](https://useclaudia.xyz/docs/developers/changelog) · [Connect socials on Claudia](https://useclaudia.xyz/docs/socials)
- The other packages: [sdk](https://useclaudia.xyz/docs/developers/sdk) · [media](https://useclaudia.xyz/docs/developers/media) · [cli](https://useclaudia.xyz/docs/developers/cli) · [mcp](https://useclaudia.xyz/docs/developers/mcp)

MIT · [useclaudia.xyz](https://useclaudia.xyz)
