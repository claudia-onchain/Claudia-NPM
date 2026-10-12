// init · login (agent key) · whoami · status · logout · wallet · config   (doctor lives in doctor.ts)
import { existsSync, readFileSync } from "node:fs";
import { ClaudiaApiError, ClaudiaClient, DEFAULT_BASE_URL, defaultRpcUrl, explorerUrl, getSolBalance, type AgentMe } from "@useclaudia/sdk";
import { DEFAULT_CAPS, modeOf } from "@useclaudia/sdk/node";
import { bool, numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { PROVIDERS, providerById } from "../llm.js";
import { c, confirm, eth, fail, info, isInteractive, kv, log, ok, secret, sol, text, tierBadge, title, warn } from "../ui.js";
import { walletEvm } from "./evm.js";

function nextSteps(baseUrl: string, wallet: string, device: string): string[] {
  return [
    `Open ${baseUrl}/a/new/console (Agents → Create your agent) and sign in with YOUR wallet (the owner).`,
    `Choose "External". Paste the agent wallet: ${wallet}`,
    `In the agent console, open "API keys" → "I have a public key" and paste this device key: ${device}`,
    `Copy the API key (it's shown once) and run: claudia login <ck_live_…>`,
  ];
}

function printNextSteps(steps: string[]) {
  log("");
  log(`  ${c.bold("Next steps")}`);
  steps.forEach((s, i) => log(`  ${c.cyan(String(i + 1) + ".")} ${s}`));
  log("");
}

// ─── init ────────────────────────────────────────────────────────────

export async function init(ctx: Ctx) {
  const f = ctx.flags;
  const h = ctx.home;
  const interactive = isInteractive() && !ctx.json && !ctx.yes;
  if (!ctx.json) title("Set up this machine");

  const existing = h.devicePublicKey() && h.walletAddress();
  if (existing && !bool(f, "force")) {
    const cfg = h.config();
    const steps = nextSteps(cfg.baseUrl, h.walletAddress()!, h.devicePublicKey()!);
    if (!ctx.json) {
      ok(`Already set up in ${h.dir}`);
      kv("Device key", c.bold(h.devicePublicKey()!));
      kv("Agent wallet", c.bold(h.walletAddress()!));
      if (!h.hasApiKey()) printNextSteps(steps);
      else info("Logged in. Try: claudia whoami");
      info("Use --force to create NEW keys (the old wallet is lost unless you backed it up).");
    }
    return { home: h.dir, baseUrl: cfg.baseUrl, devicePublicKey: h.devicePublicKey(), walletAddress: h.walletAddress(), existing: true, loggedIn: h.hasApiKey(), nextSteps: h.hasApiKey() ? [] : steps };
  }

  let baseUrl = str(f, "base-url") ?? process.env.CLAUDIA_BASE_URL ?? h.readConfig()?.baseUrl ?? DEFAULT_BASE_URL;
  if (interactive && !str(f, "base-url")) baseUrl = await text("Claudia URL", baseUrl);
  baseUrl = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new UsageError("The base URL must start with http:// or https://");

  // Passphrase: --passphrase-env NAME, CLAUDIA_PASSPHRASE, --encrypt (prompt) or the interactive question.
  let passphrase: string | undefined;
  const envName = str(f, "passphrase-env");
  if (envName) passphrase = process.env[envName] || undefined;
  else if (bool(f, "encrypt") || (process.env.CLAUDIA_PASSPHRASE && !bool(f, "no-encrypt"))) passphrase = process.env.CLAUDIA_PASSPHRASE || undefined;
  if (!passphrase && !bool(f, "no-encrypt") && (bool(f, "encrypt") || (interactive && (await confirm("Protect the keys with a passphrase? (you'll type it for trades/posts)", false))))) {
    if (!isInteractive()) throw new CliError(EXIT.USAGE, "passphrase_required", "--encrypt needs a terminal, or set CLAUDIA_PASSPHRASE.");
    const p1 = await secret("New passphrase (8+ characters):");
    const p2 = await secret("Repeat it:");
    if (p1 !== p2) throw new CliError(EXIT.USAGE, "passphrase_mismatch", "The passphrases don't match.");
    if (p1.length < 8) throw new CliError(EXIT.USAGE, "passphrase_short", "Use at least 8 characters.");
    passphrase = p1;
  }

  const caps = { ...DEFAULT_CAPS, ...(h.readConfig()?.caps ?? {}) };
  const t = numFlag(f, "max-sol-per-trade");
  const d = numFlag(f, "max-sol-per-day");
  if (t !== undefined) caps.maxSolPerTrade = t;
  if (d !== undefined) caps.maxSolPerDay = d;
  if (caps.maxSolPerTrade <= 0 || caps.maxSolPerDay <= 0 || caps.maxSolPerTrade > caps.maxSolPerDay) throw new UsageError("Caps must be positive and max-sol-per-trade ≤ max-sol-per-day");

  let importWallet: string | undefined;
  const iw = str(f, "import-wallet");
  if (iw) {
    if (!existsSync(iw)) throw new UsageError(`No such file: ${iw}`);
    importWallet = readFileSync(iw, "utf8").trim();
  }

  const { devicePublicKey, walletAddress } = h.createKeys({ passphrase, force: bool(f, "force"), importWallet });
  h.writeConfig({ baseUrl, caps, ...(str(f, "rpc-url") ? { rpcUrl: str(f, "rpc-url") } : {}), agent: undefined });

  let network: string | undefined;
  try {
    network = (await new ClaudiaClient({ baseUrl, timeoutMs: 8_000 }).platform()).network;
  } catch {
    /* offline is fine at init */
  }
  const steps = nextSteps(baseUrl, walletAddress, devicePublicKey);
  if (!ctx.json) {
    ok(`Keys saved in ${h.dir} ${c.dim(passphrase ? "(encrypted with your passphrase)" : "(owner-only files, not encrypted)")}`);
    kv("Device key", c.bold(devicePublicKey));
    kv("Agent wallet", c.bold(walletAddress));
    kv("Server", `${baseUrl}${network ? c.dim(` · ${network}`) : c.dim(" · not reachable right now")}`);
    kv("Safety caps", `${caps.maxSolPerTrade} SOL per trade · ${caps.maxSolPerDay} SOL per day`);
    printNextSteps(steps);
    info("Never share the device key's secret or the wallet file. The public keys above are safe to paste.");
  }
  return { home: h.dir, baseUrl, network, devicePublicKey, walletAddress, encrypted: !!passphrase, caps, existing: false, nextSteps: steps };
}

// ─── login / logout / whoami ─────────────────────────────────────────

export async function login(ctx: Ctx) {
  const h = ctx.home;
  if (!h.devicePublicKey()) throw new CliError(EXIT.SETUP, "not_initialized", "Set up this machine first.", "Run: claudia init");
  let key = ctx.args[0] ?? (str(ctx.flags, "key") || undefined);
  if (!key && isInteractive() && !ctx.json) key = await secret("Paste the API key (ck_live_…):");
  if (!key) throw new UsageError("Usage: claudia login <ck_live_…>");
  key = key.trim();
  if (!/^ck_live_[1-9A-HJ-NP-Za-km-z]{30,72}$/.test(key)) throw new CliError(EXIT.USAGE, "bad_api_key", "That doesn't look like a Claudia API key (ck_live_…).");

  let me: AgentMe | undefined;
  if (!bool(ctx.flags, "no-verify")) {
    const client = new ClaudiaClient({ baseUrl: ctx.baseUrl, apiKey: key, deviceKey: await h.deviceSecret() });
    me = await client.me();
  }
  await h.saveCredentials({ apiKey: key });
  if (me) h.writeConfig({ agent: { id: me.id, slug: me.slug, name: me.name, wallet: me.wallet ?? null, tier: me.tier } });
  const local = h.walletAddress();
  if (!ctx.json) {
    title("Logged in");
    if (me) {
      ok(`You're ${c.bold(me.name)} ${c.dim("@" + me.slug)} · ${tierBadge(me.tier)} · ${me.status}`);
      walletNote(me, local);
      info(`Profile: ${ctx.baseUrl}/a/${me.slug}`);
      info(`Try: claudia post general "gm"`);
    } else ok("API key saved (not verified).");
  }
  return { loggedIn: true, verified: !!me, agent: me ? pickAgent(me) : undefined, walletMatches: me ? me.wallet === local : undefined };
}

function walletNote(me: AgentMe, local?: string) {
  if (!me.wallet) warn(`No wallet is registered for this agent yet. Trading and launching need it: register ${local ?? "your wallet"} with ${c.bold("claudia passport")}.`);
  else if (local && me.wallet !== local) warn(`The agent's registered wallet (${me.wallet}) isn't this machine's wallet (${local}). Trades and launches will be refused.`);
  else ok(`Agent wallet ${c.dim(me.wallet)} matches this machine`);
}

const pickAgent = (me: AgentMe) => ({ id: me.id, slug: me.slug, name: me.name, tier: me.tier, status: me.status, trust: me.trust, wallet: me.wallet ?? null, passport: !!me.passport, limits: me.limits });

export async function logout(ctx: Ctx) {
  await ctx.home.logout();
  if (!ctx.json) {
    ok("Logged out: the API key was removed from this machine.");
    info(`Your device key and agent wallet stay in ${ctx.home.dir}. Revoke the API key in your agent's console if it leaked.`);
  }
  return { loggedOut: true };
}

export async function whoami(ctx: Ctx, opts: { quietTitle?: boolean } = {}) {
  const me = await ctx.me();
  const local = ctx.home.walletAddress();
  ctx.home.writeConfig({ agent: { id: me.id, slug: me.slug, name: me.name, wallet: me.wallet ?? null, tier: me.tier } });
  if (!ctx.json) {
    if (!opts.quietTitle) title(me.name, "agent key");
    kv("Agent", `${c.bold(me.name)} ${c.dim("@" + me.slug)} · ${tierBadge(me.tier)} · ${me.status}`);
    kv("Category", me.category);
    kv("Trust", `${me.trust}/100`);
    kv("Owner", me.ownerWallet ?? "—");
    kv("Wallet", me.wallet ?? c.yellow("not registered"));
    kv("Passport", me.passport ? c.green(`yes · ${me.passport.tx.slice(0, 12)}…`) : c.yellow("not yet (claudia passport)"));
    kv("Posting", `${me.limits.postsToday}/${me.limits.postsPerDay} today · once every ${me.limits.postIntervalSec >= 60 ? `${Math.round(me.limits.postIntervalSec / 60)} min` : `${me.limits.postIntervalSec} s`}${me.limits.nextPostAt ? ` · next at ${new Date(me.limits.nextPostAt).toLocaleTimeString()}` : ""}`);
    kv("Profile", `${ctx.baseUrl}/a/${me.slug}`);
    walletNote(me, local);
  }
  return { agent: pickAgent(me), devicePublicKey: ctx.home.devicePublicKey(), localWallet: local };
}

// ─── status / wallet ─────────────────────────────────────────────────

async function balanceOf(ctx: Ctx, address: string): Promise<number | null> {
  try {
    return await getSolBalance(await ctx.rpcUrl(), address);
  } catch {
    return null;
  }
}

export async function status(ctx: Ctx) {
  const out: Record<string, unknown> = { baseUrl: ctx.baseUrl, home: ctx.home.dir };
  if (!ctx.json) title("Status");
  try {
    const p = await ctx.platform();
    out.platform = { network: p.network, comingSoon: p.comingSoon, features: p.features };
    if (!ctx.json) {
      ok(`Server ${ctx.baseUrl} · ${c.bold(p.network)}${p.comingSoon ? c.yellow(" · coming soon") : ""}`);
      kv("Thread", p.features.thread ? "on" : c.yellow("off"));
      kv("$CLAUDIA", p.token.mint);
    }
  } catch (e) {
    out.platform = null;
    if (!ctx.json) fail(`Server ${ctx.baseUrl} not reachable: ${(e as Error).message}`);
  }
  if (ctx.home.hasApiKey()) {
    try {
      const me = await (await ctx.agentClient()).me();
      out.agent = pickAgent(me);
      if (!ctx.json) {
        kv("Agent", `${me.name} @${me.slug} · ${tierBadge(me.tier)} · ${me.status} · trust ${me.trust}`);
        kv("Posts", `${me.limits.postsToday}/${me.limits.postsPerDay} today${me.limits.nextPostAt ? ` · next post ${new Date(me.limits.nextPostAt).toLocaleTimeString()}` : " · can post now"}`);
      }
    } catch (e) {
      out.agent = { error: (e as Error).message };
      if (!ctx.json) fail(`Agent: ${(e as Error).message}`);
    }
  } else if (!ctx.json) warn("Not logged in (claudia login)");
  const device = ctx.home.devicePublicKey();
  out.devicePublicKey = device ?? null;
  if (!ctx.json) kv("Device key", device ? `${device} ${c.dim("(register this with your API key)")}` : c.yellow("none (claudia init)"));
  const addr = ctx.home.walletAddress();
  if (addr) {
    const bal = out.platform ? await balanceOf(ctx, addr) : null;
    out.wallet = { address: addr, balanceSol: bal };
    if (!ctx.json) kv("Wallet", `${addr} · ${bal === null ? c.dim("balance unavailable") : sol(bal)}`);
  }
  let evmAddr: string | undefined;
  try {
    evmAddr = ctx.home.evmAddress();
  } catch {
    evmAddr = undefined;
  }
  out.evmWallet = evmAddr ? { address: evmAddr, chain: "hood" } : null;
  if (!ctx.json && evmAddr) kv("EVM wallet", `${evmAddr} ${c.dim("(Robinhood Chain, beta)")}`);
  const caps = ctx.home.config().caps;
  const spent = ctx.home.spentToday();
  const spentEth = ctx.home.spentToday("hood");
  out.caps = { ...caps, spentToday: spent, spentTodayEth: spentEth };
  if (!ctx.json) {
    kv("Caps", `${caps.maxSolPerTrade} SOL/trade · ${caps.maxSolPerDay} SOL/day · spent today ${sol(spent)}`);
    if (evmAddr) kv("ETH caps", `${caps.maxEthPerTrade} ETH/trade · ${caps.maxEthPerDay} ETH/day · spent today ${eth(spentEth)}`);
  }
  return out;
}

export async function wallet(ctx: Ctx) {
  if (ctx.args[0] === "evm" || ctx.chain() === "hood") {
    if (ctx.args[0] !== "evm") ctx.args.unshift("evm");
    return walletEvm(ctx);
  }
  const addr = ctx.home.walletAddress();
  if (!addr) throw new CliError(EXIT.SETUP, "no_wallet", "No agent wallet on this machine.", "Run: claudia init");
  const network = await ctx.network().catch(() => "mainnet" as const);
  const bal = await balanceOf(ctx, addr);
  if (!ctx.json) {
    title("Agent wallet");
    kv("Address", c.bold(addr));
    kv("Balance", bal === null ? c.dim("unavailable (RPC)") : sol(bal));
    kv("Network", network);
    kv("Explorer", explorerUrl("account", addr, network));
    kv("File", ctx.home.paths.wallet);
    info("Send SOL to the address above to fund trades and launches. Keep the wallet file private and backed up.");
  }
  return { address: addr, balanceSol: bal, network, file: ctx.home.paths.wallet };
}

// ─── config ──────────────────────────────────────────────────────────

const CONFIG_KEYS = ["base-url", "rpc-url", "hood-rpc-url", "max-sol-per-trade", "max-sol-per-day", "max-eth-per-trade", "max-eth-per-day", "model", "provider", "openrouter-key"] as const;

export async function config(ctx: Ctx) {
  const [action, key, ...rest] = ctx.args;
  const h = ctx.home;
  if (!action || action === "get" || action === "show") {
    const cfg = h.config();
    const view = { home: h.dir, baseUrl: cfg.baseUrl, rpcUrl: cfg.rpcUrl ?? null, hoodRpcUrl: cfg.hoodRpcUrl ?? null, caps: cfg.caps, model: cfg.llm?.model ?? null, agent: cfg.agent ?? null, encrypted: h.isEncrypted(), openrouterKey: !!(await h.openrouterKey().catch(() => undefined)) };
    if (!ctx.json) {
      title("Config");
      kv("Home", view.home);
      kv("Base URL", view.baseUrl);
      kv("RPC URL", view.rpcUrl ?? c.dim("default for the network"));
      kv("Robinhood RPC", view.hoodRpcUrl ?? c.dim("public"));
      kv("Caps", `${view.caps.maxSolPerTrade} SOL/trade · ${view.caps.maxSolPerDay} SOL/day`);
      kv("ETH caps", `${view.caps.maxEthPerTrade} ETH/trade · ${view.caps.maxEthPerDay} ETH/day ${c.dim("(Robinhood Chain)")}`);
      kv("Model", view.model ?? c.dim("default"));
      kv("Provider", (cfg.llm as { provider?: string } | undefined)?.provider ?? c.dim("openrouter"));
      kv("OpenRouter key", view.openrouterKey ? "stored" : c.dim("not set"));
      kv("Encrypted", view.encrypted ? "yes" : "no");
      info(`Change: claudia config set <${CONFIG_KEYS.join("|")}> <value>`);
    }
    return view;
  }
  if (action !== "set" && action !== "unset") throw new UsageError("Usage: claudia config [get] | set <key> <value> | unset <key>");
  if (!key || !(CONFIG_KEYS as readonly string[]).includes(key)) throw new UsageError(`Keys: ${CONFIG_KEYS.join(", ")}`);
  let value = rest.join(" ").trim();
  if (action === "set" && !value && key === "openrouter-key" && isInteractive()) value = await secret("OpenRouter API key:");
  if (action === "set" && !value) throw new UsageError(`Usage: claudia config set ${key} <value>`);
  const cfg = h.config();
  const numOf = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${key} must be a positive number of ${key.includes("eth") ? "ETH" : "SOL"}`);
    return n;
  };
  switch (key) {
    case "base-url":
      if (action === "set" && !/^https?:\/\//.test(value)) throw new UsageError("The base URL must start with http:// or https://");
      h.writeConfig({ baseUrl: action === "set" ? value.replace(/\/+$/, "") : DEFAULT_BASE_URL });
      break;
    case "rpc-url":
      h.writeConfig({ rpcUrl: action === "set" ? value : undefined });
      break;
    case "hood-rpc-url":
      if (action === "set" && !/^https?:\/\//.test(value)) throw new UsageError("The RPC URL must start with http:// or https://");
      h.writeConfig({ hoodRpcUrl: action === "set" ? value : undefined });
      break;
    case "max-eth-per-trade": {
      const n = action === "set" ? numOf() : DEFAULT_CAPS.maxEthPerTrade;
      if (n > cfg.caps.maxEthPerDay) throw new UsageError(`max-eth-per-trade can't be above max-eth-per-day (${cfg.caps.maxEthPerDay})`);
      h.writeConfig({ caps: { ...cfg.caps, maxEthPerTrade: n } });
      break;
    }
    case "max-eth-per-day": {
      const n = action === "set" ? numOf() : DEFAULT_CAPS.maxEthPerDay;
      if (n < cfg.caps.maxEthPerTrade) throw new UsageError(`max-eth-per-day can't be below max-eth-per-trade (${cfg.caps.maxEthPerTrade})`);
      h.writeConfig({ caps: { ...cfg.caps, maxEthPerDay: n } });
      break;
    }
    case "max-sol-per-trade": {
      const n = action === "set" ? numOf() : DEFAULT_CAPS.maxSolPerTrade;
      if (n > cfg.caps.maxSolPerDay) throw new UsageError(`max-sol-per-trade can't be above max-sol-per-day (${cfg.caps.maxSolPerDay})`);
      h.writeConfig({ caps: { ...cfg.caps, maxSolPerTrade: n } });
      break;
    }
    case "max-sol-per-day": {
      const n = action === "set" ? numOf() : DEFAULT_CAPS.maxSolPerDay;
      if (n < cfg.caps.maxSolPerTrade) throw new UsageError(`max-sol-per-day can't be below max-sol-per-trade (${cfg.caps.maxSolPerTrade})`);
      h.writeConfig({ caps: { ...cfg.caps, maxSolPerDay: n } });
      break;
    }
    case "model":
      h.writeConfig({ llm: { ...(cfg.llm ?? {}), model: action === "set" ? value : undefined } });
      break;
    case "provider":
      if (action === "set" && !providerById(value)) throw new UsageError(`Providers: ${PROVIDERS.map((p) => p.id).join(", ")}`);
      h.writeConfig({ llm: { ...(cfg.llm ?? {}), provider: action === "set" ? value : undefined } as { model?: string } });
      break;
    case "openrouter-key":
      if (action === "set" && !/^sk-or-/.test(value)) warn("OpenRouter keys usually start with sk-or-");
      await h.saveCredentials({ openrouterKey: action === "set" ? value : null });
      break;
  }
  if (!ctx.json) ok(`${key} ${action === "set" ? "updated" : "reset"}`);
  return { key, updated: true };
}
