#!/usr/bin/env node
// Dry-run + mock lifecycle check for @useclaudia/media. Sends nothing to any provider and spends nothing.
//
//   npm run build -w @useclaudia/media && node packages/media/scripts/dry-run.mjs [--full]
//
// Part 1 prints the exact request (secrets as "***") for every model in the table, plus checkModels requests.
// Part 2 runs real jobs through the queue against an injected mock fetch:
//   submit → poll (incl. a 429 with Retry-After) → download → library file + sidecar → spend ledger → restart resume,
//   approvals, caps, cancel, brand kits, missing keys.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createMedia, staticKeys, MODEL_TABLE, ClaudiaMediaError } from "../dist/index.js";

const FULL = process.argv.includes("--full");
const FAKE = {
  google: "fake-google-key-123",
  openai: "sk-fake-openai-456",
  fal: "fake-fal-789",
  elevenlabs: "fake-eleven-abc",
  heygen: "fake-heygen-def",
  runway: "fake-runway-ghi",
  byteplus: "fake-byteplus-jkl",
};
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// ---------- tiny fixture files ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.writeUInt32BE(0xe8879aff, y * (w * 4 + 1) + 1 + x * 4); // rose pink
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, "ascii");
  return Buffer.concat([h, body]);
}
function mp4(seconds, w, h) {
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom"));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(seconds * 1000, 16); // duration
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(w * 65536, 76);
  tkhd.writeUInt32BE(h * 65536, 80);
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd)))]);
}
function mp3(seconds) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00; // MPEG1 L3 128 kbps 44.1 kHz
  return Buffer.concat(Array.from({ length: Math.round((seconds * 128000) / 8 / 417) }, () => frame));
}
function wav(seconds) {
  const rate = 24000, pcm = Buffer.alloc(rate * 2 * seconds), hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVEfmt ", 8); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

const work = mkdtempSync(join(tmpdir(), "claudia-media-dry-"));
const facePng = join(work, "face.png");
writeFileSync(facePng, png(4, 4));
const voiceWav = join(work, "voice.wav");
writeFileSync(voiceWav, wav(3));

// ---------- Part 1: dry runs ----------
function short(v, depth = 0) {
  if (typeof v === "string") return v.length > 90 ? `${v.slice(0, 60)}…<${v.length} chars>` : v;
  if (Array.isArray(v)) return v.map((x) => short(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, short(x, depth + 1)]));
  return v;
}

function sampleRequest(m) {
  const base = { kind: m.kind, model: m.id };
  switch (m.kind) {
    case "image":
      return { ...base, prompt: "Claudia waving at the camera, studio portrait", aspect: "4:5", ...(m.caps.needsRef || m.caps.edit ? { refs: [facePng] } : {}) };
    case "video":
      if (m.caps.edit) return { ...base, prompt: "Make it night time with neon lights", refs: ["https://example.com/source-clip.mp4"] };
      return { ...base, prompt: "Claudia turns and smiles, slow dolly-in, warm rose light", aspect: "9:16", durationSec: m.caps.durations?.[0] === 3 ? 5 : m.caps.durations?.[0] ?? 5, ...(m.caps.needsRef ? { refs: [facePng] } : {}) };
    case "speech":
      return { ...base, text: "gm. Claudia here, with today's top movers on Solana.", ...(m.provider === "elevenlabs" ? { voice: "JBFqnCBsd6RMkjVDRZzb" } : {}) };
    case "music":
      return { ...base, prompt: "Upbeat synth-pop intro, 120 bpm, bright and confident", durationSec: 30 };
    case "sfx":
      return { ...base, prompt: "Cash register cha-ching with a sparkle", durationSec: 2 };
    case "avatar":
      if (m.caps.needs?.includes("video")) return { ...base, refs: ["https://example.com/talking.mp4", "https://example.com/voice.mp3"] };
      if (m.provider === "heygen") return { ...base, text: "gm, here is your market update.", voice: "voice_demo_id", refs: [facePng], aspect: "9:16" };
      return { ...base, refs: [facePng, voiceWav], prompt: "Friendly, energetic delivery" };
  }
}

console.log(`\n== Part 1: dry-run requests (data dir ${work}) ==`);
const dry = createMedia({ keys: staticKeys(FAKE), dataDir: join(work, "dry"), dryRun: true });
const seen = new Set();
let dryCount = 0;
for (const m of MODEL_TABLE) {
  if (m.retired) {
    try {
      await dry.generate({ kind: m.kind, model: m.id, prompt: "x" });
      ok(false, `${m.id} is retired but generate() accepted it`);
    } catch (e) {
      ok(e instanceof ClaudiaMediaError && e.code === "unsupported", `${m.id} retired → refused (${e.hint ?? e.message})`);
    }
    continue;
  }
  const req = sampleRequest(m);
  const r = await dry.generate(req);
  dryCount++;
  seen.add(`${m.provider}×${m.kind}`);
  const text = JSON.stringify(r.request);
  const leaked = Object.values(FAKE).some((k) => text.includes(k));
  ok(r.dryRun === true && !leaked, `${m.id.padEnd(34)} ${r.request.method} ${r.request.url}  est $${r.estimate.usd} (${r.estimate.confidence})${m.unverified ? "  [unverified id]" : ""}`);
  if (FULL || !seen.has(`printed:${m.provider}×${m.kind}`)) {
    seen.add(`printed:${m.provider}×${m.kind}`);
    console.log(JSON.stringify(short({ headers: r.request.headers, body: r.request.body }), null, 2).replace(/^/gm, "         "));
  }
}
const pairs = [...seen].filter((s) => !s.startsWith("printed:"));
console.log(`  ${dryCount} dry-run requests over ${pairs.length} provider×kind pairs: ${pairs.join(", ")}`);

console.log("\n  checkModels (dry):");
for (const c of await dry.checkModels({ dryRun: true })) {
  console.log(`    ${c.provider.padEnd(11)} ${c.dryRun ? `${c.dryRun.method} ${c.dryRun.url.slice(0, 120)}` : c.note}${c.retired.length ? `  retired: ${c.retired.join(", ")}` : ""}`);
  if (c.dryRun) ok(!Object.values(FAKE).some((k) => JSON.stringify(c.dryRun).includes(k)), `${c.provider} checkModels request redacts the key`);
}
await dry.close();

// ---------- Part 2: mock lifecycle ----------
console.log("\n== Part 2: mock job lifecycle ==");
const log = [];
const state = { veoPolls: 0, falPolls: {}, fal429: false, submits: {} };
const MP4 = mp4(8, 1280, 720);
const PNG23 = png(2, 3);
const MP3 = mp3(4);
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

async function mockFetch(url, init = {}) {
  const method = init.method ?? "GET";
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  log.push({ method, url, headers });
  const u = new URL(url);
  // Google
  if (u.host === "generativelanguage.googleapis.com") {
    if (headers["x-goog-api-key"] !== FAKE.google) return json({ error: { message: "bad key" } }, 401);
    if (url.endsWith(":predictLongRunning")) {
      state.submits.veo = (state.submits.veo ?? 0) + 1;
      return json({ name: "models/veo-3.1-fast-generate-preview/operations/op123" });
    }
    if (u.pathname.endsWith("/operations/op123")) {
      state.veoPolls++;
      if (state.veoPolls < 2) return json({ name: "op123", done: false });
      return json({ name: "op123", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/vid123:download?alt=media" } }] } } });
    }
    if (u.pathname.includes("/files/vid123")) return new Response(MP4, { headers: { "content-type": "video/mp4" } });
  }
  // OpenAI
  if (u.host === "api.openai.com" && u.pathname === "/v1/images/generations") {
    if (headers.authorization !== `Bearer ${FAKE.openai}`) return json({ error: { message: "bad key" } }, 401);
    return json({ created: 1, output_format: "png", data: [{ b64_json: PNG23.toString("base64") }], usage: { input_tokens: 40, input_tokens_details: { text_tokens: 40, image_tokens: 0 }, output_tokens: 272, total_tokens: 312 } });
  }
  // ElevenLabs
  if (u.host === "api.elevenlabs.io" && u.pathname.startsWith("/v1/text-to-speech/")) return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
  // fal queue
  if (u.host === "queue.fal.run") {
    if (headers.authorization !== `Key ${FAKE.fal}`) return json({ detail: "bad key" }, 401);
    const m = u.pathname.match(/requests\/([^/]+)(\/status)?$/);
    if (method === "POST") {
      const id = `req_${Object.keys(state.falPolls).length + 1}`;
      state.falPolls[id] = 0;
      state.submits.fal = (state.submits.fal ?? 0) + 1;
      const app = "fal-ai/kling-video";
      return json({ request_id: id, status_url: `https://queue.fal.run/${app}/requests/${id}/status`, response_url: `https://queue.fal.run/${app}/requests/${id}`, cancel_url: `https://queue.fal.run/${app}/requests/${id}/cancel` });
    }
    if (m && m[2]) {
      const id = m[1];
      if (!state.fal429) {
        state.fal429 = true;
        return json({ detail: "slow down" }, 429, { "retry-after": "0.2" });
      }
      const n = ++state.falPolls[id];
      return json({ status: n < 2 ? "IN_QUEUE" : n < 3 ? "IN_PROGRESS" : "COMPLETED", request_id: id });
    }
    if (m && method === "PUT") return json({ status: "CANCELLATION_REQUESTED" }, 202);
    if (m) return json({ video: { url: `https://v3.fal.media/files/${m[1]}.mp4`, content_type: "video/mp4" } });
  }
  if (u.host === "v3.fal.media") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
  return json({ error: { message: `mock: no route for ${method} ${url}` } }, 404);
}

const dataDir = join(work, "live");
const keys = staticKeys({ google: FAKE.google, openai: FAKE.openai, fal: FAKE.fal, elevenlabs: FAKE.elevenlabs });
const limits = { perJobUsd: 3, perDayUsd: 20, approveAboveUsd: 1, perProvider: { fal: { perDayUsd: 5 } } };
const opts = { keys, dataDir, limits, fetch: mockFetch, poll: { minMs: 40, maxMs: 120 } };
let media = createMedia(opts);
const events = [];
media.on("job", (j) => events.push(`${j.id.slice(-4)}:${j.status}`));

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
async function expectError(code, fn, label) {
  try {
    await fn();
    ok(false, `${label} → expected ${code}`);
  } catch (e) {
    ok(e instanceof ClaudiaMediaError && e.code === code, `${label} → ${e.code}: ${e.message}${e.hint ? ` (hint: ${e.hint.slice(0, 70)}…)` : ""}`);
  }
}

// 1) sync image (OpenAI) with exact cost from usage
let job = await media.generate({ kind: "image", model: "openai/gpt-image-2.5-flare", prompt: "Claudia logo sticker", meta: { background: "transparent" }, brand: "claudia" });
ok(job.status === "queued", `image job queued immediately (${job.id})`);
job = await media.wait(job.id, { timeoutMs: 10_000 });
ok(job.status === "succeeded", `image job succeeded`);
const img = job.outputs[0];
ok(img && existsSync(img.path) && /library\/\d{4}-\d{2}\//.test(img.path), `image saved to library: ${img?.path.replace(work, "<tmp>")}`);
ok(img && img.mime === "image/png" && img.width === 2 && img.height === 3 && sha(img.path) === img.sha256, `image mime/dims/sha256 correct (${img?.width}x${img?.height}, ${img?.bytes} bytes)`);
ok(existsSync(`${img.path}.json`), "provenance sidecar written");
ok(job.provenance.costUsd === Math.round(((40 * 5 + 272 * 30) / 1e6) * 10000) / 10000, `exact cost from usage: $${job.provenance.costUsd} (estimate was $${job.estimate.usd})`);
ok(job.provenance.watermark === "C2PA" && job.provenance.prompt.includes("Style: Claudia"), "provenance has watermark + brand style in prompt");

// 2) Veo long-running op: submit → poll → download with key header
job = await media.generate({ kind: "video", model: "google/veo-3.1-fast", prompt: "Claudia winks", durationSec: 8 });
ok(job.estimate.usd === 0.8 && job.status === "queued", `veo job queued, estimate $${job.estimate.usd} (${job.estimate.basis})`);
job = await media.wait(job.id, { timeoutMs: 10_000 });
const vid = job.outputs[0];
ok(job.status === "succeeded" && vid?.durationSec === 8 && vid?.width === 1280 && vid?.height === 720, `veo video downloaded: ${vid?.durationSec}s ${vid?.width}x${vid?.height} ${vid?.mime}`);
const dl = log.find((l) => l.url.includes("/files/vid123"));
ok(dl?.headers["x-goog-api-key"] === FAKE.google, "Google file download sent the key header (required by Google)");

// 3) caps + approvals
await expectError("over_budget", () => media.generate({ kind: "video", model: "google/veo-3.1", prompt: "too pricey", durationSec: 8 }), "veo-3.1 8s ($3.20) over the $3 per-job cap");
job = await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "Claudia dances", durationSec: 10 });
ok(job.status === "needs_approval", `fal kling 10s ($${job.estimate.usd}) above $1 → needs_approval`);
const waited = await media.wait(job.id);
ok(waited.status === "needs_approval", "wait() resolves on needs_approval");
job = await media.approve(job.id);
ok(job.status === "queued", "approve() → queued");
job = await media.wait(job.id, { timeoutMs: 10_000 });
ok(job.status === "succeeded", `fal queue job succeeded after a 429 (Retry-After honoured): ${job.outputs[0]?.path.replace(work, "<tmp>")}`);
const cdn = log.find((l) => l.url.startsWith("https://v3.fal.media/"));
ok(cdn && !cdn.headers.authorization, "fal CDN download did NOT send the fal key");
ok(log.some((l) => l.url.endsWith("/status") && l.url.includes("fal-ai/kling-video/requests/")), "fal polled the returned status_url");
await expectError("over_budget", async () => {
  await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "x", durationSec: 10, }, { approve: true });
  await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "y", durationSec: 10 }, { approve: true });
  await media.generate({ kind: "video", model: "fal/kling-2.6-pro", prompt: "z", durationSec: 10 }, { approve: true });
}, "fal per-provider daily cap ($5) across queued jobs");
for (const j of media.listJobs({ status: "queued" })) await media.cancel(j.id);
ok(media.listJobs({ status: "queued" }).length === 0, "queued jobs canceled");
for (const j of media.listJobs()) if (["running", "downloading"].includes(j.status)) await media.wait(j.id, { timeoutMs: 10_000 });

// 4) restart: close mid-poll, reopen, job resumes from jobs.json without resubmitting
const submitsBefore = state.submits.fal;
job = await media.generate({ kind: "video", model: "fal/kling-2.5-turbo-pro", prompt: "Claudia at the beach", durationSec: 5 });
const resumeId = job.id;
await new Promise((resolve) => {
  const iv = setInterval(() => {
    const j = media.getJob(resumeId);
    if (j && j.status === "running" && j.progress === 0 && state.submits.fal === submitsBefore + 1) {
      clearInterval(iv);
      resolve();
    }
  }, 5);
});
await media.close();
const onDisk = JSON.parse(readFileSync(join(dataDir, "media", "jobs.json"), "utf8")).jobs.find((r) => r.job.id === resumeId);
ok(onDisk?.job.status === "running" && onDisk.remote?.statusUrl, `closed while running; jobs.json keeps remote state (${onDisk?.remote?.requestId})`);
media = createMedia(opts);
job = await media.wait(resumeId, { timeoutMs: 10_000 });
ok(job.status === "succeeded" && state.submits.fal === submitsBefore + 1, `restart resumed polling and finished without a second submit (submits: ${state.submits.fal - submitsBefore})`);

// 5) speech, brand kits, missing key, cancel
await media.brands.save({ id: "my-coin", name: "My Coin", refs: [facePng], voice: { provider: "elevenlabs", voiceId: "VOICE_FROM_BRAND" }, style: "neon, playful", banned: ["guaranteed"] });
job = await media.generate({ kind: "speech", model: "elevenlabs/flash-v2.5", text: "My Coin is live on Solana.", brand: "my-coin" });
job = await media.wait(job.id, { timeoutMs: 10_000 });
ok(job.status === "succeeded" && job.outputs[0]?.mime === "audio/mpeg" && Math.abs((job.outputs[0]?.durationSec ?? 0) - 4) < 0.2, `speech saved (${job.outputs[0]?.durationSec}s mp3)`);
ok(log.some((l) => l.url.includes("/text-to-speech/VOICE_FROM_BRAND")), "brand kit voice applied to ElevenLabs request");
await expectError("blocked", () => media.generate({ kind: "image", model: "fal/flux-dev", prompt: "guaranteed 100x", brand: "my-coin" }), "brand banned word");
await expectError("no_key", () => media.generate({ kind: "avatar", model: "heygen/avatar-iv", text: "hi", voice: "v" }), "HeyGen without a key");
job = await media.generate({ kind: "video", model: "fal/kling-3-pro", prompt: "x", durationSec: 10 });
job = await media.cancel(job.id);
ok(job.status === "canceled", "needs_approval job canceled");
ok(media.brands.get("claudia")?.style?.includes("peach-orange streak"), "default claudia brand kit present");

// 6) spend ledger
const s = media.spend();
console.log(`  spend: today $${s.today}, month $${s.month}, by provider ${JSON.stringify(s.byProvider)}`);
const expected = Math.round((media.listJobs({ status: "succeeded" }).reduce((a, j) => a + (j.provenance.costUsd ?? 0), 0)) * 10000) / 10000;
ok(Math.abs(s.today - expected) < 1e-6, `ledger total ($${s.today}) equals the cost of succeeded jobs ($${expected})`);
ok(existsSync(join(dataDir, "media", "spend.jsonl")) && existsSync(join(dataDir, "media", "brands.json")), "spend.jsonl and brands.json persisted");
console.log(`  events: ${events.length} job events in the first instance (e.g. ${events.slice(0, 5).join(", ")})`);
console.log(`  mock saw ${log.length} HTTP requests; none reached a real provider.`);
await media.close();

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
