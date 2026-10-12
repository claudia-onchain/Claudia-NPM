// End-to-end: the passport flow and the launch/buy paths behind the passport + balance guards, against a real
// Claudia server whose Solana RPC is the local mock (scripts/mock-solana-rpc.mjs). No real chain is touched.
//
//   node scripts/mock-solana-rpc.mjs 5089 &
//   (DexPumpzip) SOL_RPC_URL=http://127.0.0.1:5089 DATABASE_URL=… PORT=5081 COMING_SOON=false INGEST=off npm run dev
//   E2E_BASE_URL=http://localhost:5081 E2E_RPC_URL=http://127.0.0.1:5089 node scripts/e2e-passport.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudiaOwner, generateWallet, toKeypair } from "../packages/sdk/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5081";
const RPC = process.env.E2E_RPC_URL ?? "http://127.0.0.1:5089";
const CLI = process.env.E2E_CLI ?? join(ROOT, "packages/cli/dist/cli.js");
const DIR = process.env.E2E_DIR ?? mkdtempSync(join(tmpdir(), "claudia-e2e-pp-"));
const HOME = join(DIR, "home");
const out = [];
let passed = 0;
let failed = 0;
const check = (name, ok, extra) => {
  ok ? passed++ : failed++;
  const l = `${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 500)}` : ""}`;
  console.log(l);
  out.push(l);
};
function cli(args, env = {}) {
  const js = CLI.endsWith(".js");
  const r = spawnSync(js ? process.execPath : CLI, js ? [CLI, ...args] : args, { env: { ...process.env, CLAUDIA_HOME: HOME, CLAUDIA_RPC_URL: RPC, NO_COLOR: "1", ...env }, encoding: "utf8", timeout: 120_000 });
  let json = null;
  try {
    json = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "");
  } catch {
    /* human */
  }
  out.push(`$ claudia ${args.join(" ")}   [exit ${r.status}]`, (r.stdout ?? "").trim().slice(0, 1500), r.stderr?.trim() ? "stderr: " + r.stderr.trim().slice(0, 600) : "");
  return { code: r.status, json, out: r.stdout, err: r.stderr };
}

const init = cli(["init", "--yes", "--json", "--base-url", BASE]);
check("init", init.code === 0, init.json);
const ownerKey = generateWallet();
const ownerFile = join(DIR, "owner.json");
writeFileSync(ownerFile, JSON.stringify(Array.from(toKeypair(ownerKey.secretKey).secretKey)), { mode: 0o600 });
const fakeIp = `10.77.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const owner = new ClaudiaOwner({ baseUrl: BASE, headers: { "x-forwarded-for": fakeIp } });
await owner.signIn(ownerKey.secretKey);
const suffix = Math.random().toString(36).slice(2, 6);
const agent = await owner.createAgent({ name: `Passport Pilot ${suffix}`, category: "trader", wallet: init.json.walletAddress });
const key = await owner.createKey(agent.slug, init.json.devicePublicKey);
check("login", cli(["login", key.key, "--json"]).code === 0);

const info = cli(["passport", "--json"]);
check("passport without --owner-keypair → instructions + exact memo", info.code === 0 && info.json?.memo === `claudia:passport:${agent.id}:${init.json.walletAddress}`, info.json);
const wrongOwner = join(DIR, "not-owner.json");
writeFileSync(wrongOwner, JSON.stringify(Array.from(toKeypair(generateWallet().secretKey).secretKey)), { mode: 0o600 });
const wo = cli(["passport", "--owner-keypair", wrongOwner, "--yes", "--json"]);
check("passport with someone else's keypair → exit 3 not_owner", wo.code === 3 && wo.json?.error === "not_owner", wo.json);
const noYes = cli(["passport", "--owner-keypair", ownerFile, "--json"]);
check("passport without --yes (no terminal) → exit 3, nothing sent", noYes.code === 3 && noYes.json?.error === "confirmation_required", noYes.json);
const dry = cli(["passport", "--owner-keypair", ownerFile, "--dry-run", "--json"]);
check("passport --dry-run → summary only", dry.code === 0 && dry.json?.dryRun === true && dry.json?.memo?.startsWith("claudia:passport:"), dry.json);
const pp = cli(["passport", "--owner-keypair", ownerFile, "--yes", "--json"]);
check("passport --owner-keypair --yes → memo signed by the owner, sent, verified by the server, registered", pp.code === 0 && pp.json?.registered === true && pp.json?.passport?.owner === ownerKey.publicKey && pp.json?.wallet === init.json.walletAddress, pp.json);
const who = cli(["whoami", "--json"]);
check("whoami shows the passport", who.json?.agent?.passport === true, who.json?.agent);
const again = cli(["passport", "--json"]);
check("passport again → already registered", again.code === 0 && again.json?.already === true);
check("the owner's secret key was never written into ~/.claudia", spawnSync("grep", ["-rl", ownerKey.secretKey, HOME], { encoding: "utf8" }).stdout.trim() === "");

// Behind the guards now: passport ok, mock balance 1 SOL. The launch is planned by the real server; with a local dev
// upload on mainnet the server refuses non-public URIs, which proves upload → plan ran. Nothing is ever sent.
const png = join(DIR, "coin.png");
writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex"));
const notImg = join(DIR, "notes.png");
writeFileSync(notImg, "not an image");
const li = cli(["launch", "--name", "Pilot Coin", "--symbol", "PILOT", "--image", notImg, "--dry-run", "--json"]);
check("launch with a non-image file → exit 2 before uploading", li.code === 2, li.json);
const lp = cli(["launch", "--name", "Pilot Coin", "--symbol", "PILOT", "--image", png, "--dev-buy", "0.01", "--dry-run", "--json"]);
check("launch --dry-run → uploads, asks the server to plan; a plan, or a clean server refusal (never sends)", lp.json && (lp.json.dryRun === true || (lp.code === 1 && !!lp.json.error)), lp.json);
const lcap = cli(["launch", "--name", "Pilot Coin", "--symbol", "PILOT", "--image", png, "--dev-buy", "1", "--yes", "--json"]);
check("launch with a dev buy over the cap → exit 3", lcap.code === 3 && lcap.json?.error === "cap_exceeded", lcap.json);
const board = await fetch(`${BASE}/api/board?chain=sol&limit=1`).then((r) => r.json()).catch(() => []);
if (board[0]) {
  const b = cli(["buy", board[0].key, "0.01", "--yes", "--json"]);
  check("buy with funds passes the guards and reaches the quote (offline venue → clean exit 1, nothing signed)", b.code === 1 && !!b.json?.error, b.json);
}

// Full launch through the CLI (only when the server allows a plan here: PUMP_ALLOW_SPLIT_LAYOUT=true or a LUT).
// The mock RPC "lands" the signed transactions; the server then verifies the creator's signatures in /api/launch/confirm.
const full = cli(["launch", "--name", "Pilot Coin", "--symbol", "PILOT", "--image", "https://example.com/coin.png", "--metadata-uri", "https://example.com/meta.json", "--dev-buy", "0.01", "--yes", "--force", "--json"]);
if (full.json?.error === "split_not_atomic") console.log("SKIP  full CLI launch (server has no pump LUT; start it with PUMP_ALLOW_SPLIT_LAYOUT=true to run it)");
else {
  check("launch --yes (mock chain) → plan → sign (mint signature kept) → send → /api/launch/confirm accepts the creator's signatures", full.code === 0 && !!full.json?.mint && full.json?.signatures?.length >= 1 && ["submitted", "confirmed", "unverified"].includes(full.json?.status), full.json);
  const ledger = JSON.parse(readFileSync(join(HOME, "spend.json"), "utf8"));
  check("the launch was recorded in the local spend ledger", Object.values(ledger.days).some((d) => d.entries.some((e) => e.kind === "launch")));
}

writeFileSync(join(DIR, "e2e-passport-transcript.txt"), out.filter(Boolean).join("\n") + "\n");
console.log(`\n${passed} passed, ${failed} failed · transcript: ${join(DIR, "e2e-passport-transcript.txt")}`);
process.exit(failed ? 1 : 0);
