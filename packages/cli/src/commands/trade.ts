// quote · buy · sell · launch — real money on mainnet, so every path goes through the same guard rails:
// logged in + active agent, the local wallet IS the agent's registered wallet, local caps, a balance check,
// a plain summary, and an explicit confirmation (--yes or "y"). --dry-run stops before anything is signed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  explorerUrl,
  getSolBalance,
  imageTypeOf,
  normalizeCoinName,
  normalizeTicker,
  signTransactions,
  toTokenKey,
  type AgentMe,
  type AgentTradeQuote,
  type Keypair,
  type PlannedLaunch,
} from "@useclaudia/sdk";
import { checkCaps } from "@useclaudia/sdk/node";
import { bool, numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { c, info, kv, log, ok, short, sol, title, warn, withSpinner } from "../ui.js";
import * as evm from "./evm.js";
import type { ChainId } from "@useclaudia/sdk";

/** SOL kept aside for network fees and token-account rent on top of the amount itself. */
const FEE_RESERVE_SOL = 0.005;

interface Guarded {
  me: AgentMe;
  wallet: Keypair;
  network: "mainnet" | "testnet";
  rpc: string;
  balance: number | null;
}

async function guards(ctx: Ctx, spendSol: number, what: string): Promise<Guarded> {
  const me = await ctx.me();
  if (me.status !== "active") throw new CliError(EXIT.REFUSED, `agent_${me.status}`, `Your agent is ${me.status}, so it can't ${what}.`);
  const wallet = await ctx.wallet();
  const addr = wallet.publicKey.toBase58();
  if (!me.wallet) throw new CliError(EXIT.REFUSED, "wallet_required", "No wallet is registered for your agent yet.", `Register ${addr} as the agent wallet: claudia passport`);
  if (me.wallet !== addr) throw new CliError(EXIT.REFUSED, "wallet_mismatch", `The agent's registered wallet is ${me.wallet}, but this machine's wallet is ${addr}.`, "Run the CLI on the machine that holds the agent wallet, or register this one.");
  if (spendSol > 0) ctx.home.checkCaps(spendSol);
  const network = await ctx.network();
  const rpc = await ctx.rpcUrl();
  let balance: number | null = null;
  try {
    balance = await getSolBalance(rpc, addr);
  } catch (e) {
    if (network === "mainnet" && !ctx.dryRun) throw new CliError(EXIT.REFUSED, "balance_unknown", `Couldn't read the wallet balance from ${rpc}: ${(e as Error).message.split("\n")[0]}`, "Set a working RPC: claudia config set rpc-url <url>");
  }
  if (balance !== null && spendSol >= 0 && balance < spendSol + FEE_RESERVE_SOL && !ctx.dryRun) {
    const need = Math.round((spendSol + FEE_RESERVE_SOL) * 1e6) / 1e6;
    if (network === "mainnet") {
      throw new CliError(EXIT.REFUSED, "insufficient_sol", balance === 0 ? `Your agent wallet has no SOL, so it can't ${what}.` : `Your agent wallet has ${sol(balance)}; this needs about ${need} SOL.`, `Send at least ${need} SOL to ${addr} (only what you're willing to lose), then try again.`, { balanceSol: balance, needSol: need, wallet: addr });
    }
    throw new CliError(EXIT.REFUSED, "insufficient_sol", `Your agent wallet has ${sol(balance)} on devnet; this needs about ${need} SOL.`, `Get devnet SOL: solana airdrop 1 ${addr} --url devnet`, { balanceSol: balance, needSol: need, wallet: addr });
  }
  return { me, wallet, network, rpc, balance };
}

function printQuote(q: AgentTradeQuote, side: "buy" | "sell", amount: number) {
  const x = q.quote;
  if (side === "buy") {
    kv("You spend", c.bold(sol(x.amountIn ?? amount)));
    kv("You get", `≈ ${fmt(x.expectedOut)} tokens ${c.dim(`(at least ${fmt(x.minOut)})`)}`);
  } else {
    kv("You sell", `${amount}% ${x.balanceTokens !== undefined ? c.dim(`(≈ ${fmt((x.balanceTokens * amount) / 100)} of ${fmt(x.balanceTokens)} tokens)`) : ""}`);
    kv("You get", `≈ ${c.bold(sol(x.expectedOut))} ${c.dim(`(at least ${sol(x.minOut)})`)}`);
  }
  kv("Price impact", `${Math.round(x.priceImpactPct * 100) / 100}%`);
  kv("Fees", `${sol(x.feeNative)}${x.taxPct ? ` · tax ${x.taxPct}%` : ""}`);
  kv("Route", x.route);
  if (x.estimate) warn("These numbers are an estimate.");
  if (x.partialFill) warn("The curve is almost full: part of this buy may be refunded.");
  for (const w of x.warnings ?? []) warn(w);
  kv("Transactions", `${q.txs.length} to sign with ${short(q.signer, 6)}`);
}

const fmt = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 1e6) / 1e6));

function parseSide(s: string | undefined): "buy" | "sell" {
  if (s === "buy" || s === "sell") return s;
  throw new UsageError("Side must be buy or sell");
}

function parseSellPct(s: string | undefined): number {
  if (!s) throw new UsageError("How much? e.g. 50% or all");
  if (s === "all") return 100;
  const n = Number(s.replace(/%$/, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new UsageError("Sell a percent between 0 and 100, e.g. 25%");
  return n;
}

function parseSol(s: string | undefined, chain: ChainId = "sol"): number {
  const unit = chain === "hood" ? "ETH" : "SOL";
  const n = Number(String(s ?? "").replace(/(sol|eth)$/i, ""));
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`Give the amount in ${unit}, e.g. ${chain === "hood" ? "0.002" : "0.01"}`);
  return n;
}

/** Which chain a token argument is on (--chain, a hood: prefix or a bare 0x address). BNB Chain is refused here. */
async function chainFor(ctx: Ctx, raw: string): Promise<ChainId> {
  const chain = ctx.chain(raw);
  if (chain === "bsc") await ctx.publicClient().assertChainOpen("bsc");
  return chain;
}

async function sendTxs(ctx: Ctx, g: Guarded, q: AgentTradeQuote): Promise<string[]> {
  const client = await ctx.agentClient();
  return client.executeQuote(q, g.wallet, { rpcUrl: g.rpc, onSent: (t) => !ctx.json && info(`Sending: ${t.description}`) });
}

// ─── quote ───────────────────────────────────────────────────────────

export async function quote(ctx: Ctx) {
  const [raw, sideRaw, amountRaw] = ctx.args;
  if (!raw || !sideRaw || !amountRaw) throw new UsageError("Usage: claudia quote <mint|0x…> buy <sol|eth> | sell <pct>% [--chain hood]");
  const side = parseSide(sideRaw);
  const chain = await chainFor(ctx, raw);
  const amount = side === "buy" ? parseSol(amountRaw, chain) : parseSellPct(amountRaw);
  if (chain === "hood") return evm.quote(ctx, evm.hoodKey(raw), side, amount);
  const client = await ctx.agentClient();
  const q = await withSpinner("Getting a quote", () => client.tradeQuote({ token: toTokenKey(raw), side, amount, slippageBps: numFlag(ctx.flags, "slippage-bps") }));
  if (!ctx.json) {
    title(`Quote · ${side} ${toTokenKey(raw)}`);
    printQuote(q, side, amount);
    info("Just a quote — nothing was signed or sent.");
  }
  return { token: toTokenKey(raw), side, amount, quote: q.quote, txCount: q.txs.length, signer: q.signer };
}

// ─── buy / sell ──────────────────────────────────────────────────────

export async function buy(ctx: Ctx) {
  const [raw, amountRaw] = ctx.args;
  if (!raw || !amountRaw) throw new UsageError("Usage: claudia buy <mint|0x…> <sol|eth> [--chain hood]");
  const chain = await chainFor(ctx, raw);
  const amount = parseSol(amountRaw, chain);
  if (chain === "hood") return evm.trade(ctx, evm.hoodKey(raw), "buy", amount);
  return trade(ctx, toTokenKey(raw), "buy", amount);
}

export async function sell(ctx: Ctx) {
  const [raw, amountRaw] = ctx.args;
  if (!raw || !amountRaw) throw new UsageError("Usage: claudia sell <mint|0x…> <pct>% [--chain hood]");
  const chain = await chainFor(ctx, raw);
  if (chain === "hood") return evm.trade(ctx, evm.hoodKey(raw), "sell", parseSellPct(amountRaw));
  return trade(ctx, toTokenKey(raw), "sell", parseSellPct(amountRaw));
}

async function trade(ctx: Ctx, key: string, side: "buy" | "sell", amount: number) {
  const g = await guards(ctx, side === "buy" ? amount : 0, side === "buy" ? "buy" : "sell");
  const client = await ctx.agentClient();
  const q = await withSpinner("Getting a quote", () => client.tradeQuote({ token: key, side, amount, slippageBps: numFlag(ctx.flags, "slippage-bps"), priorityFee: numFlag(ctx.flags, "priority-fee") }));
  if (q.signer !== g.wallet.publicKey.toBase58()) throw new CliError(EXIT.REFUSED, "wallet_mismatch", `The quote is for ${q.signer}, not this wallet.`);
  if (!ctx.json) {
    title(`${side === "buy" ? "Buy" : "Sell"} ${key}`);
    printQuote(q, side, amount);
    kv("Network", g.network === "mainnet" ? c.bold(c.yellow("mainnet — real SOL")) : "devnet (test SOL)");
    kv("Wallet", `${g.wallet.publicKey.toBase58()} · ${sol(g.balance)}`);
    if (side === "buy") {
      const left = checkCaps(amount, ctx.home.config().caps, ctx.home.spentToday()).leftToday;
      kv("Caps", `${ctx.home.config().caps.maxSolPerTrade} SOL/trade · ${sol(left)} left today`);
    }
    log("");
  }
  // Sign locally even in dry-run, to prove the transaction is for this wallet and complete.
  signTransactions(q, g.wallet);
  if (ctx.dryRun) {
    if (!ctx.json) info("Dry run — signed locally to check it, nothing was sent.");
    return { dryRun: true, token: key, side, amount, quote: q.quote, txCount: q.txs.length };
  }
  await ctx.confirmOrRefuse(side === "buy" ? `Spend ${amount} SOL on ${short(key.slice(4), 6)}?` : `Sell ${amount}% of ${short(key.slice(4), 6)}?`);
  const signatures = await sendTxs(ctx, g, q);
  if (side === "buy") ctx.home.recordSpend({ kind: "buy", sol: amount, token: key, signatures });
  if (!ctx.json) {
    ok(`${side === "buy" ? "Bought" : "Sold"} — confirmed`);
    for (const s of signatures) info(explorerUrl("tx", s, g.network));
  }
  return { token: key, side, amount, quote: q.quote, signatures, network: g.network };
}

// ─── launch ──────────────────────────────────────────────────────────

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export async function launch(ctx: Ctx) {
  const f = ctx.flags;
  const chain = ctx.chain();
  if (chain === "bsc") await ctx.publicClient().assertChainOpen("bsc");
  if (chain === "hood") return evm.launch(ctx);
  const pad = str(f, "launchpad");
  if (pad && pad !== "pump") throw new UsageError(`${pad} isn't a Solana launchpad here (Solana launches use pump). Robinhood Chain launchpads need --chain hood.`);
  const nameRaw = str(f, "name");
  const symRaw = str(f, "symbol") ?? str(f, "ticker");
  const image = str(f, "image");
  if (!nameRaw || !symRaw || !image) throw new UsageError("Usage: claudia launch --name <name> --symbol <TICKER> --image <file|url> [--dev-buy <sol>] [--description …] [--twitter …] [--telegram …] [--website …]");
  const name = normalizeCoinName(nameRaw);
  if (!name.ok) throw new UsageError(name.error);
  const symbol = normalizeTicker(symRaw);
  if (!symbol.ok) throw new UsageError(symbol.error);
  const devBuy = numFlag(f, "dev-buy") ?? 0;
  if (devBuy < 0) throw new UsageError("--dev-buy can't be negative");

  // Per-trade cap applies to the dev buy; the daily cap to everything the launch spends (checked after planning).
  const g = await guards(ctx, devBuy, "launch");
  if (!g.me.passport) throw new CliError(EXIT.REFUSED, "passport_required", "Agents need an on-chain passport before launching.", "Register it: claudia passport --owner-keypair <owner wallet file>");
  const client = await ctx.agentClient();

  let imageUri = image;
  if (!/^(https?:\/\/|ipfs:\/\/)/i.test(image)) {
    if (!existsSync(image)) throw new UsageError(`No such image file: ${image}`);
    const size = statSync(image).size;
    if (size > 4 * 1024 * 1024) throw new UsageError("Images must be 4 MB or smaller");
    const ext = image.split(".").pop()?.toLowerCase() ?? "";
    if (!imageTypeOf(new Uint8Array(readFileSync(image).subarray(0, 16)))) throw new UsageError("That file isn't a PNG, JPEG, GIF or WEBP image");
    const up = await withSpinner(`Uploading ${basename(image)}`, () => client.uploadImage(new Uint8Array(readFileSync(image)), basename(image), IMAGE_TYPES[ext]));
    imageUri = up.uri;
    if (up.dev && g.network === "mainnet" && !ctx.json) warn("The server stored the image locally (not pinned to IPFS).");
  }

  const planned: PlannedLaunch = await withSpinner("Planning the launch with Claudia", () => client.launchPlan({
    name: name.value,
    symbol: symbol.value,
    imageUri,
    metadataUri: str(f, "metadata-uri"),
    description: str(f, "description"),
    socials: { twitter: str(f, "twitter"), telegram: str(f, "telegram"), website: str(f, "website") },
    devBuyNative: devBuy,
    slippageBps: numFlag(f, "slippage-bps"),
    mayhemMode: bool(f, "mayhem") || undefined,
  }));
  const p = planned.plan;
  const total = p.fees.totalNative;
  const caps = ctx.home.config().caps;
  const spent = ctx.home.spentToday();
  if (total > Math.max(0, caps.maxSolPerDay - spent) + 1e-12) {
    throw new CliError(EXIT.REFUSED, "cap_exceeded", `This launch costs about ${sol(total)}, more than what's left of your daily cap (${sol(Math.max(0, caps.maxSolPerDay - spent))}).`, "Raise it: claudia config set max-sol-per-day <sol>");
  }
  if (g.balance !== null && g.balance < total + FEE_RESERVE_SOL && !ctx.dryRun) {
    throw new CliError(EXIT.REFUSED, "insufficient_sol", `The launch costs about ${sol(total)} but the wallet has ${sol(g.balance)}.`, `Send at least ${Math.round((total + FEE_RESERVE_SOL) * 1e6) / 1e6} SOL to ${g.wallet.publicKey.toBase58()}.`);
  }
  if (!ctx.json) {
    title(`Launch $${symbol.value}`);
    kv("Coin", `${c.bold(name.value)} ($${symbol.value}) on ${p.request.launchpad} · ${p.request.chain}`);
    kv("Mint", p.predicted.token ?? "—");
    kv("Image", imageUri);
    kv("Dev buy", devBuy ? `${sol(devBuy)} → ≈ ${fmt(p.devBuyPreview.tokensOut)} tokens (${Math.round(p.devBuyPreview.supplyPct * 100) / 100}% of supply)` : "none");
    kv("Total cost", c.bold(`≈ ${sol(total)}`) + c.dim(` (launch fee ${sol(p.fees.launchFeeNative)} · network ≈ ${sol(p.fees.estGasNative)})`));
    kv("Creator fees", `${p.split.creatorBps / 100}% → your agent wallet ${short(p.split.creator, 6)} · ${p.split.platformBps / 100}% → Claudia`);
    kv("How", p.split.mechanism);
    kv("Network", g.network === "mainnet" ? c.bold(c.yellow("mainnet — real SOL")) : "devnet (test SOL)");
    kv("Simulation", p.simulation ? (p.simulation.ok ? c.green("ok") : c.red(p.simulation.error ?? "failed")) : c.dim("not run"));
    // The server's "run by Claudia" note is about hosted escrows; for an external agent the creator wallet IS this wallet.
    for (const w of p.split.warnings) if (!(p.split.creator === g.wallet.publicKey.toBase58() && /run by Claudia/.test(w))) warn(w);
    log("");
  }
  if (!p.txs.length) throw new CliError(EXIT.ERROR, "nothing_to_sign", "The server couldn't build the launch transactions.", p.split.warnings.join(" · ") || undefined);
  if (p.simulation && !p.simulation.ok && !bool(f, "force")) throw new CliError(EXIT.REFUSED, "simulation_failed", `The launch would fail: ${p.simulation.error ?? "simulation failed"}`, "Nothing was sent. Fix the problem (often: not enough SOL) and try again.");
  signTransactions(planned, g.wallet);
  if (ctx.dryRun) {
    if (!ctx.json) info("Dry run — planned and signed locally to check it; nothing was sent. (Planning counts toward 3 launches/hour.)");
    return { dryRun: true, id: planned.id, mint: p.predicted.token, totalSol: total, txCount: p.txs.length, plan: p };
  }
  await ctx.confirmOrRefuse(`Launch $${symbol.value} for about ${sol(total)}? (confirm within a minute — the plan expires)`);
  const r = await client.executeLaunch(planned, g.wallet, { rpcUrl: g.rpc, onStep: (_s, d) => !ctx.json && info(d), allowFailedSimulation: bool(f, "force") });
  ctx.home.recordSpend({ kind: "launch", sol: total, token: r.mint ? `sol:${r.mint}` : undefined, signatures: r.signatures });
  if (!ctx.json) {
    ok(`$${symbol.value} is live${r.confirmation?.launch?.status ? ` · ${r.confirmation.launch.status}` : ""}`);
    if (r.mint) kv("Coin page", `${ctx.baseUrl}/t/sol/${r.mint}`);
    for (const s of r.signatures) info(explorerUrl("tx", s, g.network));
  }
  return { id: r.id, mint: r.mint, signatures: r.signatures, status: r.confirmation?.launch?.status ?? null, pending: r.confirmation?.pending ?? null, network: g.network };
}

/** The guarded buy/sell flow (caps, preview, confirmation, --dry-run) for other commands, e.g. the agent's tools. */
export const tradeFlow = trade;
