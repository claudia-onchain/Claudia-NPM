#!/usr/bin/env node
// Dry run for @useclaudia/social. Nothing here reaches a real network or account:
//   Part 1  connect: the authorize URL for every OAuth network (and the requests key-based connects would send)
//   Part 2  publish: the exact requests for every direct + service network (text, image, thread/video), secrets redacted
//   Part 3  the media-relay flow (upload → network pulls the URL → delete)
//   Part 4  a full lifecycle against an injected mock fetch (vault, rules, approval, once-only publish,
//           crash-safe resend, scheduling + tick, late schedule, kill switch, duplicates, X reply rule, inbox, audit)
// Run after `npm run build`:  node scripts/dry-run.mjs   (add --full to print every request body in full)
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = await import(join(here, "..", "dist", "index.js"));
const { createSocial, staticKeys, memoryTokenStore, nostrKeygen, ClaudiaSocialError, DEFAULT_MEDIA_RELAY } = lib;

const FULL = process.argv.includes("--full");
let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};
const h1 = (s) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);
const h2 = (s) => console.log(`\n--- ${s}`);
const short = (v, n = FULL ? 1e9 : 360) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};
function printRequests(reqs) {
  for (const r of reqs) {
    console.log(`  ${r.method.padEnd(6)} ${r.url}${r.label ? `   [${r.label}]` : ""}`);
    const hs = Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join(" | ");
    if (hs) console.log(`         headers ${hs}`);
    if (r.body !== undefined) console.log(`         body    ${short(r.body)}`);
  }
}

// ---------------------------------------------------------------- fake inputs (never real keys)
const work = mkdtempSync(join(tmpdir(), "claudia-social-dry-"));
const media = {
  jpg: join(work, "chart.jpg"),
  png: join(work, "logo.png"),
  mp4: join(work, "clip.mp4"),
};
writeFileSync(media.jpg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]));
writeFileSync(media.png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1024, 3)]));
writeFileSync(media.mp4, Buffer.alloc(6 * 1024 * 1024, 1)); // 6 MB → X chunked upload shows 2 segments

const FAKE = {
  vault: "dry-run-vault-key-not-a-secret-0123456789",
  app: (n) => JSON.stringify({ clientId: `${n}-client-id-FAKE`, clientSecret: `${n}-client-secret-FAKE` }),
};
const keys = staticKeys({
  "social-vault": FAKE.vault,
  x: FAKE.app("x"),
  linkedin: FAKE.app("linkedin"),
  youtube: FAKE.app("youtube"),
  instagram: FAKE.app("instagram"),
  facebook: FAKE.app("facebook"),
  threads: FAKE.app("threads"),
  tiktok: FAKE.app("tiktok"),
  pinterest: FAKE.app("pinterest"),
});
const nostr = nostrKeygen();
const now = Date.now();

// Seeded accounts for Part 2 (credentials are obviously fake; the transport records instead of sending)
const seeded = [
  ["x:1234567890", "x", "@claudia_agent", { accessToken: "X-ACCESS-FAKE", refreshToken: "X-REFRESH-FAKE", expiresAt: now + 3600e3, clientId: "x-client-id-FAKE", clientSecret: "x-client-secret-FAKE", userId: "1234567890", username: "claudia_agent" }],
  ["telegram:-1001234567890", "telegram", "@claudia_news", { token: "123456:TELEGRAM-BOT-TOKEN-FAKE", chatId: -1001234567890, chatUsername: "claudia_news", botId: 777000, botUsername: "claudia_bot" }],
  ["discord:webhook:110:abcd", "discord", "#announcements (webhook)", { webhookId: "1100000000000000001", webhookToken: "DISCORD-WEBHOOK-TOKEN-FAKE", channelId: "1100000000000000001", guildId: "1000000000000000001", forum: false }],
  ["discord:120", "discord", "#ideas (bot, forum)", { botToken: "DISCORD-BOT-TOKEN-FAKE", botId: "1200000000000000001", channelId: "1200000000000000009", guildId: "1000000000000000001", forum: true }],
  ["bluesky:did:plc:claudiaexample123", "bluesky", "@claudia.bsky.social", { accessJwt: "BSKY-ACCESS-JWT-FAKE", refreshJwt: "BSKY-REFRESH-JWT-FAKE", did: "did:plc:claudiaexample123", handle: "claudia.bsky.social", pds: "https://morel.us-east.host.bsky.network", expiresAt: now + 3600e3, identifier: "claudia.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", refreshable: true }],
  ["mastodon:mastodon.social:1", "mastodon", "@claudia@mastodon.social", { instance: "https://mastodon.social", accessToken: "MASTODON-TOKEN-FAKE", accountId: "1" }, ["bot flag on"]],
  ["farcaster:1234", "farcaster", "@claudia", { apiKey: "NEYNAR-API-KEY-FAKE", signerUuid: "19d0c5fd-9b33-4a48-a0e2-bc7b0555baec", fid: 1234, username: "claudia" }],
  [`nostr:${nostr.npub}`, "nostr", "npub…", { nsec: nostr.nsec, pubkey: nostr.pubkey, relays: ["wss://relay.damus.io", "wss://nos.lol"], blossom: "https://blossom.primal.net" }, ["2 relays", "blossom https://blossom.primal.net"]],
  ["linkedin:abc123XYZ", "linkedin", "Claudia Agent", { accessToken: "LINKEDIN-TOKEN-FAKE", expiresAt: now + 50 * 864e5, personUrn: "urn:li:person:abc123XYZ" }],
  ["youtube:UCdryrun", "youtube", "@claudia", { accessToken: "YOUTUBE-TOKEN-FAKE", refreshToken: "YT-REFRESH-FAKE", expiresAt: now + 3600e3, channelId: "UCdryrun000000000000000" }],
  ["buffer:acc", "buffer", "you@example.com", { apiKey: "BUFFER-KEY-FAKE" }],
  ["zernio:key", "zernio", "Zernio", { apiKey: "sk_ZERNIO-KEY-FAKE" }],
  ["upload-post:key", "upload-post", "Upload-Post", { apiKey: "UPLOADPOST-KEY-FAKE" }],
  ["instagram:178414", "instagram", "@claudia", { accessToken: "IG-TOKEN-FAKE", expiresAt: now + 50 * 864e5, userId: "17841400000000000", username: "claudia" }],
  ["facebook:100", "facebook", "Claudia Page", { accessToken: "FB-PAGE-TOKEN-FAKE", pageId: "100000000000001" }],
  ["threads:260", "threads", "@claudia", { accessToken: "TH-TOKEN-FAKE", expiresAt: now + 50 * 864e5, userId: "26000000000000000", username: "claudia" }],
  ["tiktok:open", "tiktok", "@claudia", { accessToken: "TIKTOK-TOKEN-FAKE", refreshToken: "TT-REFRESH-FAKE", expiresAt: now + 3600e3, openId: "open-id" }],
  ["pinterest:claudia", "pinterest", "@claudia", { accessToken: "PINTEREST-TOKEN-FAKE", refreshToken: "PIN-REFRESH-FAKE", expiresAt: now + 20 * 864e5, boardId: "549755885175" }],
].map(([id, network, handle, credentials, notes]) => ({ account: { id, network, handle, connectedAt: now, ...(notes ? { notes } : {}) }, credentials }));
const children = [
  ["buffer:instagram:ch_ig", "instagram", "buffer", "buffer:acc", "instagram", { channelId: "ch_ig_dry", platform: "instagram" }],
  ["buffer:pinterest:ch_pin", "pinterest", "buffer", "buffer:acc", "pinterest", { channelId: "ch_pin_dry", platform: "pinterest" }],
  ["zernio:tiktok:65f0", "tiktok", "zernio", "zernio:key", "tiktok", { channelId: "65f0dryrun0000000000tt01", platform: "tiktok" }],
  ["zernio:threads:65f1", "threads", "zernio", "zernio:key", "threads", { channelId: "65f0dryrun0000000000th01", platform: "threads" }],
  ["upload-post:facebook:claudia", "facebook", "upload-post", "upload-post:key", "facebook", { channelId: "claudia:fb", platform: "facebook", user: "claudia" }],
  ["upload-post:tiktok:claudia", "tiktok", "upload-post", "upload-post:key", "tiktok", { channelId: "claudia:tt", platform: "tiktok", user: "claudia" }],
].map(([id, network, via, parent, platform, credentials]) => ({ account: { id, network, via, parent, platform, handle: `@claudia (${platform} via ${via})`, connectedAt: now }, credentials }));
const SECRETS = [...seeded, ...children].flatMap((s) => Object.entries(s.credentials).filter(([k]) => k !== "pubkey" && /token|secret|key|jwt|password|nsec|signer/i.test(k)).map(([, v]) => String(v)));

// ================================================================ Part 1
h1("Part 1: connect (dry run): authorize URLs + key-based connect requests");
{
  const s = createSocial({ keys, dataDir: join(work, "p1"), dryRun: true, tokens: memoryTokenStore(), loopbackPort: 3939 });
  for (const n of ["x", "mastodon", "linkedin", "youtube", "instagram", "facebook", "threads", "tiktok", "pinterest"]) {
    const params = n === "mastodon" ? { instance: "mastodon.social" } : {};
    const r = await s.connect(n, params, { dryRun: true });
    h2(`${n}: ${r.redirectUri}`);
    console.log(`  authorize: ${r.authorizeUrl}`);
    ok(r.state && /\.3939$/.test(r.state), `state is "<random>.3939"`);
    if (r.requests) printRequests(r.requests);
  }
  const keyed = {
    telegram: { token: "123456:TELEGRAM-BOT-TOKEN-FAKE", chat: "@claudia_news" },
    discord: { webhookUrl: "https://discord.com/api/webhooks/1100000000000000001/DISCORD-WEBHOOK-TOKEN-FAKE" },
    bluesky: { handle: "claudia.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" },
    mastodon: { instance: "mastodon.social", accessToken: "MASTODON-TOKEN-FAKE" },
    farcaster: { apiKey: "NEYNAR-API-KEY-FAKE", signerUuid: "19d0c5fd-9b33-4a48-a0e2-bc7b0555baec" },
    nostr: { nsec: nostr.nsec, relays: "wss://relay.damus.io,wss://nos.lol" },
    buffer: { apiKey: "BUFFER-KEY-FAKE" },
    zernio: { apiKey: "sk_ZERNIO-KEY-FAKE" },
    "upload-post": { apiKey: "UPLOADPOST-KEY-FAKE" },
  };
  for (const [n, params] of Object.entries(keyed)) {
    const r = await s.connect(n, params, { dryRun: true });
    h2(`${n} (key)${r.requests.length ? "" : ": no network call needed"}`);
    printRequests(r.requests);
    const dump = JSON.stringify(r.requests);
    ok(!Object.values(params).some((v) => v.length > 8 && /FAKE|abcd-efgh|nsec1|19d0c5fd/.test(v) && dump.includes(v)), "no secret appears in the dry-run output");
  }
  await s.close();
}

// ================================================================ Part 2 + 3
h1("Part 2: publish (dry run): every direct + service network");
{
  const s = createSocial({
    keys,
    dataDir: join(work, "p2"),
    tokens: memoryTokenStore([...seeded, ...children]),
    mediaRelay: { url: DEFAULT_MEDIA_RELAY, token: async () => "CLAUDIA-TOKEN-FAKE" },
    fetch: async () => {
      throw new Error("Part 2 must never call fetch");
    },
  });
  await s.ready();
  const thread = ["Part two: how it works.", "Part three: where to find it."];
  const plans = [
    ["x:1234567890", ["text", "image", "thread", "video"]],
    ["telegram:-1001234567890", ["text", "image", "thread"]],
    ["discord:webhook:110:abcd", ["text", "image"]],
    ["discord:120", ["text", "thread"]],
    ["bluesky:did:plc:claudiaexample123", ["text", "image", "thread", "video"]],
    ["mastodon:mastodon.social:1", ["text", "image", "thread"]],
    ["farcaster:1234", ["text", "imageUrl", "thread"]],
    ["nostr:" + nostr.npub, ["text", "image", "thread"]],
    ["linkedin:abc123XYZ", ["text", "image", "video"]],
    ["youtube:UCdryrun", ["video"]],
    ["buffer:instagram:ch_ig", ["image"]],
    ["buffer:pinterest:ch_pin", ["image"]],
    ["zernio:tiktok:65f0", ["video"]],
    ["zernio:threads:65f1", ["text"]],
    ["upload-post:facebook:claudia", ["text", "image"]],
    ["upload-post:tiktok:claudia", ["video"]],
    ["instagram:178414", ["image", "video"]],
    ["facebook:100", ["text", "image"]],
    ["threads:260", ["text", "thread"]],
    ["tiktok:open", ["video"]],
    ["pinterest:claudia", ["image"]],
  ];
  let total = 0;
  for (const [account, kinds] of plans) {
    for (const kind of kinds) {
      const input = {
        text: kind === "video" ? "Claudia explains bonding curves in 60 seconds." : "gm. Claudia's agent thread is live.",
        targets: [{ account }],
        options: {
          buffer: { boardId: "549755885175" },
          "upload-post": { pageId: "100000000000001" },
          youtube: { title: "Bonding curves in 60 seconds" },
        },
      };
      if (kind === "image") input.media = [{ path: media.jpg, alt: "A price chart drawn by Claudia" }];
      if (kind === "imageUrl") input.media = [{ path: "https://useclaudia.xyz/og.jpg", alt: "Claudia" }];
      if (kind === "video") input.media = [{ path: media.mp4 }];
      if (kind === "thread") input.thread = thread;
      const p = s.draft(input);
      const [pv] = s.preview(p.id);
      const r = await s.publish(p.id, { dryRun: true });
      h2(`${account} · ${kind}${pv.costUsd !== undefined ? ` · est. $${pv.costUsd}` : ""} · labels: ${pv.labelsAdded.join(", ") || "none"}`);
      if (pv.blocked) console.log(`  blocked: ${pv.blocked}`);
      for (const w of pv.warnings) console.log(`  warning: ${w}`);
      printRequests(r.requests);
      total += r.requests.length;
      const dump = JSON.stringify(r.requests);
      const leaked = SECRETS.filter((x) => x.length > 8 && dump.includes(x));
      ok(r.dryRun === true && leaked.length === 0, `dry run, ${r.requests.length} requests, no secrets in output${leaked.length ? ` (LEAKED: ${leaked.join(",")})` : ""}`);
      ok(!r.requests.some((q) => q.method === "ERROR"), "every step built without errors");
    }
  }
  console.log(`\n  ${total} requests built; fetch was never called.`);

  h1("Part 3: media relay flow (Instagram pulls a public URL)");
  const p = s.draft({ text: "New chart.", media: [{ path: media.jpg, alt: "chart" }], targets: [{ account: "instagram:178414" }] });
  const r = await s.publish(p.id, { dryRun: true });
  printRequests(r.requests);
  const steps = r.requests.map((q) => `${q.method} ${new URL(q.url).host}${new URL(q.url).pathname}`);
  ok(steps[0]?.startsWith("POST useclaudia.xyz/relay/media"), "1. file goes to POST https://useclaudia.xyz/relay/media (Bearer Claudia token, multipart field \"file\", ?ttl=)");
  ok(r.requests.some((q) => /\/media$/.test(q.url) && JSON.stringify(q.body).includes("useclaudia.xyz/relay/media/")), "2. Instagram container gets image_url = the relay link");
  ok(steps.at(-1)?.startsWith("DELETE useclaudia.xyz/relay/media/"), "3. the relay link is deleted right after publishing");
  await s.close();
}

// ================================================================ Part 4
h1("Part 4: full lifecycle against a mock fetch (no network)");
const calls = [];
const relaySeen = [];
const bskyRkeys = new Set();
const mastoIdem = new Map();
let hang = false;
let clock = Date.now();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
async function mockFetch(url, init = {}) {
  const u = new URL(url);
  const method = init.method ?? "GET";
  calls.push(`${method} ${u.host}${u.pathname}`);
  const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (hang && /createRecord|sendMessage/.test(u.pathname)) {
    if (u.pathname.endsWith("createRecord")) bskyRkeys.add(body.rkey); // the server got it…
    return new Promise(() => {}); // …but the answer never comes back (process "crashes")
  }
  // Bluesky
  if (u.pathname.endsWith("com.atproto.server.createSession"))
    return json({ did: "did:plc:mock", handle: "claudia.bsky.social", accessJwt: "h.eyJleHAiOjQxMDI0NDQ4MDB9.s", refreshJwt: "h.eyJleHAiOjQxMDI0NDQ4MDB9.r", didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.mock" }] } });
  if (u.pathname.endsWith("com.atproto.repo.createRecord")) {
    if (bskyRkeys.has(body.rkey)) return json({ error: "InvalidRequest", message: "Record already exists" }, 400);
    bskyRkeys.add(body.rkey);
    return json({ uri: `at://did:plc:mock/app.bsky.feed.post/${body.rkey}`, cid: `bafy${body.rkey}` });
  }
  if (u.pathname.endsWith("com.atproto.repo.getRecord")) return json({ uri: `at://did:plc:mock/app.bsky.feed.post/${u.searchParams.get("rkey")}`, cid: "bafyexisting", value: { text: "x" } });
  if (u.pathname.endsWith("app.bsky.notification.listNotifications"))
    return json({ notifications: [{ uri: "at://did:plc:fan/app.bsky.feed.post/3abc", reason: "mention", author: { handle: "fan.bsky.social" }, record: { text: "@claudia.bsky.social hi!" }, indexedAt: new Date(clock).toISOString() }] });
  // Telegram
  if (u.host === "api.telegram.org") {
    const m = u.pathname.split("/").pop();
    if (m === "getMe") return json({ ok: true, result: { id: 777, is_bot: true, username: "claudia_bot" } });
    if (m === "getChat") return json({ ok: true, result: { id: -1009876543210, type: "channel", title: "Claudia News", username: "claudia_news" } });
    if (m === "sendMessage") return json({ ok: true, result: { message_id: 500 + calls.length } });
    if (m === "getUpdates") return json({ ok: true, result: [{ update_id: 41, message: { message_id: 9, date: Math.floor(clock / 1000), chat: { id: -1009876543210, type: "supergroup" }, from: { username: "fan" }, text: "@claudia_bot what is a bonding curve?" } }] });
  }
  // Mastodon
  if (u.host === "mastodon.mock") {
    if (u.pathname === "/api/v1/apps") return json({ client_id: "masto-cid", client_secret: "masto-secret" });
    if (u.pathname === "/oauth/token") return json({ access_token: "MASTO-ACCESS-MOCK", token_type: "Bearer" });
    if (u.pathname === "/api/v1/accounts/verify_credentials") return json({ id: "42", username: "claudia", display_name: "Claudia", bot: false });
    if (u.pathname === "/api/v1/statuses") {
      const k = headers["idempotency-key"];
      if (!mastoIdem.has(k)) mastoIdem.set(k, { id: String(1000 + mastoIdem.size), url: `https://mastodon.mock/@claudia/${1000 + mastoIdem.size}` });
      return json(mastoIdem.get(k));
    }
    if (u.pathname === "/api/v1/notifications") return json([]);
  }
  // X
  if (u.host === "api.x.com") {
    if (u.pathname === "/2/oauth2/token") return json({ access_token: "X-ACCESS-MOCK", refresh_token: "X-REFRESH-MOCK", expires_in: 7200 });
    if (u.pathname === "/2/users/me") return json({ data: { id: "99", username: "claudia_agent", name: "Claudia" } });
    if (u.pathname === "/2/tweets/111") return json({ data: { id: "111", entities: { mentions: [{ username: "someone_else" }] } } });
    if (u.pathname === "/2/tweets/222") return json({ data: { id: "222", entities: { mentions: [{ username: "claudia_agent" }] } } });
    if (u.pathname === "/2/tweets") return json({ data: { id: "1900000000000000999", text: body?.text } }, 201);
  }
  // Claudia media relay + Instagram (for the signed-relay check)
  if (u.host === "useclaudia.xyz" && u.pathname === "/relay/media" && method === "POST") {
    relaySeen.push({ headers, body: new Uint8Array(init.body) });
    return json({ id: "r1", url: "https://useclaudia.xyz/relay/media/r1.jpg", expiresAt: clock + 15 * 60e3, bytes: init.body.byteLength, mime: "image/jpeg" }, 201);
  }
  if (u.host === "useclaudia.xyz" && method === "DELETE") return new Response(null, { status: 204 });
  if (u.host === "graph.instagram.com") {
    if (u.pathname.endsWith("/media")) return json({ id: "c1" });
    if (u.pathname.endsWith("/media_publish")) return json({ id: "m1" });
    if (u.searchParams.get("fields") === "permalink") return json({ permalink: "https://www.instagram.com/p/MOCK/" });
  }
  return json({ error: `mock has no route for ${method} ${u.host}${u.pathname}` }, 404);
}

const dataDir = join(work, "life");
const mk = (extra = {}) => createSocial({ keys, dataDir, fetch: mockFetch, now: () => clock, ...extra });
const social = mk();
const events = [];
social.on("post", (p) => events.push(`post:${p.status}`));
social.on("account", (a) => events.push(`account:${a.kind}`));
social.on("warning", (w) => events.push(`warning:${w.message}`));

h2("connect (key + OAuth), tokens sealed in the vault");
const bsky = await social.connect("bluesky", { handle: "claudia.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" });
const tg = await social.connect("telegram", { token: "123456:TG-MOCK-TOKEN", chat: "@claudia_news" });
const start = await social.connect("mastodon", { instance: "https://mastodon.mock", port: "3939" });
ok(start.authorizeUrl.startsWith("https://mastodon.mock/oauth/authorize?") && start.authorizeUrl.includes("code_challenge_method=S256"), "Mastodon: app registered on the instance, PKCE S256 authorize URL");
ok(start.redirectUri === "http://127.0.0.1:3939/oauth/callback", `Mastodon redirect ${start.redirectUri}`);
let bad;
try {
  await social.completeOAuth("wrong.3939", "code");
} catch (e) {
  bad = e;
}
ok(bad?.code === "invalid", "completeOAuth with an unknown state is refused");
const masto = await social.completeOAuth(start.state, "auth-code-mock");
const xStart = await social.connect("x", {});
const xAcc = await social.completeOAuth(xStart.state, "x-code");
console.log(`  accounts: ${social.accounts().map((a) => a.id).join(", ")}`);
const sealed = readFileSync(join(dataDir, "social", "accounts.json"), "utf8");
ok(JSON.parse(sealed).alg === "aes-256-gcm" && !sealed.includes("abcd-efgh") && !sealed.includes("TG-MOCK-TOKEN") && !sealed.includes("MASTO-ACCESS"), "accounts.json is AES-256-GCM sealed; no token in plain text");
ok(!readFileSync(join(dataDir, "social", "accounts-index.json"), "utf8").match(/TG-MOCK|abcd-efgh|MASTO-ACCESS|X-ACCESS/), "accounts-index.json holds no secrets");

h2("draft → preview: labels, NFA, blocked promise");
const targets = [{ account: bsky.id }, { account: tg.id }, { account: masto.id }];
const post = social.draft({ text: "$CLAUD is live on Solana. Read the thread before you do anything.", targets });
for (const pv of social.preview(post.id)) {
  console.log(`  ${pv.network.padEnd(9)} ${pv.chars} chars · labels: ${pv.labelsAdded.join(", ")}${pv.warnings.length ? ` · warnings: ${pv.warnings.join(" / ")}` : ""}`);
  console.log(`            text: ${JSON.stringify(pv.text)}`);
}
const pv0 = social.preview(post.id);
ok(pv0.every((p) => p.text.includes("Not financial advice.")), "\"Not financial advice.\" added (the text names a $TICKER)");
ok(pv0.every((p) => p.labelsAdded.some((l) => /AI-generated/.test(l))), "AI disclosure added where there is no native label (Mastodon bot flag is off here)");
ok(pv0.find((p) => p.network === "mastodon").warnings.some((w) => /bot flag/.test(w)), "Mastodon warns that the bot flag is off");
const promise = social.draft({ text: "Buy $CLAUD now, it will 100x by Friday. Guaranteed.", targets: [{ account: bsky.id }] });
const pvBad = social.preview(promise.id)[0];
console.log(`  blocked: ${pvBad.blocked}`);
ok(!!pvBad.blocked, "price/return promise is blocked with a reason");
let e1;
try {
  social.submit(promise.id);
} catch (e) {
  e1 = e;
}
ok(e1 instanceof ClaudiaSocialError && e1.code === "blocked", "submit() refuses a blocked post");

h2("approval gate, publish once");
let e2;
try {
  await social.publish(post.id);
} catch (e) {
  e2 = e;
}
ok(e2?.code === "needs_approval", "publish before approval → needs_approval");
social.submit(post.id);
ok(social.getPost(post.id).status === "pending_approval", "submit → pending_approval");
social.approve(post.id);
ok(social.getPost(post.id).status === "approved", "approve → approved");
const before = calls.length;
const pub = await social.publish(post.id);
console.log(`  ${pub.status}: ${pub.results.map((r) => `${r.network} ${r.status} ${r.url ?? ""}`).join(" | ")}`);
ok(pub.status === "published", "published on all three accounts");
const sent = calls.length - before;
await social.publish(post.id);
ok(calls.length - before === sent, `re-publish is a no-op (still ${sent} network calls, none new)`);

h2("crash mid-publish, then restart");
const postsFile = join(dataDir, "social", "posts.json");
const inFlight = async (id) => {
  for (let i = 0; i < 100; i++) {
    const p = JSON.parse(readFileSync(postsFile, "utf8")).posts.find((x) => x.id === id);
    if (p?.results?.some((r) => r.uncertain && r.status === "pending")) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
// (a) Telegram has no idempotency key: an interrupted send is never resent on its own
const crashA = social.draft({ text: "Weekly update from Claudia: three new agents joined.", targets: [{ account: tg.id }, { account: bsky.id }] });
social.approve(crashA.id);
hang = true;
void social.publish(crashA.id); // never resolves: the "process dies" while Telegram's request is in flight
ok(await inFlight(crashA.id), "posts.json marks the Telegram send as in flight before the request goes out");
hang = false;
const restarted = mk(); // a new process reading the same files
const afterA = restarted.getPost(crashA.id);
console.log(`  after restart: ${afterA.status}; ${afterA.results.map((r) => `${r.network}: ${r.status}${r.uncertain ? " (may be live)" : ""}`).join(" | ")}; note: ${afterA.note}`);
ok(afterA.results.find((r) => r.network === "telegram").uncertain === true, "the interrupted Telegram send is marked failed + \"may be live\"");
const tgBefore = calls.filter((c) => c.endsWith("/sendMessage")).length;
const resumedA = await restarted.publish(crashA.id);
const tgAfter = calls.filter((c) => c.endsWith("/sendMessage")).length;
const tA = resumedA.results.find((r) => r.network === "telegram");
const bA = resumedA.results.find((r) => r.network === "bluesky");
console.log(`  publish again: ${resumedA.status}; telegram ${tA.status} (${tA.error}); bluesky ${bA.status}`);
ok(tgAfter === tgBefore && tA.status === "failed", "Telegram is NOT resent automatically (a person checks, then publish with retryUncertain)");
ok(bA.status === "published", "Bluesky, which never started, is sent normally");
// (b) Bluesky uses a stable record key: resending the same post is safe
const crashB = restarted.draft({ text: "Claudia's agents posted 40 times this week.", targets: [{ account: bsky.id }] });
restarted.approve(crashB.id);
hang = true;
void restarted.publish(crashB.id); // the server stores the record, the answer is lost
ok(await inFlight(crashB.id), "the Bluesky send is in flight when the process dies");
hang = false;
const restarted2 = mk();
const creates = calls.filter((c) => c.endsWith("createRecord")).length;
const resumedB = await restarted2.publish(crashB.id);
const r2 = resumedB.results[0];
console.log(`  bluesky after restart + publish: ${r2.status} ${r2.remoteId} (createRecord calls +${calls.filter((c) => c.endsWith("createRecord")).length - creates}, getRecord used: ${calls.at(-1).endsWith("getRecord")})`);
ok(r2.status === "published" && calls.at(-1).endsWith("getRecord"), "same record key → \"already exists\" → the existing post is used: no duplicate");

h2("schedule + tick, late schedule");
const sched = restarted.draft({ text: "Office hours with Claudia tonight.", targets: [{ account: masto.id }] });
restarted.approve(sched.id);
restarted.schedule(sched.id, clock + 60_000);
ok(restarted.getPost(sched.id).status === "scheduled", "approve + schedule → scheduled");
await restarted.tick();
ok(restarted.getPost(sched.id).status === "scheduled", "tick before the time does nothing");
clock += 61_000;
await restarted.tick();
ok(restarted.getPost(sched.id).status === "published", "tick after the time publishes it");
const late = restarted.draft({ text: "A reminder that was due a while ago.", targets: [{ account: masto.id }] });
restarted.approve(late.id);
restarted.schedule(late.id, clock + 60_000);
clock += 15 * 60_000; // the machine was asleep
await restarted.tick();
const lp = restarted.getPost(late.id);
console.log(`  late post: ${lp.status}: ${lp.note}`);
ok(lp.status === "pending_approval" && /late/i.test(lp.note), "missed by more than 10 min → back to pending_approval (\"Posting late?\")");

h2("kill switch");
restarted.killSwitch(true);
const ks = restarted.draft({ text: "This should not go out yet.", targets: [{ account: masto.id }] });
restarted.approve(ks.id);
let e3;
try {
  await restarted.publish(ks.id);
} catch (e) {
  e3 = e;
}
ok(e3?.code === "blocked", "kill switch on → publish is blocked");
restarted.schedule(ks.id, clock + 1000);
clock += 2000;
await restarted.tick();
ok(restarted.getPost(ks.id).status === "scheduled", "kill switch on → tick does not publish scheduled posts");
restarted.killSwitch(false);
ok(restarted.killSwitch() === false, "kill switch off again");

h2("near-duplicate, X reply rule, dry-run reply");
const dup = restarted.draft({ text: "$claud is LIVE on solana!! read the thread before you do anything", targets: [{ account: bsky.id }] });
const dupPv = restarted.preview(dup.id)[0];
console.log(`  ${dupPv.blocked}`);
ok(/Near-duplicate/.test(dupPv.blocked ?? ""), "same text (case/punctuation changed) within 24 h → blocked as a near-duplicate");
let e4;
try {
  await restarted.reply(xAcc.id, "111", "Thanks for the question!");
} catch (e) {
  e4 = e;
}
ok(e4?.code === "blocked" && /mention/.test(e4.message), "X: reply to a post that does not @mention the account is blocked");
const xr = await restarted.reply(xAcc.id, "222", "Thanks for the question!");
ok(!!xr.remoteId, "X: reply to a post that mentions the account goes out");
const dr = await restarted.reply(bsky.id, "at://did:plc:fan/app.bsky.feed.post/3abc", "Hi! Happy to help.", { dryRun: true });
ok(dr.dryRun && dr.requests.length >= 2, `reply dry run shows ${dr.requests.length} requests`);

h2("inbox (per-network budget; X reads cost money so they are off by default)");
const warn = [];
restarted.on("warning", (w) => warn.push(w.message));
const inbox = await restarted.inbox();
for (const it of inbox) console.log(`  ${it.network} ${it.kind} from ${it.from}: ${it.text}`);
ok(inbox.some((i) => i.network === "bluesky") && inbox.some((i) => i.network === "telegram"), "Bluesky notifications + Telegram getUpdates read");
ok(warn.some((w) => /X inbox is off/.test(w)), "X inbox skipped with the cost shown");

h2("media relay with a signing hook (agent key + X-Claudia-* headers)");
{
  const signed = [];
  const ig = seeded.find((x) => x.account.network === "instagram");
  const s3 = createSocial({
    keys,
    dataDir: join(work, "relay"),
    fetch: mockFetch,
    tokens: memoryTokenStore([ig]),
    mediaRelay: {
      url: DEFAULT_MEDIA_RELAY,
      token: async () => "ck_live_FAKE_AGENT_KEY",
      sign: async (req) => {
        signed.push(req);
        return { "X-Claudia-Signature": `sig-over-${req.body.byteLength}-bytes` };
      },
    },
  });
  await s3.ready();
  const p = s3.draft({ text: "New chart.", media: [{ path: media.jpg, alt: "chart" }], targets: [{ account: ig.account.id }] });
  s3.approve(p.id);
  const done = await s3.publish(p.id);
  const sentBody = relaySeen.at(-1)?.body;
  ok(done.status === "published", "Instagram published through the relay link");
  ok(signed[0]?.method === "POST" && signed[0].path === "/relay/media?ttl=15", `sign() got POST ${signed[0]?.path}`);
  ok(sentBody && Buffer.from(signed[0].body).equals(Buffer.from(sentBody)), "the signature covers the exact multipart bytes that were sent");
  ok(relaySeen.at(-1).headers["x-claudia-signature"] && relaySeen.at(-1).headers.authorization === "Bearer ck_live_FAKE_AGENT_KEY", "upload carries Bearer + the signature headers");
  ok(signed[1]?.method === "DELETE" && signed[1].body.byteLength === 0 && signed[1].path === "/relay/media/r1.jpg", "DELETE is signed over an empty body");
  await s3.close();
}

h2("audit log + no-vault refusal");
const audit = readFileSync(join(dataDir, "social", "audit.jsonl"), "utf8");
const lines = audit.trim().split("\n");
console.log(`  ${lines.length} audit lines, e.g. ${lines.slice(-2).join(" ")}`);
ok(!/abcd-efgh|TG-MOCK-TOKEN|MASTO-ACCESS|X-ACCESS|masto-secret|x-client-secret/.test(audit), "audit.jsonl contains no secrets");
const noVault = createSocial({ keys: staticKeys({}), dataDir: join(work, "novault"), fetch: mockFetch });
let e5;
try {
  await noVault.connect("bluesky", { handle: "claudia.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" });
} catch (e) {
  e5 = e;
}
console.log(`  ${e5?.message} Hint: ${e5?.hint}`);
ok(e5?.code === "no_key" && !existsSync(join(work, "novault", "social", "accounts.json")), "without a \"social-vault\" key, tokens are not saved (no_key) and nothing is written");
ok(events.includes("post:published") && events.includes("account:connected"), "events: post + account fired");

await restarted2.close(); // `social` and `restarted` stand for crashed processes: they are dropped, not closed
rmSync(work, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed."} No real network was used.`);
process.exit(failures ? 1 : 0);
