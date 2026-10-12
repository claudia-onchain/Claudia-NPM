// Robinhood Chain (beta) and the chain list: chains · wallet evm · quote/buy/sell/launch --chain hood · fees · harvest.
// The server builds unsigned EVM transactions; the EVM wallet in ~/.claudia (evm-wallet.json, same encryption as the
// Solana wallet) signs them locally through @useclaudia/sdk/evm (needs viem). Same guard rails as Solana: ETH caps,
// a balance check, a plain summary, an explicit confirmation, and --dry-run stops before anything is signed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ROBINHOOD_LAUNCHPADS, chainExplorerUrl, explorerUrl, imageTypeOf, sendAndConfirm, signTransactions, normalizeCoinName, normalizeTicker, toTokenKey, type ChainStatusInfo, type PlannedLaunch, type PreparedTrade } from "@useclaudia/sdk";
import { checkCaps } from "@useclaudia/sdk/node";
import { bool, numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { isInteractive, secret } from "../ui.js";
import { ago, c, eth, info, kv, log, native, ok, short, sym, table, title, warn, withSpinner } from "../ui.js";

/** ETH kept aside for gas on top of the amount itself. */
const GAS_RESERVE_ETH = 0.0005;
const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

const STATUS_LABEL: Record<string, string> = { live: "live", beta: "beta", view_only: "view only", coming_soon: "coming soon" };
const statusText = (s: ChainStatusInfo["status"]) => (s === "live" ? c.buy(STATUS_LABEL[s]) : s === "beta" ? c.warn(STATUS_LABEL[s]) : c.dim(STATUS_LABEL[s]));

// ─── claudia chains ──────────────────────────────────────────────────

export async function chains(ctx: Ctx) {
  const status = await withSpinner("Reading chain status", () => ctx.publicClient().chainStatus(true));
  if (!ctx.json) {
    title("Chains", "Solana is the default");
    table(
      [
        { header: "Chain", get: (s) => c.bold(s.name), headline: true },
        { header: "Id", get: (s) => c.dim(s.id) },
        { header: "Status", get: (s) => statusText(s.status), headline: true },
        { header: "Coin", get: (s) => s.nativeSymbol, priority: 2 },
        { header: "Launchpads open", get: (s) => s.launchpads.filter((p) => p.state === "open").map((p) => p.launchpad).join(", ") || c.dim("none yet"), flex: true },
      ],
      status,
    );
    info("Use another chain with --chain hood (Robinhood Chain needs an EVM wallet: claudia wallet evm create).");
  }
  return { chains: status.map((s) => ({ id: s.id, name: s.name, status: s.status, note: s.note, nativeSymbol: s.nativeSymbol, evmChainId: s.evmChainId ?? null, launchpads: s.launchpads })) };
}

// ─── claudia wallet evm [create|import] ──────────────────────────────

export async function walletEvm(ctx: Ctx) {
  const action = ctx.args[1];
  if (action === "create" || action === "import") {
    let importKey: string | undefined;
    if (action === "import") {
      const file = str(ctx.flags, "file");
      if (file) importKey = readFileSync(file, "utf8").trim();
      else if (!process.stdin.isTTY) importKey = readFileSync(0, "utf8").trim();
      else if (isInteractive()) importKey = (await secret("EVM private key (0x…):")).trim();
      if (!importKey) throw new UsageError("Usage: claudia wallet evm import [--file <path>]   (or pipe the key on stdin)");
    }
    const { address } = await ctx.home.createEvmWallet({ importKey, force: bool(ctx.flags, "force") });
    if (!ctx.json) {
      ok(`${action === "import" ? "Imported" : "Created"} the EVM wallet ${c.bold(address)}`);
      kv("File", ctx.home.paths.evmWallet);
      kv("Encrypted", ctx.home.isEncrypted() ? "yes (same passphrase as your Solana wallet)" : "no (claudia init --encrypt protects every key)");
      info("Fund it with ETH on Robinhood Chain to launch and trade there (beta). Keep a backup of the key.");
    }
    return { address, file: ctx.home.paths.evmWallet };
  }
  const address = ctx.home.evmAddress();
  if (!address) throw new CliError(EXIT.SETUP, "no_evm_wallet", "No EVM wallet on this machine.", "claudia wallet evm create   (or: claudia wallet evm import)");
  let balance: number | null = null;
  try {
    const evm = await ctx.evm();
    balance = Number(await withSpinner("Reading the ETH balance", () => evm.evmBalance(address, { rpcUrl: ctx.home.config().hoodRpcUrl }))) / 1e18;
  } catch (e) {
    if ((e as CliError).code === "viem_missing") throw e;
  }
  if (!ctx.json) {
    title("EVM wallet", "Robinhood Chain (beta)");
    kv("Address", c.bold(address));
    kv("Balance", balance === null ? c.dim("unavailable (RPC)") : eth(balance));
    kv("Explorer", chainExplorerUrl("hood", "address", address));
    kv("File", existsSync(ctx.home.paths.evmWallet) ? ctx.home.paths.evmWallet : c.dim("from CLAUDIA_EVM_KEY"));
  }
  return { address, balanceEth: balance, chain: "hood", file: ctx.home.paths.evmWallet };
}

// ─── guards ──────────────────────────────────────────────────────────

interface EvmGuarded {
  address: string;
  key: `0x${string}`;
  balance: number | null;
  rpcUrl?: string;
  evm: Awaited<ReturnType<Ctx["evm"]>>;
}

async function guards(ctx: Ctx, spendEth: number, what: string): Promise<EvmGuarded> {
  const client = ctx.publicClient();
  await withSpinner("Checking Robinhood Chain status", () => client.assertChainOpen("hood"));
  const address = ctx.home.evmAddress();
  if (!address) throw new CliError(EXIT.SETUP, "no_evm_wallet", `No EVM wallet on this machine, so it can't ${what} on Robinhood Chain.`, "claudia wallet evm create   (or: claudia wallet evm import)");
  if (spendEth > 0) ctx.home.checkCaps(spendEth, undefined, "hood");
  const evm = await ctx.evm();
  const key = await ctx.evmKey();
  const rpcUrl = ctx.home.config().hoodRpcUrl;
  let balance: number | null = null;
  try {
    balance = Number(await withSpinner("Reading the ETH balance", () => evm.evmBalance(address, { rpcUrl }))) / 1e18;
  } catch (e) {
    if (!ctx.dryRun) throw new CliError(EXIT.REFUSED, "balance_unknown", `Couldn't read the ETH balance: ${(e as Error).message.split("\n")[0]}`, "Set a working RPC: claudia config set hood-rpc-url <url>");
  }
  if (balance !== null && balance < spendEth + GAS_RESERVE_ETH && !ctx.dryRun) {
    const need = round(spendEth + GAS_RESERVE_ETH, 6);
    throw new CliError(EXIT.REFUSED, "insufficient_eth", balance === 0 ? `Your EVM wallet has no ETH, so it can't ${what}.` : `Your EVM wallet has ${eth(balance)}; this needs about ${need} ETH.`, `Send at least ${need} ETH on Robinhood Chain to ${address} (only what you're willing to lose).`, { balanceEth: balance, needEth: need, wallet: address });
  }
  return { address, key, balance, rpcUrl, evm };
}

function capsLine(ctx: Ctx, amount: number) {
  const caps = ctx.home.config().caps;
  const left = checkCaps(amount, caps, ctx.home.spentToday("hood"), "hood").leftToday;
  return `${caps.maxEthPerTrade} ETH/trade · ${eth(left)} left today`;
}

const fmt = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 1e6) / 1e6));

function printTrade(p: PreparedTrade, side: "buy" | "sell", amount: number, signer: string) {
  const x = p.quote;
  if (side === "buy") {
    kv("You spend", c.bold(eth(x.amountIn ?? amount)));
    kv("You get", `≈ ${fmt(x.expectedOut)} tokens ${c.dim(`(at least ${fmt(x.minOut)})`)}`);
  } else {
    kv("You sell", `${amount}%${x.balanceTokens !== undefined ? c.dim(` (≈ ${fmt((x.balanceTokens * amount) / 100)} of ${fmt(x.balanceTokens)} tokens)`) : ""}`);
    kv("You get", `≈ ${c.bold(eth(x.expectedOut))} ${c.dim(`(at least ${eth(x.minOut)})`)}`);
  }
  kv("Price impact", `${Math.round(x.priceImpactPct * 100) / 100}%`);
  kv("Fees", `${eth(x.feeNative)}${x.taxPct ? ` · tax ${x.taxPct}%` : ""}`);
  kv("Route", x.route);
  if (x.estimate) warn("These numbers are an estimate.");
  for (const w of x.warnings ?? []) warn(w);
  kv("Transactions", `${p.txs.length} to sign with ${short(signer, 6)}`);
}

// ─── quote / buy / sell ──────────────────────────────────────────────

export async function quote(ctx: Ctx, key: string, side: "buy" | "sell", amount: number) {
  const client = ctx.publicClient();
  const trader = ctx.home.evmAddress();
  const q = await withSpinner("Getting a quote", () => client.quote({ token: key, side, amount, trader, slippageBps: numFlag(ctx.flags, "slippage-bps") }));
  if (!ctx.json) {
    title(`Quote · ${side} ${key}`, "Robinhood Chain (beta)");
    kv(side === "buy" ? "You spend" : "You sell", side === "buy" ? eth(amount) : `${amount}%`);
    kv("You get", side === "buy" ? `≈ ${fmt(q.expectedOut)} tokens ${c.dim(`(at least ${fmt(q.minOut)})`)}` : `≈ ${eth(q.expectedOut)}`);
    kv("Price impact", `${Math.round(q.priceImpactPct * 100) / 100}%`);
    kv("Fees", eth(q.feeNative));
    kv("Route", q.route);
    info("Just a quote — nothing was signed or sent.");
  }
  return { token: key, chain: "hood", side, amount, quote: q };
}

export async function trade(ctx: Ctx, key: string, side: "buy" | "sell", amount: number) {
  const g = await guards(ctx, side === "buy" ? amount : 0, side);
  const client = ctx.publicClient();
  const p = await withSpinner("Preparing the transactions", () =>
    client.tradePrepare({ token: key, side, ...(side === "buy" ? { amountNative: amount } : { pct: amount }), trader: g.address, slippageBps: numFlag(ctx.flags, "slippage-bps"), priorityFee: numFlag(ctx.flags, "priority-fee") }),
  );
  if (!ctx.json) {
    title(`${side === "buy" ? "Buy" : "Sell"} ${key}`, "Robinhood Chain (beta)");
    printTrade(p, side, amount, g.address);
    kv("Wallet", `${g.address} · ${eth(g.balance)}`);
    if (side === "buy") kv("Caps", capsLine(ctx, amount));
    log("");
  }
  if (ctx.dryRun) {
    if (!ctx.json) info("Dry run — prepared and checked; nothing was signed or sent.");
    return { dryRun: true, token: key, chain: "hood", side, amount, quote: p.quote, txCount: p.txs.length };
  }
  await ctx.confirmOrRefuse(side === "buy" ? `Spend ${amount} ETH on ${short(key.slice(5), 6)}?` : `Sell ${amount}% of ${short(key.slice(5), 6)}?`);
  const hashes = await g.evm.sendEvmTransactions(p.txs, g.key, { chain: "hood", rpcUrl: g.rpcUrl, onStep: (_s, d) => !ctx.json && info(d) });
  if (side === "buy") ctx.home.recordSpend({ kind: "buy", chain: "hood", native: amount, token: key, signatures: hashes });
  if (!ctx.json) {
    ok(`${side === "buy" ? "Bought" : "Sold"} — confirmed`);
    for (const h of hashes) info(chainExplorerUrl("hood", "tx", h));
  }
  return { token: key, chain: "hood", side, amount, quote: p.quote, hashes };
}

// ─── launch ──────────────────────────────────────────────────────────

export async function launch(ctx: Ctx) {
  const f = ctx.flags;
  const padId = (str(f, "launchpad") ?? "").toLowerCase();
  const pad = ROBINHOOD_LAUNCHPADS.find((p) => p.id === padId);
  const usage = `Usage: claudia launch --chain hood --launchpad <${ROBINHOOD_LAUNCHPADS.map((p) => p.id).join("|")}> --name <name> --symbol <TICKER> --image <file|url> [--dev-buy <eth>] [--description …] [--twitter …] [--telegram …] [--website …]`;
  if (!pad) throw new UsageError(padId ? `Unknown Robinhood launchpad "${padId}". ${usage}` : usage);
  const nameRaw = str(f, "name");
  const symRaw = str(f, "symbol") ?? str(f, "ticker");
  const image = str(f, "image");
  if (!nameRaw || !symRaw || !image) throw new UsageError(usage);
  const name = normalizeCoinName(nameRaw);
  if (!name.ok) throw new UsageError(name.error);
  const symbol = normalizeTicker(symRaw, 16);
  if (!symbol.ok) throw new UsageError(symbol.error);
  const devBuy = numFlag(f, "dev-buy") ?? 0;
  if (devBuy < 0) throw new UsageError("--dev-buy can't be negative");
  if (devBuy > 0 && !pad.devBuy) throw new UsageError(`${pad.name} launches have no dev buy. Drop --dev-buy or pick another launchpad.`);

  const g = await guards(ctx, devBuy, "launch");
  const client = ctx.publicClient();
  let imageUri = image;
  if (!/^(https?:\/\/|ipfs:\/\/)/i.test(image)) {
    if (!existsSync(image)) throw new UsageError(`No such image file: ${image}`);
    if (statSync(image).size > 4 * 1024 * 1024) throw new UsageError("Images must be 4 MB or smaller");
    if (!imageTypeOf(new Uint8Array(readFileSync(image).subarray(0, 16)))) throw new UsageError("That file isn't a PNG, JPEG, GIF or WEBP image");
    const up = await withSpinner(`Uploading ${basename(image)}`, () => client.uploadImage(new Uint8Array(readFileSync(image)), basename(image)));
    imageUri = up.uri;
  }
  const evmClient = new g.evm.ClaudiaEvm(client, { privateKey: g.key, chain: "hood", rpcUrl: g.rpcUrl });
  const planned: PlannedLaunch = await withSpinner("Planning and simulating the launch", () =>
    evmClient.planLaunch({
      launchpad: pad.id,
      name: name.value,
      symbol: symbol.value,
      imageUri,
      metadataUri: str(f, "metadata-uri"),
      description: str(f, "description"),
      socials: { twitter: str(f, "twitter"), telegram: str(f, "telegram"), website: str(f, "website") },
      devBuyNative: devBuy,
      slippageBps: numFlag(f, "slippage-bps"),
    }),
  );
  const p = planned.plan;
  const total = p.fees.totalNative;
  const caps = ctx.home.config().caps;
  const spent = ctx.home.spentToday("hood");
  if (total > Math.max(0, caps.maxEthPerDay - spent) + 1e-12) {
    throw new CliError(EXIT.REFUSED, "cap_exceeded", `This launch costs about ${eth(total)}, more than what's left of your daily cap (${eth(Math.max(0, caps.maxEthPerDay - spent))}).`, "Raise it: claudia config set max-eth-per-day <eth>");
  }
  if (g.balance !== null && g.balance < total + GAS_RESERVE_ETH && !ctx.dryRun) {
    throw new CliError(EXIT.REFUSED, "insufficient_eth", `The launch costs about ${eth(total)} but the wallet has ${eth(g.balance)}.`, `Send at least ${round(total + GAS_RESERVE_ETH, 6)} ETH on Robinhood Chain to ${g.address}.`);
  }
  if (!ctx.json) {
    title(`Launch $${symbol.value}`, `${pad.name} · Robinhood Chain (beta)`);
    kv("Coin", `${c.bold(name.value)} ($${symbol.value})`);
    kv("Token", p.predicted.token ?? "—");
    kv("Image", imageUri);
    kv("Dev buy", devBuy ? `${eth(devBuy)}${p.devBuyPreview?.tokensOut ? ` → ≈ ${fmt(p.devBuyPreview.tokensOut)} tokens (${Math.round(p.devBuyPreview.supplyPct * 100) / 100}% of supply)` : ""}` : "none");
    kv("Total cost", c.bold(`≈ ${eth(total)}`) + c.dim(` (launch fee ${eth(p.fees.launchFeeNative)} · gas ≈ ${eth(p.fees.estGasNative)})`));
    kv("Creator fees", `${p.split.creatorBps / 100}% → ${short(p.split.creator, 6)} · ${p.split.platformBps / 100}% → Claudia`);
    if (p.predicted.splitter) kv("FeeSplitter", p.predicted.splitter);
    kv("How", p.split.mechanism);
    kv("Simulation", p.simulation ? (p.simulation.ok ? c.green("ok") : c.red(p.simulation.error ?? "failed")) : c.dim("not run"));
    for (const w of p.split.warnings) warn(w);
    log("");
  }
  if (!p.txs.length) throw new CliError(EXIT.ERROR, "nothing_to_sign", "The server couldn't build the launch transactions.", p.split.warnings.join(" · ") || undefined);
  if (p.simulation && !p.simulation.ok && !bool(f, "force")) throw new CliError(EXIT.REFUSED, "simulation_failed", `The launch would fail: ${p.simulation.error ?? "simulation failed"}`, "Nothing was sent. Fix the problem (often: not enough ETH) and try again.");
  if (ctx.dryRun) {
    if (!ctx.json) info("Dry run — planned and simulated; nothing was signed or sent.");
    return { dryRun: true, chain: "hood", launchpad: pad.id, id: planned.id, token: p.predicted.token, totalEth: total, txCount: p.txs.length, plan: p };
  }
  await ctx.confirmOrRefuse(`Launch $${symbol.value} on ${pad.name} for about ${eth(total)}? (confirm within a minute — the plan expires)`);
  const r = await evmClient.executeLaunch(planned, { allowFailedSimulation: bool(f, "force") });
  ctx.home.recordSpend({ kind: "launch", chain: "hood", native: total, token: r.token ? `hood:${r.token.toLowerCase()}` : undefined, signatures: r.hashes });
  if (!ctx.json) {
    ok(`$${symbol.value} is live on ${pad.name}${r.confirmation?.launch?.status ? ` · ${r.confirmation.launch.status}` : ""}`);
    if (r.token) kv("Coin page", `${ctx.baseUrl}/t/hood/${r.token.toLowerCase()}`);
    kv("Launch id", `${r.id} ${c.dim("(claudia fees " + r.id + ")")}`);
    for (const h of r.hashes) info(chainExplorerUrl("hood", "tx", h));
  }
  return { id: r.id, chain: "hood", launchpad: pad.id, token: r.token ?? null, splitter: r.splitter ?? null, hashes: r.hashes, status: r.confirmation?.launch?.status ?? null };
}

// ─── fees / harvest ──────────────────────────────────────────────────

/** `claudia fees <launchId>`: accrued fees of one launch. `claudia fees`: your launches (Solana + EVM wallets). */
export async function fees(ctx: Ctx) {
  const client = ctx.publicClient();
  const id = ctx.args[0];
  if (id) {
    const r = await withSpinner("Reading the fees", () => client.launchFees(id));
    if (!ctx.json) {
      title(`Fees · launch ${id}`);
      table(
        [
          { header: "What", get: (x) => x.label, flex: true },
          { header: "Earned", get: (x) => `${fmt(x.amount)} ${x.symbol}`, align: "right" },
          { header: "Your 70%", get: (x) => (x.creatorShare !== undefined ? c.buy(`${fmt(x.creatorShare)} ${x.symbol}`) : c.dim("—")), align: "right" },
          { header: "Note", get: (x) => c.dim(x.note ?? ""), flex: true, priority: 1 },
        ],
        r.items,
        { empty: "No fee readings for this launch yet." },
      );
      info(`Collect them: claudia harvest ${id}`);
    }
    return { launchId: id, items: r.items, at: r.at };
  }
  const chain = ctx.chain();
  const owners = chain === "hood" ? [ctx.home.evmAddress()] : chain === "sol" && !str(ctx.flags, "chain") ? [ctx.home.walletAddress(), ctx.home.evmAddress()] : [ctx.home.walletAddress()];
  const creators = owners.filter((x): x is string => !!x);
  if (!creators.length) throw new CliError(EXIT.SETUP, "no_wallet", "No wallet on this machine to look up launches for.", "claudia init   (Robinhood: claudia wallet evm create)");
  const launches = await withSpinner("Reading your launches", () => client.launchesBy(creators));
  if (!ctx.json) {
    title("Your launches", `${launches.length} found`);
    table(
      [
        { header: "Coin", get: (l) => c.bold(`$${l.symbol ?? "?"}`), headline: true },
        { header: "Chain", get: (l) => (l.chain === "hood" ? "Robinhood" : "Solana") },
        { header: "Launchpad", get: (l) => String(l.launchpad ?? "") },
        { header: "Status", get: (l) => (l.status === "confirmed" ? c.buy(l.status) : c.dim(String(l.status))) },
        { header: "Launch id", get: (l) => c.dim(l.id), headline: true },
        { header: "When", get: (l) => c.dim(ago(l.createdAt as number)), priority: 1 },
      ],
      launches,
      { empty: "No launches from your wallets yet." },
    );
    if (launches.length) info("Fees for one: claudia fees <launch id>");
  }
  return { creators, launches };
}

export async function harvest(ctx: Ctx) {
  const id = ctx.args[0];
  if (!id) throw new UsageError("Usage: claudia harvest <launch id>   (find ids with: claudia fees)");
  const client = ctx.publicClient();
  const plan = await withSpinner("Building the harvest transactions", () => client.harvestPlan(id));
  const evmTxs = plan.txs.filter((t) => t.kind === "evm");
  if (!ctx.json) {
    title(`Harvest · launch ${id}`);
    for (const n of plan.notes) info(n);
    kv("Transactions", String(plan.txs.length));
    log("");
  }
  if (!plan.txs.length) {
    if (!ctx.json) info("Nothing to collect right now.");
    return { launchId: id, hashes: [], notes: plan.notes };
  }
  if (!evmTxs.length) {
    // Solana (pump.fun): one transaction the creator wallet signs; it pays every shareholder pro-rata.
    const wallet = await ctx.wallet();
    const signed = signTransactions(plan, wallet);
    if (ctx.dryRun) {
      if (!ctx.json) info("Dry run — built and signed locally to check it; nothing was sent.");
      return { dryRun: true, launchId: id, chain: "sol", txCount: plan.txs.length, notes: plan.notes };
    }
    await ctx.confirmOrRefuse(`Send ${plan.txs.length} transaction(s) to distribute the creator fees (network fee from ${short(wallet.publicKey.toBase58(), 6)})?`, "this spends a network fee");
    const network = await ctx.network();
    const sigs = await withSpinner("Sending", async () => sendAndConfirm(signed, await ctx.rpcUrl()));
    if (!ctx.json) {
      ok("Distributed to every shareholder");
      for (const s of sigs) info(explorerUrl("tx", s, network));
    }
    return { launchId: id, chain: "sol", signatures: sigs, notes: plan.notes };
  }
  if (evmTxs.length !== plan.txs.length) throw new CliError(EXIT.ERROR, "mixed_chains", "The harvest mixes Solana and EVM transactions; refusing to sign.");
  const g = await guards(ctx, 0, "harvest");
  if (ctx.dryRun) {
    if (!ctx.json) info("Dry run — built and checked; nothing was signed or sent.");
    return { dryRun: true, launchId: id, txCount: plan.txs.length, notes: plan.notes };
  }
  await ctx.confirmOrRefuse(`Send ${plan.txs.length} transaction(s) to collect and split the fees (gas from ${short(g.address, 6)})?`, "this spends gas");
  const hashes = await g.evm.sendEvmTransactions(plan.txs, g.key, { chain: "hood", rpcUrl: g.rpcUrl, onStep: (_s, d) => !ctx.json && info(d) });
  if (!ctx.json) {
    ok(`Harvested ${sym().dot} split 70/30 on-chain`);
    for (const h of hashes) info(chainExplorerUrl("hood", "tx", h));
  }
  return { launchId: id, hashes, notes: plan.notes };
}

/** Normalises a token argument for Robinhood (bare 0x → hood:0x…). */
export const hoodKey = (raw: string) => toTokenKey(raw, "hood");
export { native };
