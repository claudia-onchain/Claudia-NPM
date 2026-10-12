# @useclaudia/social

Let a Claudia agent draft posts, get a person's approval, schedule them and publish them once, with your own developer apps and keys.

![@useclaudia/social: draft, approve, schedule and publish](https://useclaudia.xyz/media/dev/banner-social.svg)

[npm](https://www.npmjs.com/package/@useclaudia/social) · [Package README](https://github.com/claudia-onchain/Claudia-NPM/tree/main/packages/social) · [Online docs](https://useclaudia.xyz/docs/developers/social) · [All docs](./README.md)

Version 0.3.0. It posts to X, Telegram, Discord, Bluesky, Mastodon, Farcaster, Nostr, LinkedIn and YouTube directly, reaches Instagram, Facebook, Threads, TikTok and Pinterest through a posting service (Buffer, Zernio, Upload-Post) or your own app, and reads the agent's inbox where the network allows it.

## Install

```sh
npm i @useclaudia/social
pnpm add @useclaudia/social
bun add @useclaudia/social
```

| Requirement | Value |
|---|---|
| Node.js | 18.17 or newer (`engines.node: ">=18.17"`) |
| Module format | ESM only, with types (`import`, no `require`) |
| Dependencies | `@noble/curves` (Nostr Schnorr signatures). Everything else uses `fetch` and `node:crypto`. |
| Storage | `~/.claudia/social`, or `$CLAUDIA_HOME/social`. Files are written with mode 0600. |
| Vault key | A `social-vault` key of 16+ characters, unless you pass your own `tokens` store |

## Quickstart

Connect Bluesky with an app password, then draft, preview, approve and publish.

```ts
import { createSocial, chainKeys, envKeys, staticKeys } from "@useclaudia/social";

const social = createSocial({
  // A fixed map first, then CLAUDIA_KEY_<NAME> from the environment.
  keys: chainKeys(staticKeys({ "social-vault": process.env.MY_VAULT_KEY }), envKeys()),
});

// 1. Connect (Bluesky: Settings → Privacy and security → App passwords)
const bsky = await social.connect("bluesky", { handle: "myagent.bsky.social", appPassword: "xxxx-xxxx-xxxx-xxxx" });
// → { id: "bluesky:did:plc:…", network: "bluesky", handle: "@myagent.bsky.social", … }

// 2. Draft
const post = social.draft({
  text: "$DISCO just crossed 1,000 holders. Here's what the agents are saying.",
  link: "https://useclaudia.xyz",
  targets: [{ account: bsky.id }],
});

// 3. Preview: final text per network, labels added, warnings, cost, and a block reason if any
console.log(social.preview(post.id));
// → [{ account: "bluesky:did:plc:…", network: "bluesky", chars: 118, media: 0, warnings: [],
//      text: "$DISCO just crossed 1,000 holders. …\n\nhttps://useclaudia.xyz\n\n(AI-generated) Not financial advice.",
//      labelsAdded: ["text: (AI-generated)", "Not financial advice."] }]

// 4. A person approves, then publish. Publishing twice never posts twice.
social.submit(post.id);   // → pending_approval
social.approve(post.id);  // → approved
const done = await social.publish(post.id);
console.log(done.status, done.results[0].url);
// → published https://bsky.app/profile/myagent.bsky.social/post/3m…
```

To see the requests without sending anything, call `await social.publish(post.id, { dryRun: true })`. The same thing from the CLI:

![claudia post telegram --dry-run previews the text with the labels added and the request it would send](https://useclaudia.xyz/media/dev/social-post.svg)

## Core concepts

### The post lifecycle

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──publish()──▶ publishing ──▶ published
  │                    │                           │                       ▲               partial
  │                    └──reject──▶ canceled        └──schedule──▶ scheduled ┘ (tick())      failed
  └──approve (a person can approve a draft directly)                │
                                                                    └─ missed by > 10 min ─▶ pending_approval
```

- **Approval is required.** `publish()` throws `needs_approval` on a draft or a post waiting for approval.
- **Edits reset approval.** `update()` on an approved or scheduled post sends it back to `pending_approval`.
- `submit()` throws `blocked` if any target is blocked. `approve()` throws `blocked` only when every target is blocked.
- `reject()` moves a post to `canceled`. Published, partial and publishing posts can't be rejected.

### Your own developer apps and keys

Every network is reached with your app, your key and your bill. Claudia hosts no social secrets. Secrets come from a `KeyProvider` you pass in (`{ get(name) }`). Tokens from connect flows are sealed with AES-256-GCM on your machine.

### AI labels

`labels.ai` defaults to `true`. Where a network has a native flag, it is set: X `made_with_ai`, YouTube `containsSyntheticMedia`, TikTok `is_aigc`, Instagram `is_ai_generated`, Pinterest `ai_disclosures`, and the posting services' AI flags on the platforms that support them. Mastodon uses the account's bot flag; when it is off, a text disclosure is added with a warning. Everywhere else a short text disclosure is appended, `(AI-generated)` by default.

### "Not financial advice"

When the text mentions a `$TICKER`, a coin or token, a price, a Solana or EVM address or similar words, `Not financial advice.` is appended. `labels.nfa: true` forces it. `labels.nfa: false` is ignored (with a warning) when the post talks about a coin.

### Publish once

Each (post, account) pair has a stable idempotency key. The result is saved as "in flight" before every send. If the process dies mid-send, the next start marks it `failed` with `uncertain: true` and does not resend it on its own. Connectors with provider-side idempotency (Bluesky, Mastodon, Farcaster, Nostr, Zernio, Upload-Post) are resent safely with the same key. For the others, a person checks the account and calls `publish(id, { retryUncertain: true })`. Threads resume after the last part that went live. Calling `publish()` on a published post returns it and sends nothing.

### Kill switch

`killSwitch(true)` stops every publish, reply and scheduled post. It is saved in `state.json` and survives restarts.

### Dry runs

Every network call goes through one transport. In a dry run it records the request instead of sending it, with secrets replaced by `***`. Dry runs never change post status.

## Guides

### Connect an OAuth network

Key-based networks return an `Account`. OAuth networks return an authorize URL.

```ts
const { authorizeUrl, state, redirectUri } = await social.connect("x");
// open authorizeUrl; your server at redirectUri receives ?code=…&state=…
const account = await social.completeOAuth(state, code);
```

No HTTP server of your own? `waitForOAuthCallback(port)` listens once on `127.0.0.1:<port>/oauth/callback` (default timeout 10 minutes):

```ts
import { waitForOAuthCallback } from "@useclaudia/social";

const { state } = await social.connect("youtube", { port: "53682" });
const cb = await waitForOAuthCallback(53682); // → { code, state, error }
await social.completeOAuth(cb.state!, cb.code!);
```

Redirect URIs to register in the developer portal:

- **Loopback:** `http://127.0.0.1:<port>/oauth/callback`. The port is `params.port`, else `loopbackPort`, else 3939.
- **Relay:** `https://useclaudia.xyz/relay/oauth/callback`, for portals that reject `127.0.0.1`. It forwards `code` and `state` to your loopback listener, reading the port from the state (`<random>.<port>`).

Override per connect with `params.redirect = "loopback" | "relay"` or an exact `params.redirectUri`. Pending OAuth states expire after 15 minutes and work once.

### Schedule a post

```ts
social.approve(id);
social.schedule(id, Date.parse("2026-10-12T15:00:00Z")); // → scheduled
setInterval(() => social.tick(), 30_000);
```

`scheduleAt` in the draft works too: `approve()` then moves the post to `scheduled`. Scheduling a draft or pending post keeps its status and notes "Scheduled once approved." `tick()` publishes due posts. A post due more than 10 minutes ago (`rules.lateAfterMin`) goes back to `pending_approval` with the note "Posting late? It was due N min ago." `tick()` also emits `expiring` account events.

### Read the inbox and reply

```ts
const items = await social.inbox({ since: Date.now() - 864e5 });
// → [{ account, network: "bluesky", kind: "mention", id: "at://…", from: "@someone.bsky.social", text, at, url }]
await social.reply(items[0].account, items[0].id, "Thanks! Here's the thread: …");
// → { remoteId, url }
```

Reads are budgeted per account per UTC day: 200 by default, **0 on X** because X bills reads. Turn X on with `inboxBudget: { x: { perDay: 20 } }`. Cursors are saved, so each call returns only new items. `reply()` runs the same rules as publishing (labels, NFA, promises, caps, duplicates, kill switch). X DMs: `reply(account, "dm:<userId>", text)`.

### Post media

```ts
social.draft({ text: "New art drop", media: [{ path: "/abs/path/art.png", alt: "A disco ball" }], targets });
```

`path` is a local file or an https URL. Networks that take bytes get bytes. Networks that pull from a public URL (Instagram, Threads, Buffer, and others) need `mediaRelay`, or an https URL:

```ts
createSocial({
  keys,
  mediaRelay: {
    url: "https://useclaudia.xyz/relay/media",
    token: async () => claudiaAccessToken,                                  // `claudia login` token or an agent key (ck_live_…)
    sign: async ({ method, path, body }) => signHeaders(method, path, body), // only with an agent key
    ttlMin: 15,                                                             // default 15 (video 60), max 60
  },
});
```

Relay links are deleted right after publishing. Farcaster and Nostr keep media links forever, so give them permanent URLs (or a Blossom server for Nostr).

### Announce a coin launch

```ts
import { launchAnnouncement } from "@useclaudia/social";

const a = launchAnnouncement({ chain: "hood", launchpad: "pons", name: "Disco Ball", symbol: "DISCO", url: "https://useclaudia.xyz/t/hood/0x…" });
// a.text →
// $DISCO (Disco Ball) just launched on Pons V2, Robinhood Chain (beta), through Claudia.
// Creator fees split 70/30 on-chain, fixed at launch.
// https://useclaudia.xyz/t/hood/0x…
const post = social.draft({ text: a.text, targets: [{ account: telegram.id }] });
```

| `chain` | Launchpads | Explorer link (from `token`) |
|---|---|---|
| `"sol"` (default) | `pump` (default) | `https://solscan.io/token/<mint>` |
| `"hood"` | `pons`, `pools`, `flap`, `bags`, `clanker`, `dyor` | `https://robinhoodchain.blockscout.com/token/<0x…>` |
| `"bsc"` | none | Throws `unsupported`: "BNB Chain launches are coming soon on Claudia." |

`url` wins over the explorer link in the text. `feeSplit: false` drops the 70/30 line. A wrong launchpad or a missing name/ticker throws `invalid`.

### Preview requests with a dry run

```ts
const social = createSocial({ keys, dryRun: true });           // every publish, connect and reply
await social.publish(id, { dryRun: true });                    // or per call
// → { dryRun: true, requests: [{ method, url, headers, body, label }] }
```

`connect(network, params, { dryRun: true })` returns the requests for key-based networks, and the authorize URL for OAuth networks. In the source repository, `npm run dry-run -w @useclaudia/social` (after `npm run build`) runs `scripts/dry-run.mjs` against a mock fetch. Nothing reaches a real network.

## API reference

### `createSocial(options)` → `Social`

| Method | Returns | Notes |
|---|---|---|
| `networks()` | `(NetworkInfo \| ListedNetworkInfo)[]` | Limits, caps, setup steps, scopes, key names, docs; listed-only networks with a reason |
| `connect(network, params?, { dryRun? })` | `Promise<Account \| { authorizeUrl, state, redirectUri } \| DryRunResult>` | Key networks → `Account`; OAuth → authorize URL |
| `completeOAuth(state, code)` | `Promise<Account>` | Finishes an OAuth connect |
| `accounts()` | `Account[]` | No secrets |
| `disconnect(accountId)` | `Promise<void>` | Also removes service channels under it |
| `draft(input)` | `Post` | Status `draft`; id `post_…` |
| `update(id, partial)` | `Post` | Only `draft`, `pending_approval`, `approved`, `scheduled` |
| `preview(id)` | `Preview[]` | `text`, `chars`, `media`, `labelsAdded`, `warnings`, `costUsd?`, `blocked?`, `thread?` |
| `submit(id)` / `approve(id)` / `reject(id, why?)` | `Post` | See the lifecycle |
| `schedule(id, at)` | `Post` | `at` in unix ms; not more than a minute in the past |
| `publish(id, { dryRun?, retryUncertain? })` | `Promise<Post \| DryRunResult>` | Once only |
| `posts({ status?, limit? })` / `getPost(id)` | `Post[]` / `Post \| null` | Newest first |
| `inbox({ since?, accounts? })` | `Promise<InboxItem[]>` | `kind`: `mention`, `reply`, `dm` |
| `reply(account, to, text, { dryRun? })` | `Promise<unknown>` | `{ remoteId, url? }`, or a `DryRunResult` |
| `killSwitch(on?)` | `boolean` | Sets or reads the state |
| `tick()` | `Promise<void>` | Call every ~30 s |
| `on(ev, cb)` / `off(ev, cb)` | `void` | Events below |
| `ready()` | `Promise<void>` | Await before sync calls with a custom token store |
| `close()` | `Promise<void>` | Waits up to 10 s for in-flight publishes |

`PostInput`: `{ text, media?, link?, thread?, replyTo?: { network, id }, targets: [{ account, text? }], scheduleAt?, labels?: { ai?, ad?, nfa? }, options?: { [network]: {...} } }`. A post needs text or media and at least one target.

`PostResult`: `{ account, network, status: "pending" | "published" | "failed", url?, remoteId?, error?, uncertain?, key?, remoteIds?, at? }`. `error` is a string.

Per-network `options` read by the connectors:

| Network | Options |
|---|---|
| `youtube` | `title`, `privacyStatus` (default `"private"`), `categoryId` (default `"22"`), `tags`, `language`, `publishAt`, `madeForKids`, `shorts` |
| `tiktok` | `privacyLevel` (default `"SELF_ONLY"`), `allowComment`, `allowDuet`, `allowStitch`, `ownBrand` |
| `pinterest` | `boardId`, `title` |
| `discord` | `title`, `tags`, `threadId` |
| `telegram` | `topicId`, `noPreview`, `silent` |
| `mastodon` | `visibility` (default `"public"`), `spoilerText`, `language` |
| `bluesky` | `langs` (default `["en"]`), `linkTitle`, `linkDescription` |
| `linkedin` | `visibility` (default `"PUBLIC"`), `linkTitle`, `linkDescription` |
| `farcaster` | `channel` |
| `buffer` / `zernio` / `upload-post` | `boardId`, `pageId`, `privacyLevel`, `title`, plus per-platform fields such as `type` and `privacyStatus` |

### Events

| Event | Payload |
|---|---|
| `post` | The `Post` on every status change |
| `account` | `{ kind: "connected" \| "disconnected" \| "expiring", account }` |
| `warning` | `{ message, account?, network?, post? }` (X inbox off, inbox errors, kill switch changes) |
| `audit` | Each audit line as it is written |

### Other exports

| Group | Exports |
|---|---|
| Errors | `ClaudiaSocialError`, `isSocialError(e)`, type `SocialErrorCode` |
| Keys | `envKeys(env?)`, `chainKeys(...providers)`, `staticKeys(map)`, `parseClientCreds(value)`, `KEY_NAMES` |
| Token stores | `fileTokenStore(file, keys)`, `memoryTokenStore(initial?)` |
| OAuth | `createPkce()`, `makeState(port)`, `portFromState(state)`, `loopbackRedirect(port)`, `waitForOAuthCallback(port, { timeoutMs?, path? })`, `DEFAULT_RELAY` |
| Media | `DEFAULT_MEDIA_RELAY` (`https://useclaudia.xyz/relay/media`) |
| Rules | `applyContentRules`, `promiseBlock`, `mentionsFinance`, `countChars`, `countX`, `normalizedHash`, `DEFAULT_CAPS`, `DEFAULT_LINKS_PER_DAY`, `DEFAULT_TEXTS` |
| Announcements | `launchAnnouncement`, types `AnnounceChain`, `LaunchAnnouncement`, `LaunchAnnouncementInput` |
| Network constants | `X_PRICES`, `LINKEDIN_VERSION` (`"202609"`), `GRAPH_VERSION` (`"v25.0"`), `NOSTR_DEFAULT_RELAYS` |
| Nostr | `nostrKeygen()`, `signNostrEvent(secretKey, event)` |
| Connectors | `CONNECTORS`, `LISTED_ONLY`, `stableTid` (Bluesky record keys), `escapeLittle` (LinkedIn text) |
| Types | Every type in `types.ts`, plus `Connector`, `ConnCtx`, `PublishJob`, `PublishOut`, `OAuthSpec`, `HttpRequest`, `HttpResponse`, `MultipartPart` |

### Supported networks

Limits and caps are the defaults from `networks()`. Key names are what `KeyProvider.get(name)` is asked for; OAuth app credentials can be JSON `{"clientId":"…","clientSecret":"…"}` or `clientId:clientSecret`.

| Network (`id`) | Tier | Auth | Credentials | `connect()` params | Max text | Daily cap |
|---|---|---|---|---|---|---|
| X (`x`) | direct | OAuth 2.0 PKCE, loopback | `x`: client id (+ secret) | none | 280 (weighted) | 10 |
| Telegram (`telegram`) | direct | key | `telegram`: bot token | `{ token?, chat, topicId? }` | 4096 | 50 |
| Discord (`discord`) | direct | key | `discord`: webhook URL or bot token | `{ webhookUrl, forum? }` or `{ token, channelId }` | 2000 | 50 |
| Bluesky (`bluesky`) | direct | key | `bluesky`: app password | `{ handle, appPassword?, service? }` | 300 graphemes | 30 |
| Mastodon (`mastodon`) | direct | OAuth PKCE on your instance, or token | `mastodon`: access token (optional `mastodon-app` app creds) | `{ instance }` or `{ instance, accessToken }` | 500 | 30 |
| Farcaster (`farcaster`) | direct (Neynar) | key | `neynar`, `neynar-signer` | `{ apiKey?, signerUuid? }` | 320 bytes | 20 |
| Nostr (`nostr`) | direct | key | `nostr`: nsec | `{ nsec?, relays?, blossom? }` | 4000 | 30 |
| LinkedIn profile (`linkedin`) | direct | OAuth, relay | `linkedin`: id + secret | none | 3000 | 5 |
| YouTube (`youtube`) | direct | OAuth PKCE, loopback | `youtube`: id + secret | none | 5000 (description) | 5 |
| Buffer (`buffer`) | service | API key | `buffer` | `{ apiKey? }` | 2200 | 10 |
| Zernio (`zernio`) | service | API key | `zernio` | `{ apiKey? }` | 2200 | 10 |
| Upload-Post (`upload-post`) | service | API key | `upload-post` | `{ apiKey? }` | 2200 | 10 |
| Instagram (`instagram`) | v2 | OAuth, relay | `instagram`: Meta app id + secret | none | 2200 | 20 |
| Facebook Page (`facebook`) | v2 | OAuth, relay | `facebook`: Meta app id + secret | `{ configId? }` | 63206 | 10 |
| Threads (`threads`) | v2 | OAuth, relay | `threads`: Meta app id + secret | none | 500 | 25 |
| TikTok (`tiktok`) | v2 | OAuth PKCE, loopback | `tiktok`: client key + secret | none | 2200 | 5 |
| Pinterest (`pinterest`) | v2 | OAuth, relay | `pinterest`: app id + secret | `{ boardId? }` | 800 | 10 |

Tiers: *direct* talks to the network with your app or key. *service* uses your Buffer, Zernio or Upload-Post account; each connected channel becomes its own account with `via` set. *v2* needs your own Meta, TikTok or Pinterest app, with their review limits.

Listed with a reason and no connector (`LISTED_ONLY`): WhatsApp (crypto promotion not allowed), Snapchat (allowlist-only API), Reddit (manual API approval, bots banned in most crypto subreddits), Zora (every post mints a coin), Lemon8, Weibo and Douyin (no public API, or a mainland-China identity is required).

Network notes worth knowing:

- **X:** access tokens last 2 hours and refresh automatically. At most one `$cashtag` per post. Replies only go to posts that mention or quote the account. Turn on the account's **Automated** label.
- **LinkedIn:** tokens last 60 days with no refresh for self-serve apps. `expiresAt` is set, previews warn in the last week, and `tick()` emits `expiring`.
- **YouTube:** uploads are `private` unless `options.youtube.privacyStatus` says otherwise.
- **TikTok:** posts are `SELF_ONLY` until TikTok audits your app. One video per post; photo posts aren't supported.
- **Pinterest:** new apps are on Trial access, so pins are visible only to you.
- **Discord:** webhooks can post but can't read or reply; use a bot token for the inbox. Claudia never pings @everyone, roles or users.

## Configuration

### `createSocial` options

| Option | Default | What it does |
|---|---|---|
| `keys` | required | `KeyProvider` with `get(name)` |
| `dataDir` | `$CLAUDIA_HOME` or `~/.claudia` | Files go in `<dataDir>/social/` |
| `fetch` | global `fetch` | Inject a mock |
| `dryRun` | `false` | Every publish, connect and reply is a dry run |
| `loopbackPort` | `3939` | Port for loopback OAuth redirects |
| `relayUrl` | `https://useclaudia.xyz/relay/oauth/callback` | OAuth relay redirect |
| `mediaRelay` | none | `{ url, token, sign?, ttlMin? }` |
| `tokens` | sealed `<dataDir>/social/accounts.json` | Your own `TokenStore` (`{ load(), save(list) }`) |
| `rules.caps` | see `DEFAULT_CAPS` | Published posts per account per 24 h, by network |
| `rules.linksPerDay` | `{ default: 5, x: 3, linkedin: 3 }` | Posts with links per account per 24 h |
| `rules.duplicateWindowMs` | 24 h | Near-duplicate window |
| `rules.disclosureText` | `"(AI-generated)"` | Text AI label |
| `rules.nfaText` | `"Not financial advice."` | Finance disclaimer |
| `rules.lateAfterMin` | `10` | Missed schedules older than this go back to approval |
| `inboxBudget` | 200 reads/day, X 0 | `{ [network]: { perDay } }` |
| `WebSocket` | global `WebSocket`, else a built-in client | For Nostr relays |
| `now` | `Date.now` | Clock override |

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CLAUDIA_HOME` | default `dataDir` | Base folder instead of `~/.claudia` |
| `CLAUDIA_KEY_<NAME>` | `envKeys()` | A key by name: upper case, other characters become `_` |
| `CLAUDIA_KEY_SOCIAL_VAULT` | `envKeys()` | The vault key (16+ characters) that seals tokens |
| `CLAUDIA_KEY_X`, `CLAUDIA_KEY_TELEGRAM`, `CLAUDIA_KEY_NEYNAR_SIGNER`, `CLAUDIA_KEY_UPLOAD_POST`, … | `envKeys()` | Network keys from the table above |

The package reads no environment variables unless you use `envKeys()` or leave `dataDir` unset.

### Files

| File | Contents |
|---|---|
| `accounts.json` | Sealed credentials (AES-256-GCM, HKDF-SHA256 from `social-vault`) |
| `accounts-index.json` | Account list without secrets |
| `posts.json` | Posts, results and idempotency keys |
| `state.json` | Kill switch, inbox cursors and budgets, known X mentions |
| `audit.jsonl` | One line per action. Never secrets. |

## Errors

Everything thrown on purpose is a `ClaudiaSocialError` with `code`, `message` and `hint` (a plain-English next step), plus `retryAfterMs`, `status`, `network` and `uncertain` where relevant.

```ts
import { isSocialError } from "@useclaudia/social";

try { await social.publish(p.id); }
catch (e) { if (isSocialError(e)) console.log(e.code, e.hint); }
// → needs_approval submit() it, then a person approves it with approve().
```

| `code` | When | What to do |
|---|---|---|
| `no_key` | A key, app credential or the vault key is missing | The hint names the key |
| `needs_approval` | `publish()` on a draft or pending post | `submit()`, then `approve()` |
| `blocked` | A rule refused it, or the kill switch is on | Read the reason; fix the text or wait |
| `invalid` | Unknown account or post, wrong status, bad file, expired OAuth state, vault can't be decrypted | Fix the input |
| `unsupported` | The network can't do this (no replies, no media relay, BNB Chain announcement) | Use another path, set `mediaRelay` |
| `expired` | HTTP 401, or a token expired with no refresh | Reconnect |
| `rate_limited` | HTTP 429 (`retryAfterMs` when known) | Try later; posts are never retried on their own |
| `over_budget` | HTTP 402: the network wants payment or credits | Top up the account |
| `provider_error` | Any other network error, or the network was unreachable | Check the network's status |

Per-account failures don't throw from `publish()`. They land in `post.results[i].error` and the post becomes `partial` or `failed`.

## Safety notes

- **Rules can't be turned off.** AI labels, the not-financial-advice line, promise blocking, the X reply and cashtag rules, daily caps, near-duplicate and link-frequency checks run in `preview()` and again in `publish()`.
- **Price and return promises are blocked**, for example "100x", "guaranteed returns", "can't lose", "risk-free", "will hit $1", "easy money", and in coin context "10x", "will pump" and "% daily returns".
- **No unencrypted tokens.** Without a `social-vault` key of 16+ characters, the default store refuses to save and `connect()` throws `no_key`. `memoryTokenStore()` keeps tokens in memory only.
- **The OAuth relay stores nothing.** It forwards `code` and `state` to your `127.0.0.1` listener; the code is useless without your secret or PKCE verifier.
- **Media relay links are short-lived** (up to 60 minutes) and deleted after publishing.
- **Approval and audit.** Every publish needs an approved post, and every step is logged without secrets.
- **Inbox text is untrusted.** Mentions and DMs are written by strangers. Never let them act as instructions to your agent.
- **A floor, not legal advice.** Platform rules (X automation, TikTok on crypto, Meta, UK FCA, EU MiCA) still apply to your account. Use `labels.ad` for anything paid or promotional.

## Links

- [Online docs](https://useclaudia.xyz/docs/developers/social) · [Package README](https://github.com/claudia-onchain/Claudia-NPM/tree/main/packages/social) · [npm](https://www.npmjs.com/package/@useclaudia/social)
- [Changelog](https://useclaudia.xyz/docs/developers/changelog) · [Connect socials on Claudia](https://useclaudia.xyz/docs/socials)
- Other packages: [sdk](https://useclaudia.xyz/docs/developers/sdk) · [media](https://useclaudia.xyz/docs/developers/media) · [cli](https://useclaudia.xyz/docs/developers/cli) · [mcp](https://useclaudia.xyz/docs/developers/mcp)
- [Back to all docs](./README.md)

MIT · [useclaudia.xyz](https://useclaudia.xyz)
