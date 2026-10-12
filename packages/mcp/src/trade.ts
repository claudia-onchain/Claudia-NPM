// Local trading (stdio / local HTTP): the 0.1 flow, kept. The agent wallet in ~/.claudia signs, inside hard caps
// (per trade + per UTC day, the stricter of the MCP and CLI caps), and nothing moves without `confirm: true` after the
// user agreed to the summary. Online (useclaudia.xyz/mcp/trade) the same tools return a confirm link instead.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ClaudiaApiError, ROBINHOOD_LAUNCHPADS, chainExplorerUrl, defaultRpcUrl, explorerUrl, getSolBalance, imageTypeOf, normalizeCoinName, normalizeTicker, toTokenKey,
  type ClaudiaClient, type Keypair, type PlannedLaunch,
} from "@useclaudia/sdk";
import { checkCaps, type ClaudiaHome } from "@useclaudia/sdk/node";
import { chainArg, coinKey, q, toolOutput, type ToolOutput } from "@useclaudia/sdk/tools";

type EvmModule = typeof import("@useclaudia/sdk/evm");
let evmP: Promise<EvmModule> | undefined;
/** @useclaudia/sdk/evm needs viem (optional): only Robinhood Chain calls load it. */
function loadEvm(): Promise<EvmModule> {
  return (evmP ??= import("@useclaudia/sdk/evm").catch(() => {
    evmP = undefined;
    throw new Error("Robinhood Chain signing needs the viem package: npm i viem (next to @useclaudia/mcp), then restart the server.");
  }));
}
import type { McpSettings } from "./settings.js";

interface LocalPrepared {
  id: string;
  kind: "trade" | "launch";
  status: "pending" | "confirmed" | "failed" | "expired";
  createdAt: number;
  expiresAt: number;
  summary: { kind: string; side?: string; symbol?: string; name?: string; lines: [string, string][] };
  signatures: string[];
  mint?: string;
  error?: string;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const fail = (text: string, structured: Record<string, unknown> = {}): ToolOutput => ({ text, structured: { error: "refused", message: text, ...structured }, isError: true });

export class LocalTrader {
  private walletP?: Promise<Keypair | undefined>;
  private readonly prepared = new Map<string, LocalPrepared>();

  constructor(
    private readonly home: ClaudiaHome,
    private readonly client: () => Promise<ClaudiaClient>,
    private readonly settings: McpSettings,
  ) {}

  private async wallet(): Promise<Keypair> {
    const w = await (this.walletP ??= this.home.walletKeypair());
    if (!w) throw new Error("No agent wallet configured (run `claudia init`)");
    return w;
  }

  capLine(chain: "sol" | "hood" = "sol"): string {
    const c = this.settings.caps;
    if (chain === "hood") return `caps: ${c.maxEthPerTrade} ETH per trade, ${c.maxEthPerDay} ETH per day (spent today ${round(this.home.spentToday("hood"))} ETH)`;
    return `caps: ${c.maxSolPerTrade} SOL per trade, ${c.maxSolPerDay} SOL per day (spent today ${round(this.home.spentToday())} SOL)`;
  }

  /** Robinhood Chain: the EVM wallet from ~/.claudia (evm-wallet.json or CLAUDIA_EVM_KEY) and the chain switch. */
  private async evmPreflight(spend: number) {
    const c = await this.client();
    const address = this.home.evmAddress();
    if (!address) throw new Error("No EVM wallet on this machine for Robinhood Chain. Create one with `claudia wallet evm create` (or set CLAUDIA_EVM_KEY).");
    await c.assertChainOpen("hood");
    if (spend > 0) checkCaps(spend, this.settings.caps, this.home.spentToday("hood"), "hood");
    const evm = await loadEvm();
    const rpcUrl = this.home.config().hoodRpcUrl;
    const balanceWei = await evm.evmBalance(address, { rpcUrl }).catch(() => null);
    const balance = balanceWei === null ? null : Number(balanceWei) / 1e18;
    return { c, evm, address, rpcUrl, balance };
  }

  private async preflight(spend: number) {
    const c = await this.client();
    const [me, w, platform] = await Promise.all([c.me(), this.wallet(), c.platform()]);
    const addr = w.publicKey.toBase58();
    if (me.status !== "active") throw new Error(`The agent is ${me.status}`);
    if (me.wallet !== addr) throw new Error(me.wallet ? `The agent's registered wallet (${me.wallet}) isn't the configured wallet (${addr})` : "No wallet is registered for this agent yet (claudia passport)");
    if (spend > 0) checkCaps(spend, this.settings.caps, this.home.spentToday());
    const rpc = this.home.config().rpcUrl ?? defaultRpcUrl(platform.network);
    const balance = await getSolBalance(rpc, addr).catch(() => null);
    return { c, me, w, addr, network: platform.network, rpc, balance };
  }

  private remember(p: Omit<LocalPrepared, "id" | "createdAt" | "expiresAt">): LocalPrepared {
    const now = Date.now();
    const row: LocalPrepared = { id: `local_${randomBytes(9).toString("base64url")}`, createdAt: now, expiresAt: now + 2 * 60_000, ...p };
    this.prepared.set(row.id, row);
    if (this.prepared.size > 200) this.prepared.delete(this.prepared.keys().next().value!);
    return row;
  }

  private out(p: LocalPrepared, lead: string): ToolOutput {
    const status = p.status === "pending" && Date.now() > p.expiresAt ? "expired" : p.status;
    return toolOutput(
      [lead, ...p.summary.lines.map(([k, v]) => `${k}: ${k === "Coin" || k === "Name" ? q(v, 70) : v}`), ...(p.signatures.length ? [`Signatures: ${p.signatures.join(" ")}`] : [])],
      { id: p.id, status, expiresAt: new Date(p.expiresAt).toISOString(), summary: p.summary, signatures: p.signatures, ...(p.mint ? { mint: p.mint } : {}), ...(p.error ? { error: p.error } : {}) },
      { untrusted: true },
    );
  }

  async quote(a: Record<string, any>): Promise<ToolOutput> {
    const token = coinKey(a.coin, a.chain);
    const side = a.side === "sell" ? "sell" : "buy";
    if (token.startsWith("hood:")) {
      const c = await this.client();
      const qt = await c.quote({ token, side, amount: Number(a.amount), trader: this.home.evmAddress(), slippageBps: a.slippage_bps });
      return toolOutput(
        [`Quote only, nothing was sent (${side} ${a.amount}${side === "buy" ? " ETH" : "%"} of ${token} on Robinhood Chain, beta).`, `Expected out ${qt.expectedOut} · at least ${qt.minOut} · impact ${qt.priceImpactPct}% · fees ${qt.feeNative} ETH · ${qt.route}`, this.capLine("hood")],
        { coin: { key: token, chain: "hood" }, side, amount: Number(a.amount), quote: { expectedOut: qt.expectedOut, minOut: qt.minOut, priceImpactPct: qt.priceImpactPct, feeSol: qt.feeNative, feeNative: qt.feeNative, taxPct: qt.taxPct, route: qt.route, estimate: !!qt.estimate }, warnings: qt.warnings ?? [], signer: this.home.evmAddress() ?? null },
        { untrusted: false },
      );
    }
    const r = await (await this.client()).tradeQuote({ token, side, amount: Number(a.amount), slippageBps: a.slippage_bps });
    const qt = r.quote;
    return toolOutput(
      [`Quote only, nothing was sent (${side} ${a.amount}${side === "buy" ? " SOL" : "%"} of ${token}).`, `Expected out ${qt.expectedOut} · at least ${qt.minOut} · impact ${qt.priceImpactPct}% · fees ${qt.feeNative} SOL · ${qt.route}`, this.capLine()],
      { coin: { key: token }, side, amount: Number(a.amount), quote: { expectedOut: qt.expectedOut, minOut: qt.minOut, priceImpactPct: qt.priceImpactPct, feeSol: qt.feeNative, taxPct: qt.taxPct, route: qt.route, estimate: !!qt.estimate }, warnings: qt.warnings ?? [], signer: r.signer },
      { untrusted: false },
    );
  }

  async prepareTrade(a: Record<string, any>): Promise<ToolOutput> {
    const side: "buy" | "sell" = a.side === "sell" ? "sell" : "buy";
    const amount = Number(a.amount);
    if (!(amount > 0)) return fail("amount must be greater than 0");
    if (side === "sell" && amount > 100) return fail("For a sell, amount is a percent of the balance (1–100).");
    const coin = coinKey(a.coin, a.chain);
    if (coin.startsWith("hood:")) return this.prepareEvmTrade(coin, side, amount, a);
    if (side === "buy" && amount > this.settings.caps.maxSolPerTrade) return fail(`Not prepared: ${amount} SOL is over the ${this.settings.caps.maxSolPerTrade} SOL per-trade cap. ${this.capLine()}`);
    const token = toTokenKey(coin);
    const p = await this.preflight(side === "buy" ? amount : 0);
    const sending = a.confirm === true;
    if (sending && side === "buy" && p.balance !== null && p.balance < amount + 0.005) return fail(`Not sent: the agent wallet has ${p.balance} SOL; this needs about ${round(amount + 0.005)} SOL. Fund ${p.addr} first.`);
    let quote: Awaited<ReturnType<ClaudiaClient["tradeQuote"]>> | null = null;
    let quoteError: string | null = null;
    try {
      quote = await p.c.tradeQuote({ token, side, amount, slippageBps: a.slippage_bps });
    } catch (e) {
      if (sending) throw e;
      quoteError = e instanceof ClaudiaApiError ? `${e.status} ${e.code}: ${e.message}` : (e as Error).message;
    }
    const lines: [string, string][] = [
      ["Coin", token],
      ["Side", side === "buy" ? "Buy" : "Sell"],
      [side === "buy" ? "Spend" : "Sell", side === "buy" ? `${amount} SOL` : `${amount}% of the agent's balance`],
      ...(quote
        ? ([["Expected out", String(quote.quote.expectedOut)], ["At least", String(quote.quote.minOut)], ["Price impact", `${quote.quote.priceImpactPct}%`], ["Fees", `about ${quote.quote.feeNative} SOL plus the network fee`], ["Route", quote.quote.route]] as [string, string][])
        : ([["Quote", quoteError ?? "unavailable"]] as [string, string][])),
      ["Network", p.network],
      ["Agent wallet", `${p.addr}${p.balance !== null ? ` (${p.balance} SOL)` : ""}`],
      ["Limits", this.capLine()],
    ];
    const summary = { kind: "trade", side, symbol: token, lines };
    if (!sending) {
      const row = this.remember({ kind: "trade", status: "pending", summary, signatures: [] });
      return this.out(row, `Not sent: this ${side} moves real funds${p.network === "testnet" ? " (devnet)" : ""}. Show the user this summary, and call prepare_trade again with confirm: true only if they explicitly agree.`);
    }
    const signatures = await p.c.executeQuote(quote!, p.w, { rpcUrl: p.rpc });
    if (side === "buy") this.home.recordSpend({ kind: "mcp_buy", sol: amount, token, signatures });
    const row = this.remember({ kind: "trade", status: "confirmed", summary, signatures });
    return this.out(row, `${side === "buy" ? "Bought" : "Sold"}, confirmed. ${signatures.map((s) => explorerUrl("tx", s, p.network)).join(" ")}`);
  }

  /** Robinhood Chain trade: public prepare route, signed locally with the EVM wallet (needs viem). */
  private async prepareEvmTrade(token: string, side: "buy" | "sell", amount: number, a: Record<string, any>): Promise<ToolOutput> {
    const caps = this.settings.caps;
    if (side === "buy" && amount > caps.maxEthPerTrade) return fail(`Not prepared: ${amount} ETH is over the ${caps.maxEthPerTrade} ETH per-trade cap. ${this.capLine("hood")}`);
    const p = await this.evmPreflight(side === "buy" ? amount : 0);
    const sending = a.confirm === true;
    if (sending && side === "buy" && p.balance !== null && p.balance < amount + 0.0005) return fail(`Not sent: the EVM wallet has ${p.balance} ETH; this needs about ${round(amount + 0.0005)} ETH. Fund ${p.address} on Robinhood Chain first.`);
    const prepared = await p.c.tradePrepare({ token, side, ...(side === "buy" ? { amountNative: amount } : { pct: amount }), trader: p.address, slippageBps: a.slippage_bps });
    const qt = prepared.quote;
    const lines: [string, string][] = [
      ["Coin", token],
      ["Chain", "Robinhood Chain (beta)"],
      ["Side", side === "buy" ? "Buy" : "Sell"],
      [side === "buy" ? "Spend" : "Sell", side === "buy" ? `${amount} ETH` : `${amount}% of the wallet's balance`],
      ["Expected out", String(qt.expectedOut)],
      ["At least", String(qt.minOut)],
      ["Price impact", `${qt.priceImpactPct}%`],
      ["Fees", `about ${qt.feeNative} ETH plus gas`],
      ["Route", qt.route],
      ["Transactions", String(prepared.txs.length)],
      ["EVM wallet", `${p.address}${p.balance !== null ? ` (${round(p.balance)} ETH)` : ""}`],
      ["Limits", this.capLine("hood")],
    ];
    const summary = { kind: "trade", side, symbol: token, lines };
    if (!sending) {
      const row = this.remember({ kind: "trade", status: "pending", summary, signatures: [] });
      return this.out(row, `Not sent: this ${side} moves real funds on Robinhood Chain (beta). Show the user this summary, and call prepare_trade again with confirm: true only if they explicitly agree.`);
    }
    const key = await this.home.evmPrivateKey();
    if (!key) return fail("The EVM wallet key isn't available (encrypted home without CLAUDIA_PASSPHRASE?).");
    const hashes = await p.evm.sendEvmTransactions(prepared.txs, key, { chain: "hood", rpcUrl: p.rpcUrl });
    if (side === "buy") this.home.recordSpend({ kind: "mcp_buy", chain: "hood", native: amount, token, signatures: hashes });
    const row = this.remember({ kind: "trade", status: "confirmed", summary, signatures: hashes });
    return this.out(row, `${side === "buy" ? "Bought" : "Sold"}, confirmed. ${hashes.map((h) => chainExplorerUrl("hood", "tx", h)).join(" ")}`);
  }

  async prepareLaunch(a: Record<string, any>): Promise<ToolOutput> {
    if (chainArg(a.chain) === "hood") return this.prepareEvmLaunch(a);
    if (a.launchpad && a.launchpad !== "pump") return fail(`${a.launchpad} is a Robinhood Chain launchpad: pass chain: "hood". On Solana the launchpad is pump.`);
    const caps = this.settings.caps;
    const name = normalizeCoinName(String(a.name ?? ""));
    if (!name.ok) return fail(name.error);
    const symbol = normalizeTicker(String(a.symbol ?? ""));
    if (!symbol.ok) return fail(symbol.error);
    const devBuy = Number(a.dev_buy ?? a.dev_buy_sol ?? 0);
    if (!(devBuy >= 0) || devBuy > caps.maxSolPerTrade) return fail(`dev_buy must be between 0 and ${caps.maxSolPerTrade} SOL (per-trade cap).`);
    const image = String(a.image ?? "");
    const bad = this.checkImage(image);
    if (bad) return fail(bad);
    const local = !/^(https?:\/\/|ipfs:\/\/)/i.test(image);
    const p = await this.preflight(devBuy);
    if (!p.me.passport) return fail("This agent has no passport yet; launching needs one. Run `claudia passport` (the owner signs a memo).");
    const lines: [string, string][] = [
      ["Name", name.value],
      ["Ticker", `$${symbol.value}`],
      ["Image", local ? basename(image) : image.slice(0, 120)],
      ["Dev buy", devBuy ? `${devBuy} SOL` : "none"],
      ["Creator rewards", "70% of the coin's trading fees go to the agent wallet"],
      ["Network", p.network],
      ["Agent wallet", `${p.addr}${p.balance !== null ? ` (${p.balance} SOL)` : ""}`],
      ["Limits", this.capLine()],
    ];
    const summary = { kind: "launch", symbol: symbol.value, name: name.value, lines };
    if (a.confirm !== true) {
      const row = this.remember({ kind: "launch", status: "pending", summary, signatures: [] });
      return this.out(row, `Not launched: this spends real funds${p.network === "testnet" ? " (devnet)" : ""} (network fees + dev buy). Show the user this summary, and call prepare_launch again with confirm: true only if they explicitly agree.`);
    }
    const imageUri = local ? (await p.c.uploadImage(new Uint8Array(readFileSync(image)), basename(image))).uri : image;
    const planned = await p.c.launchPlan({ name: name.value, symbol: symbol.value, imageUri, description: a.description, socials: { twitter: a.twitter, telegram: a.telegram, website: a.website }, devBuyNative: devBuy });
    const total = planned.plan.fees.totalNative;
    try {
      checkCaps(Math.min(total, caps.maxSolPerTrade), caps, this.home.spentToday());
      if (total > caps.maxSolPerDay - this.home.spentToday() + 1e-12) throw new Error(`The launch costs about ${round(total)} SOL, over what's left of the daily cap`);
    } catch (e) {
      return fail(`Not launched: ${(e as Error).message}. ${this.capLine()}`);
    }
    if (p.balance !== null && p.balance < total + 0.005) return fail(`Not launched: it costs about ${round(total)} SOL and the wallet has ${p.balance} SOL.`);
    const r = await p.c.executeLaunch(planned, p.w, { rpcUrl: p.rpc });
    this.home.recordSpend({ kind: "mcp_launch", sol: total, token: r.mint ? `sol:${r.mint}` : undefined, signatures: r.signatures });
    const row = this.remember({ kind: "launch", status: "confirmed", summary: { ...summary, lines: [...lines, ["Total cost", `${round(total)} SOL`]] }, signatures: r.signatures, mint: r.mint });
    return this.out(row, `Launched $${symbol.value}.${r.mint ? ` ${this.home.config().baseUrl}/t/sol/${r.mint}` : ""}`);
  }

  private checkImage(image: string): string | null {
    const local = !/^(https?:\/\/|ipfs:\/\/)/i.test(image);
    if (!local) return null;
    if (!isAbsolute(image) || !existsSync(image)) return "image must be an https:// / ipfs:// URL or an absolute path to an existing file";
    if (statSync(image).size > 4 * 1024 * 1024) return "Images must be 4 MB or smaller";
    if (resolve(image).startsWith(resolve(this.home.dir))) return "Refusing to upload a file from the Claudia key folder";
    if (!imageTypeOf(new Uint8Array(readFileSync(image).subarray(0, 16)))) return "That file isn't a PNG, JPEG, GIF or WEBP image";
    return null;
  }

  /** Robinhood Chain launch: public plan route with the EVM wallet as creator, signed locally (needs viem). */
  private async prepareEvmLaunch(a: Record<string, any>): Promise<ToolOutput> {
    const caps = this.settings.caps;
    const pad = ROBINHOOD_LAUNCHPADS.find((x) => x.id === String(a.launchpad ?? "").toLowerCase());
    if (!pad) return fail(`Pick a Robinhood Chain launchpad: ${ROBINHOOD_LAUNCHPADS.map((x) => `${x.id} (${x.name})`).join(", ")}.`);
    const name = normalizeCoinName(String(a.name ?? ""));
    if (!name.ok) return fail(name.error);
    const symbol = normalizeTicker(String(a.symbol ?? ""), 16);
    if (!symbol.ok) return fail(symbol.error);
    const devBuy = Number(a.dev_buy ?? a.dev_buy_sol ?? 0);
    if (!(devBuy >= 0) || devBuy > caps.maxEthPerTrade) return fail(`dev_buy must be between 0 and ${caps.maxEthPerTrade} ETH (per-trade cap).`);
    if (devBuy > 0 && !pad.devBuy) return fail(`${pad.name} launches have no dev buy. Set dev_buy to 0 or pick another launchpad.`);
    const image = String(a.image ?? "");
    const bad = this.checkImage(image);
    if (bad) return fail(bad);
    const local = !/^(https?:\/\/|ipfs:\/\/)/i.test(image);
    const p = await this.evmPreflight(devBuy);
    const lines: [string, string][] = [
      ["Chain", "Robinhood Chain (beta)"],
      ["Launchpad", pad.name],
      ["Name", name.value],
      ["Ticker", `$${symbol.value}`],
      ["Image", local ? basename(image) : image.slice(0, 120)],
      ["Dev buy", devBuy ? `${devBuy} ETH` : "none"],
      ["Creator rewards", `70% of the coin's trading fees go to the EVM wallet (${pad.feeRoute})`],
      ["EVM wallet", `${p.address}${p.balance !== null ? ` (${round(p.balance)} ETH)` : ""}`],
      ["Limits", this.capLine("hood")],
    ];
    const summary = { kind: "launch", symbol: symbol.value, name: name.value, lines };
    if (a.confirm !== true) {
      const row = this.remember({ kind: "launch", status: "pending", summary, signatures: [] });
      return this.out(row, "Not launched: this spends real funds on Robinhood Chain (beta): gas, any launch fee and the dev buy. Show the user this summary, and call prepare_launch again with confirm: true only if they explicitly agree.");
    }
    const key = await this.home.evmPrivateKey();
    if (!key) return fail("The EVM wallet key isn't available (encrypted home without CLAUDIA_PASSPHRASE?).");
    const imageUri = local ? (await p.c.uploadImage(new Uint8Array(readFileSync(image)), basename(image))).uri : image;
    const evm = new p.evm.ClaudiaEvm(p.c, { privateKey: key, chain: "hood", rpcUrl: p.rpcUrl });
    const planned: PlannedLaunch = await evm.planLaunch({ launchpad: pad.id, name: name.value, symbol: symbol.value, imageUri, description: a.description, socials: { twitter: a.twitter, telegram: a.telegram, website: a.website }, devBuyNative: devBuy });
    const total = planned.plan.fees.totalNative;
    try {
      checkCaps(Math.min(total, caps.maxEthPerTrade), caps, this.home.spentToday("hood"), "hood");
      if (total > caps.maxEthPerDay - this.home.spentToday("hood") + 1e-12) throw new Error(`The launch costs about ${round(total)} ETH, over what's left of the daily cap`);
    } catch (e) {
      return fail(`Not launched: ${(e as Error).message}. ${this.capLine("hood")}`);
    }
    if (p.balance !== null && p.balance < total + 0.0005) return fail(`Not launched: it costs about ${round(total)} ETH and the wallet has ${round(p.balance)} ETH.`);
    const r = await evm.executeLaunch(planned);
    this.home.recordSpend({ kind: "mcp_launch", chain: "hood", native: total, token: r.token ? `hood:${r.token.toLowerCase()}` : undefined, signatures: r.hashes });
    const row = this.remember({ kind: "launch", status: "confirmed", summary: { ...summary, lines: [...lines, ["Total cost", `${round(total)} ETH`], ["Launch id", r.id]] }, signatures: r.hashes, mint: r.token });
    return this.out(row, `Launched $${symbol.value} on ${pad.name}.${r.token ? ` ${this.home.config().baseUrl}/t/hood/${r.token.toLowerCase()}` : ""} Launch id ${r.id} (fees: get_launch_fees).`);
  }

  status(id: string): ToolOutput {
    const row = this.prepared.get(String(id ?? ""));
    if (!row) return fail("No trade or launch with that id in this session.");
    return this.out(row, `Status: ${row.status === "pending" && Date.now() > row.expiresAt ? "expired" : row.status}.`);
  }
}
