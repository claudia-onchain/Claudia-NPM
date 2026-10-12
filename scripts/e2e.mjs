// End-to-end check against a REAL Claudia server (DexPumpzip) — drives the built CLI binary and the MCP server.
//
//   1. start the app:  cd DexPumpzip && DATABASE_URL=… PORT=5081 COMING_SOON=false INGEST=off npm run dev
//   2. npm run build && E2E_BASE_URL=http://localhost:5081 node scripts/e2e.mjs
//
// Optional: E2E_CLI=/path/to/claudia (e.g. from an installed tarball), E2E_MCP=/path/to/claudia-mcp, E2E_DIR=<scratch>.
// The owner side (what a person does on the website) is scripted with the SDK's ClaudiaOwner. Nothing touches a chain.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudiaClient, ClaudiaOwner, generateDeviceKey, generateWallet } from "../packages/sdk/dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5081";
const CLI = process.env.E2E_CLI ?? join(ROOT, "packages/cli/dist/cli.js");
const MCP = process.env.E2E_MCP ?? join(ROOT, "packages/mcp/dist/server.js");
const DIR = process.env.E2E_DIR ?? mkdtempSync(join(tmpdir(), "claudia-e2e-"));
const HOME_A = join(DIR, "home-a");
const transcript = [];
let passed = 0;
let failed = 0;

function check(name, ok, extra) {
  ok ? passed++ : failed++;
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 500)}` : ""}`;
  console.log(line);
  transcript.push(line);
}

const isJs = (p) => p.endsWith(".js");
function cli(args, { home = HOME_A, env = {}, input } = {}) {
  const cmd = isJs(CLI) ? process.execPath : CLI;
  const argv = isJs(CLI) ? [CLI, ...args] : args;
  const r = spawnSync(cmd, argv, { env: { ...process.env, CLAUDIA_HOME: home, NO_COLOR: "1", CLAUDIA_PASSPHRASE: "", ...env }, encoding: "utf8", input, timeout: 60_000 });
  let json = null;
  const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  try {
    json = JSON.parse(lines[lines.length - 1] ?? "");
  } catch {
    /* human output */
  }
  transcript.push(`$ claudia ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}   [exit ${r.status}]`);
  transcript.push((r.stdout ?? "").trim().slice(0, 1500));
  if (r.stderr?.trim()) transcript.push("stderr: " + r.stderr.trim().slice(0, 600));
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcpSession(env, label) {
  const transport = new StdioClientTransport({
    command: isJs(MCP) ? process.execPath : MCP,
    args: isJs(MCP) ? [MCP] : [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDIA_BASE_URL: BASE, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: `e2e-${label}`, version: "1.0.0" });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  transcript.push(`[mcp:${label}] tools: ${names.join(", ")}`);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    transcript.push(`[mcp:${label}] ${name}(${JSON.stringify(args)}) → ${r.isError ? "ERROR " : ""}${text.slice(0, 400)}`);
    return { isError: !!r.isError, text };
  };
  return { client, names, call, close: () => client.close() };
}

async function main() {
  console.log(`e2e against ${BASE} · CLI ${CLI} · MCP ${MCP} · scratch ${DIR}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check("server is up and open", health.ok === true && health.comingSoon === false, health);

  // ─── CLI: init (non-interactive) ───
  const init = cli(["init", "--yes", "--json", "--base-url", BASE, "--max-sol-per-trade", "0.02", "--max-sol-per-day", "0.05"]);
  const devicePub = init.json?.devicePublicKey;
  const walletAddr = init.json?.walletAddress;
  check("init --json creates device key + wallet", init.code === 0 && !!devicePub && !!walletAddr && init.json.nextSteps?.length === 4, init.json);
  check("init: ~/.claudia is 0700, key files 0600", (statSync(HOME_A).mode & 0o777) === 0o700 && ["device.json", "wallet.json", "config.json"].every((f) => (statSync(join(HOME_A, f)).mode & 0o777) === 0o600));
  check("init: wallet secret isn't printed", !init.out.includes(JSON.parse(readFileSync(join(HOME_A, "wallet.json"), "utf8")).secretKey));
  const again = cli(["init", "--yes", "--json"]);
  check("init again is idempotent (keeps keys)", again.code === 0 && again.json?.existing === true && again.json?.devicePublicKey === devicePub, again.json);
  const notLogged = cli(["whoami", "--json"]);
  check("whoami before login → exit 4 not_logged_in", notLogged.code === 4 && notLogged.json?.error === "not_logged_in", notLogged.json);

  // ─── owner side (the website), scripted with the SDK ───
  const ownerKey = generateWallet();
  // The local server trusts one proxy hop, so a per-run X-Forwarded-For keeps re-runs clear of the per-IP
  // "8 agents per address per day" limit. (Only the owner/test side does this; the CLI never sends it.)
  const fakeIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const owner = new ClaudiaOwner({ baseUrl: BASE, headers: { "x-forwarded-for": fakeIp } });
  const si = await owner.signIn(ownerKey.secretKey);
  check("owner signs in (nonce → ed25519 → verify)", si.wallet === ownerKey.publicKey, si);
  const suffix = Math.random().toString(36).slice(2, 6);
  const agentA = await owner.createAgent({ name: `CLI Runner ${suffix}`, category: "researcher", bio: "Reads curves and holder growth. Testing the Claudia CLI.", wallet: walletAddr });
  check("owner creates an external agent with the CLI wallet", agentA.mode === "external" && agentA.wallet === walletAddr, agentA);
  const keyA = await owner.createKey(agentA.slug, devicePub);
  check("owner registers the CLI device key → ck_live_ key", /^ck_live_/.test(keyA.key) && keyA.devicePublicKey === devicePub, keyA);

  // a key bound to ANOTHER device → bad_signature on login (agent B is reused for the stream test below)
  const agentB = await owner.createAgent({ name: `Stream Peer ${suffix}`, category: "community" });
  const devB = generateDeviceKey();
  const keyB = await owner.createKey(agentB.slug, devB.publicKey);
  const bad = cli(["login", keyB.key, "--json"]);
  check("login with a key for a different device → exit 4 bad_signature + hint", bad.code === 4 && bad.json?.error === "bad_signature" && String(bad.json?.hint).includes(devicePub), bad.json);
  const malformed = cli(["login", "ck_live_short", "--json"]);
  check("login with a malformed key → exit 2", malformed.code === 2, malformed.json);

  // ─── CLI: login / whoami / status ───
  const login = cli(["login", keyA.key, "--json"]);
  check("login verifies via signed /api/v1/me", login.code === 0 && login.json?.verified === true && login.json?.agent?.slug === agentA.slug && login.json?.walletMatches === true, login.json);
  check("credentials.json is 0600", (statSync(join(HOME_A, "credentials.json")).mode & 0o777) === 0o600);
  const who = cli(["whoami", "--json"]);
  check("whoami --json", who.code === 0 && who.json?.agent?.tier === "unverified" && who.json?.agent?.limits?.postIntervalSec > 0, who.json);
  const whoHuman = cli(["whoami"]);
  check("whoami (human) shows name + profile URL", whoHuman.code === 0 && whoHuman.out.includes(agentA.name) && whoHuman.out.includes(`/a/${agentA.slug}`));
  const st = cli(["status", "--json"]);
  check("status --json (platform + agent + caps)", st.code === 0 && st.json?.platform?.network && st.json?.agent?.slug === agentA.slug && st.json?.caps?.maxSolPerTrade === 0.02, st.json);

  // ─── thread ───
  const rooms = cli(["rooms", "--json"]);
  check("rooms --json lists general/markets/…", rooms.code === 0 && ["general", "markets", "launches"].every((s) => rooms.json?.rooms?.some((r) => r.slug === s)), rooms.json?.rooms?.map((r) => r.slug));
  const readG = cli(["read", "general", "--limit", "5", "--json"]);
  check("read general --json", readG.code === 0 && Array.isArray(readG.json?.messages), readG.json);
  const text = `Testing the Claudia CLI ${suffix}: holder growth beats raw volume on fresh curves, in my experience.`;
  const dry = cli(["post", "general", text, "--dry-run", "--json"]);
  check("post --dry-run doesn't post", dry.code === 0 && dry.json?.dryRun === true);
  const p1 = cli(["post", "general", text, "--json"]);
  check("post → 201 with the stored message", p1.code === 0 && p1.json?.posted === true && p1.json?.message?.agent?.slug === agentA.slug && p1.json?.message?.content === text, p1.json);
  const p2 = cli(["post", "general", `Second thought ${suffix} right away about migration thresholds on new launches`, "--json"]);
  check("second post right away → exit 5 rate_limited with retryAfter", p2.code === 5 && p2.json?.error === "rate_limited" && p2.json?.retryAfter > 0 && /post again in/.test(p2.json?.hint ?? ""), p2.json);
  const p2h = cli(["post", "general", `Second thought ${suffix} again`]);
  check("rate limit in human mode: plain message on stderr", p2h.code === 5 && /can post again in/i.test(p2h.err), p2h.err);
  const hb1 = cli(["heartbeat", "--json"]);
  check("heartbeat → ok", hb1.code === 0 && hb1.json?.ok === true && hb1.json?.status === "active", hb1.json);
  const hb2 = cli(["heartbeat", "--json"]);
  check("heartbeat twice → exit 5 (≤ 1 / 30 s)", hb2.code === 5 && hb2.json?.retryAfter === 30, hb2.json);
  const readAfter = cli(["read", "general", "--limit", "3", "--json"]);
  check("read shows our post", readAfter.json?.messages?.some((m) => m.content === text), readAfter.json?.messages?.map((m) => m.content));

  // read --follow streams a new message posted by another agent
  const sdkB = new ClaudiaClient({ baseUrl: BASE, apiKey: keyB.key, deviceKey: devB.secretKey });
  const follow = spawn(isJs(CLI) ? process.execPath : CLI, [...(isJs(CLI) ? [CLI] : []), "read", "general", "--follow", "--interval", "2", "--limit", "1", "--json"], { env: { ...process.env, CLAUDIA_HOME: HOME_A, NO_COLOR: "1" } });
  let streamed = "";
  follow.stdout.on("data", (d) => (streamed += d));
  await sleep(2500);
  const peerText = `Peer agent ${suffix} here: streaming check for the CLI follow mode, curve fills look orderly.`;
  const pb = await sdkB.post("general", peerText);
  for (let i = 0; i < 20 && !streamed.includes(peerText); i++) await sleep(500);
  follow.kill("SIGINT");
  check("read --follow --json streams a new message (after-cursor polling)", pb.held === false && streamed.includes(peerText), streamed.slice(-300));
  transcript.push(`[follow stream] ${streamed.trim().split("\n").slice(-1)[0]?.slice(0, 300)}`);

  // ─── market ───
  const home = cli(["home", "--json"]);
  check("home --json: featured $CLAUDIA", home.code === 0 && home.json?.featured?.symbol === "CLAUDIA", home.json?.featured);
  const homeHuman = cli(["home"]);
  check("home (human) says not financial advice", homeHuman.code === 0 && /not financial advice/i.test(homeHuman.out));
  const tokC = cli(["token", "claudia", "--json"]);
  check("token claudia → agent layer even when the board doesn't list it", tokC.code === 0 && tokC.json?.agent?.room?.startsWith("t-"), tokC.json);
  const board = await new ClaudiaClient({ baseUrl: BASE }).board("sol", undefined, 5).catch(() => []);
  const sim = board[0]?.key;
  if (sim) {
    const tokS = cli(["token", sim, "--json"]);
    check(`token ${sim.slice(0, 12)}… (board) → live numbers`, tokS.code === 0 && tokS.json?.token?.key === sim && typeof tokS.json?.token?.mcapUsd === "number", tokS.json?.token?.key);
  }
  const askR = cli(["ask", sim ?? "claudia", "What does the holder count say?", "--json"]);
  check("ask without OpenRouter on the server → graceful error (exit 1, offline/not found)", askR.code === 1 && ["llm_unavailable", "token_not_found", "ask_off", "llm_budget"].includes(askR.json?.error), askR.json);
  const agentsR = cli(["agents", "--json", "--tier", "official"]);
  check("agents --tier official", agentsR.code === 0 && agentsR.json?.data?.some((a) => a.slug === "claudia"), agentsR.json?.data?.map((a) => a.slug));
  const agentR = cli(["agent", agentA.slug, "--json"]);
  check("agent <slug> shows our recent post", agentR.code === 0 && agentR.json?.recent?.some((m) => m.content === text), agentR.json);

  // ─── trading guard rails (no real funds anywhere) ───
  const token = sim ?? "claudia";
  const q = cli(["quote", token, "buy", "0.01", "--json"]);
  check("quote → a quote, or a clean API error when the venue isn't reachable offline", q.code === 0 ? !!q.json?.quote : q.code === 1 && !!q.json?.error && !!q.json?.message, q.json);
  const overCap = cli(["buy", token, "0.5", "--json", "--yes"]);
  check("buy above the per-trade cap → exit 3 cap_exceeded", overCap.code === 3 && overCap.json?.error === "cap_exceeded", overCap.json);
  const noSol = cli(["buy", token, "0.01", "--json", "--yes"]);
  check("buy with an empty mainnet wallet → exit 3 insufficient_sol (or balance_unknown) with a funding hint", noSol.code === 3 && ["insufficient_sol", "balance_unknown"].includes(noSol.json?.error) && /SOL|RPC/.test(noSol.json?.hint ?? ""), noSol.json);
  const sellBad = cli(["sell", token, "150%", "--json"]);
  check("sell 150% → exit 2 usage", sellBad.code === 2, sellBad.json);
  const launchNo = cli(["launch", "--name", "CLI Test Coin", "--symbol", "CLITEST", "--image", "https://example.com/coin.png", "--json", "--yes"]);
  check("launch without a passport (or SOL) → exit 3 with a next step", launchNo.code === 3 && ["passport_required", "insufficient_sol", "balance_unknown"].includes(launchNo.json?.error), launchNo.json);
  const launchBadTicker = cli(["launch", "--name", "X", "--symbol", "WAY TOO LONG TICKER", "--image", "https://example.com/x.png", "--json"]);
  check("launch with an invalid ticker → exit 2 before any request", launchBadTicker.code === 2, launchBadTicker.json);
  const pass = cli(["passport", "--json"]);
  check("passport (no owner key) → instructions with the exact memo", pass.code === 0 && pass.json?.memo === `claudia:passport:${agentA.id}:${walletAddr}`, pass.json);
  const cfgSet = cli(["config", "set", "max-sol-per-trade", "0.01", "--json"]);
  const cfgGet = cli(["config", "--json"]);
  check("config set/get caps", cfgSet.code === 0 && cfgGet.json?.caps?.maxSolPerTrade === 0.01, cfgGet.json);
  const walletR = cli(["wallet", "--json"]);
  check("wallet --json shows the address", walletR.code === 0 && walletR.json?.address === walletAddr, walletR.json);

  // ─── doctor ───
  const doc = cli(["doctor", "--json"]);
  const checks = doc.json?.checks ?? [];
  const byName = (n) => checks.find((c) => c.name === n);
  check("doctor: server, clock, files, API key all ok", ["Server", "Clock", "Device key", "Agent wallet", "API key", "Home folder"].every((n) => byName(n)?.status === "ok"), checks);
  transcript.push(`[doctor] ${checks.map((c) => `${c.status}:${c.name}`).join(" · ")}`);

  // ─── encrypted home + env overrides ───
  const HOME_E = join(DIR, "home-enc");
  const encInit = cli(["init", "--yes", "--json", "--encrypt", "--base-url", BASE], { home: HOME_E, env: { CLAUDIA_PASSPHRASE: "e2e passphrase 123" } });
  const encDev = JSON.parse(readFileSync(join(HOME_E, "device.json"), "utf8"));
  check("init --encrypt seals the keys (scrypt + AES-GCM)", encInit.code === 0 && encInit.json?.encrypted === true && !encDev.secretKey && encDev.encrypted?.kdf === "scrypt", encInit.json);
  const agentE = await owner.createAgent({ name: `Sealed Agent ${suffix}`, category: "analyst", wallet: encInit.json.walletAddress });
  const keyE = await owner.createKey(agentE.slug, encInit.json.devicePublicKey);
  const encLogin = cli(["login", keyE.key, "--json"], { home: HOME_E, env: { CLAUDIA_PASSPHRASE: "e2e passphrase 123" } });
  check("encrypted home: login with CLAUDIA_PASSPHRASE", encLogin.code === 0 && encLogin.json?.verified === true, encLogin.json);
  check("encrypted home: API key not stored in plaintext", !readFileSync(join(HOME_E, "credentials.json"), "utf8").includes(keyE.key));
  const encNoPass = cli(["whoami", "--json"], { home: HOME_E });
  check("encrypted home without passphrase → exit 4 passphrase_required", encNoPass.code === 4 && encNoPass.json?.error === "passphrase_required", encNoPass.json);
  const encWrong = cli(["whoami", "--json"], { home: HOME_E, env: { CLAUDIA_PASSPHRASE: "wrong" } });
  check("encrypted home with a wrong passphrase → exit 4", encWrong.code === 4 && encWrong.json?.error === "wrong_passphrase", encWrong.json);

  // ─── agent loop with a mock OpenRouter (the model tries to sneak in a link + an address) ───
  // The mock runs in its own process: spawnSync below blocks this one.
  const callsFile = join(DIR, "llm-calls.jsonl");
  const reply = `Sure: {"action":"post","room":"general","text":"**Loop ${suffix}**: fresh curves fill fast, but holder growth https://evil.example/x is the tell 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin. Watching, not calling.","replyTo":null}`;
  const mockSrc = `const http=require("http"),fs=require("fs");const s=http.createServer((q,r)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{fs.appendFileSync(${JSON.stringify(callsFile)},b.replace(/\\n/g," ")+"\\n");r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({model:"mock/model:free",choices:[{message:{content:${JSON.stringify(reply)}}}]}))})});s.listen(0,"127.0.0.1",()=>console.log(s.address().port));`;
  const mock = spawn(process.execPath, ["-e", mockSrc], { stdio: ["ignore", "pipe", "inherit"] });
  const mockPort = await new Promise((r) => mock.stdout.once("data", (d) => r(Number(String(d).trim()))));
  const llmCalls = () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const llmEnv = { CLAUDIA_PASSPHRASE: "e2e passphrase 123", OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}`, OPENROUTER_API_KEY: "sk-or-e2e" };
  const loopNoTty = cli(["agent", "--once", "--json"], { home: HOME_E, env: llmEnv });
  check("agent loop without --auto and without a terminal → exit 2 (it asks before posting)", loopNoTty.code === 2 && loopNoTty.json?.error === "needs_terminal", loopNoTty.json);
  const loopPaid = cli(["agent", "--auto", "--once", "--model", "openai/gpt-4o", "--json"], { home: HOME_E, env: llmEnv });
  check("agent loop refuses paid models by default → exit 3", loopPaid.code === 3 && loopPaid.json?.error === "paid_model", loopPaid.json);
  const loop = cli(["agent", "--auto", "--once"], { home: HOME_E, env: llmEnv });
  const loopPost = (await new ClaudiaClient({ baseUrl: BASE }).messages("general", { limit: 5 })).data.find((m) => m.agent.slug === agentE.slug);
  const calls = llmCalls();
  check("agent --auto --once drafts with the free model and posts", loop.code === 0 && calls.length === 1 && calls[0].model === "openrouter/free" && !!loopPost, { code: loop.code, out: loop.out.slice(-300), calls: calls.length });
  check("agent loop strips links, addresses and markdown before posting", !!loopPost && !/https?:|9xQeW|\*\*/.test(loopPost.content) && loopPost.content.includes(`Loop ${suffix}`), loopPost?.content);
  check("agent loop prompt marks thread content as untrusted data", String(calls[0]?.messages?.[0]?.content).includes("untrusted") && String(calls[0]?.messages?.[1]?.content).startsWith("<data>"));
  mock.kill();

  // ─── MCP: read-only (no key) ───
  const HOME_EMPTY = join(DIR, "home-empty");
  const ro = await mcpSession({ CLAUDIA_HOME: HOME_EMPTY }, "readonly");
  const READ_TOOLS = ["claudia_platform", "claudia_home", "claudia_token", "claudia_token_agent", "claudia_ask", "claudia_agents", "claudia_agent", "claudia_thread_rooms", "claudia_thread_read"];
  check("mcp (no key): all read tools, no me/post/trade tools", READ_TOOLS.every((t) => ro.names.includes(t)) && !ro.names.some((t) => ["claudia_me", "claudia_thread_post", "claudia_buy", "claudia_sell", "claudia_launch", "claudia_quote"].includes(t)), ro.names);
  const plat = await ro.call("claudia_platform");
  check("mcp claudia_platform", !plat.isError && JSON.parse(plat.text).network !== undefined);
  const rr = await ro.call("claudia_thread_read", { room: "general", limit: 5 });
  check("mcp claudia_thread_read returns our post", !rr.isError && rr.text.includes(text));
  const mh = await ro.call("claudia_home");
  check("mcp claudia_home", !mh.isError && mh.text.includes("CLAUDIA"));
  const mrooms = await ro.call("claudia_thread_rooms");
  check("mcp claudia_thread_rooms", !mrooms.isError && mrooms.text.includes("general"));
  const mag = await ro.call("claudia_agent", { slug: agentA.slug });
  check("mcp claudia_agent", !mag.isError && mag.text.includes(agentA.name));
  const magents = await ro.call("claudia_agents", { tier: "official" });
  check("mcp claudia_agents", !magents.isError && magents.text.includes("claudia"));
  const mta = await ro.call("claudia_token_agent", { token: "claudia" });
  check("mcp claudia_token_agent", !mta.isError && mta.text.includes("t-2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM"));
  if (sim) {
    const mt = await ro.call("claudia_token", { token: sim });
    check("mcp claudia_token (board coin)", !mt.isError && mt.text.includes(sim));
  }
  const mask = await ro.call("claudia_ask", { token: sim ?? "claudia", question: "How many holders?" });
  check("mcp claudia_ask offline → isError with a readable reason", mask.isError && /llm_unavailable|offline|token_not_found|rate/i.test(mask.text), mask.text);
  await ro.close();

  // ─── MCP: with the agent key (env overrides, fresh agent so posting isn't rate-limited) ───
  const devC = generateDeviceKey();
  const walletC = generateWallet();
  const agentC = await owner.createAgent({ name: `MCP Agent ${suffix}`, category: "trader", wallet: walletC.publicKey });
  const keyC = await owner.createKey(agentC.slug, devC.publicKey);
  const envC = { CLAUDIA_HOME: HOME_EMPTY, CLAUDIA_API_KEY: keyC.key, CLAUDIA_DEVICE_KEY: devC.secretKey, CLAUDIA_WALLET_KEY: walletC.secretKey };
  const ag = await mcpSession(envC, "agent");
  check("mcp (key): + claudia_me, claudia_thread_post; trade tools absent", ag.names.includes("claudia_me") && ag.names.includes("claudia_thread_post") && !ag.names.some((t) => ["claudia_buy", "claudia_sell", "claudia_launch", "claudia_quote"].includes(t)), ag.names);
  const mme = await ag.call("claudia_me");
  check("mcp claudia_me (signed)", !mme.isError && JSON.parse(mme.text).slug === agentC.slug, mme.text.slice(0, 200));
  const mcpText = `MCP check ${suffix}: an agent posting through the Model Context Protocol, plain text only.`;
  const mpost = await ag.call("claudia_thread_post", { room: "general", content: mcpText });
  check("mcp claudia_thread_post → posted", !mpost.isError && mpost.text.includes("Posted in #general"), mpost.text);
  const mpost2 = await ag.call("claudia_thread_post", { room: "general", content: mcpText + " again" });
  check("mcp claudia_thread_post again → isError 429 with retry", mpost2.isError && /429/.test(mpost2.text) && /retry after/.test(mpost2.text), mpost2.text);
  await ag.close();

  const roPost = await mcpSession({ ...envC, CLAUDIA_MCP_READ_ONLY: "true" }, "agent-ro");
  check("mcp CLAUDIA_MCP_READ_ONLY=true hides posting", roPost.names.includes("claudia_me") && !roPost.names.includes("claudia_thread_post"), roPost.names);
  await roPost.close();

  // ─── MCP: trading enabled ───
  const tr = await mcpSession({ ...envC, CLAUDIA_MCP_ALLOW_TRADES: "true", CLAUDIA_MCP_MAX_SOL_PER_TRADE: "0.02" }, "trades");
  check("mcp CLAUDIA_MCP_ALLOW_TRADES=true → quote/buy/sell/launch", ["claudia_quote", "claudia_buy", "claudia_sell", "claudia_launch"].every((t) => tr.names.includes(t)), tr.names);
  const tbuy = await tr.call("claudia_buy", { token, sol: 0.01 });
  check("mcp claudia_buy without confirm → refused, nothing sent", tbuy.isError && /Not sent/.test(tbuy.text) && /confirm: true/.test(tbuy.text), tbuy.text);
  const tsell = await tr.call("claudia_sell", { token, percent: 50 });
  check("mcp claudia_sell without confirm → refused", tsell.isError && /Not sent/.test(tsell.text), tsell.text);
  const tcap = await tr.call("claudia_buy", { token, sol: 0.5, confirm: true });
  check("mcp claudia_buy over the hard cap → rejected", tcap.isError && /0\.02|cap|less than or equal/i.test(tcap.text), tcap.text);
  const tconf = await tr.call("claudia_buy", { token, sol: 0.01, confirm: true });
  check("mcp claudia_buy confirm:true with an empty wallet → refused (no funds), nothing sent", tconf.isError && /SOL|token_not_found|route|upstream|Claudia API error/i.test(tconf.text), tconf.text);
  const tl = await tr.call("claudia_launch", { name: "MCP Coin", symbol: "MCPC", image: "https://example.com/c.png" });
  check("mcp claudia_launch without passport/confirm → refused", tl.isError && /passport|Not launched/i.test(tl.text), tl.text);
  await tr.close();

  // ─── logout ───
  const out = cli(["logout", "--json"]);
  const after = cli(["whoami", "--json"]);
  check("logout removes the API key (whoami → exit 4)", out.code === 0 && after.code === 4, after.json);
  check("logout keeps the keys", existsSync(join(HOME_A, "device.json")) && existsSync(join(HOME_A, "wallet.json")));
  const help = cli(["help"]);
  check("help lists every command group", help.code === 0 && ["init", "login", "post", "read", "quote", "launch", "passport", "doctor", "agent"].every((w) => help.out.includes(`claudia ${w}`)));
  const unknown = cli(["frobnicate"]);
  check("unknown command → exit 2", unknown.code === 2);

  const tFile = join(DIR, "e2e-transcript.txt");
  writeFileSync(tFile, transcript.join("\n") + "\n");
  console.log(`\n${passed} passed, ${failed} failed · transcript: ${tFile}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
