// @useclaudia/sdk/evm — sign and send Claudia's unsigned EVM transactions (Robinhood Chain, beta) with your own key.
// Needs `viem` (optional peer dependency): npm i viem. Solana-only apps never load this file.
//
// The server builds every transaction (launch, trade, fee harvest) and simulates launches; this module checks each
// one targets the right chain, signs it locally with your key, sends it in order and waits for each receipt.
import { createPublicClient, createWalletClient, defineChain, http, isAddress, isHex, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ClaudiaClient } from "../client.js";
import { CHAINS, ROBINHOOD_LAUNCHPADS, parseChain, type RobinhoodLaunchpadId } from "../chains.js";
import { ClaudiaApiError, ClaudiaConfigError, ClaudiaTxError } from "../errors.js";
import { evmAddressOf, normalizeEvmKey } from "../evm-keys.js";
import { toTokenKey } from "../token-key.js";
import type { ChainId, HarvestPlan, LaunchConfirmation, LaunchFees, LaunchInput, PlannedLaunch, PreparedTrade, PreparedTx } from "../types.js";

export { ROBINHOOD_CONTRACTS, ROBINHOOD_LAUNCHPADS } from "../chains.js";
export type { LaunchpadInfo, RobinhoodLaunchpadId } from "../chains.js";
export { checksumAddress, evmAddressOf, generateEvmWallet, isEvmAddress } from "../evm-keys.js";

/** Robinhood Chain mainnet (chain id 4663) as a viem chain. */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CHAINS.hood.publicRpc, "https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: CHAINS.hood.explorer } },
});

/** BNB Chain as a viem chain (Claudia launches there are coming soon). */
export const bnbChain: Chain = defineChain({
  id: 56,
  name: "BNB Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: [CHAINS.bsc.publicRpc] } },
  blockExplorers: { default: { name: "BscScan", url: CHAINS.bsc.explorer } },
});

type EvmChainId = Exclude<ChainId, "sol">;

export function viemChainOf(chain: ChainId): Chain {
  const c = parseChain(chain);
  if (c === "hood") return robinhoodChain;
  if (c === "bsc") return bnbChain;
  throw new ClaudiaConfigError("not_evm", "Solana isn't an EVM chain: use the main @useclaudia/sdk flows");
}

const RECEIPT_TIMEOUT_MS = 90_000;
const firstLine = (e: unknown) => String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).split("\n")[0].slice(0, 300);

export interface EvmSendOptions {
  /** Default "hood". */
  chain?: EvmChainId;
  /** Your RPC (default: the chain's public RPC, which is rate limited). */
  rpcUrl?: string;
  /** Per-receipt wait (default 90 s). */
  receiptTimeoutMs?: number;
  /** Progress: "sign" | "send" | "confirm" | "done" with a short human line. */
  onStep?: (step: string, detail: string) => void;
}

/**
 * Signs and sends unsigned EVM transactions in order, waiting for each receipt; stops at the first revert.
 * Everything is validated before the first send, so a batch that can't complete never starts.
 * Throws `ClaudiaTxError` (`signature` = the failing hash) — hashes already sent are in `error.hashes`.
 */
export async function sendEvmTransactions(txs: PreparedTx[], privateKey: string, opts: EvmSendOptions = {}): Promise<string[]> {
  const chain = viemChainOf(opts.chain ?? "hood");
  const calls = txs.map((tx, i) => {
    const tag = `Tx ${i + 1}/${txs.length}`;
    if (tx.kind !== "evm") throw new ClaudiaConfigError("wrong_chain", `${tag} is a Solana transaction`);
    if (tx.chainId !== chain.id) throw new ClaudiaConfigError("wrong_chain", `${tag} targets chain ${tx.chainId}, expected ${chain.name} (${chain.id})`);
    if (!isAddress(tx.to)) throw new ClaudiaConfigError("bad_tx", `${tag}: invalid recipient`);
    if (tx.data && !isHex(tx.data)) throw new ClaudiaConfigError("bad_tx", `${tag}: invalid calldata`);
    let value: bigint;
    let gas: bigint | undefined;
    try {
      value = BigInt(tx.value || "0");
      gas = tx.gas ? BigInt(tx.gas) : undefined;
    } catch {
      throw new ClaudiaConfigError("bad_tx", `${tag}: invalid value or gas`);
    }
    return { to: tx.to as Address, data: (tx.data || undefined) as Hex | undefined, value, gas, description: tx.description };
  });
  const account = privateKeyToAccount(normalizeEvmKey(privateKey));
  const transport = http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });
  const step = opts.onStep ?? (() => {});
  const hashes: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tag = `Tx ${i + 1}/${calls.length}`;
    step("send", `${tag}${call.description ? `: ${call.description}` : ""}`);
    let hash: Hex;
    try {
      hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value, gas: call.gas, chain, account });
    } catch (e) {
      throw withHashes(new ClaudiaTxError("send_failed", `${tag} was not sent: ${firstLine(e)}`), hashes);
    }
    hashes.push(hash);
    step("confirm", `${tag} sent ${hash}`);
    let status: "success" | "reverted";
    try {
      status = (await pub.waitForTransactionReceipt({ hash, timeout: opts.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS })).status;
    } catch {
      throw withHashes(new ClaudiaTxError("not_confirmed", `${tag} not confirmed in time — check ${CHAINS.hood.explorerName}`, { signature: hash }), hashes);
    }
    if (status !== "success") throw withHashes(new ClaudiaTxError("reverted", `${tag} reverted${call.description ? ` (${call.description})` : ""}`, { signature: hash }), hashes);
  }
  step("done", `${hashes.length} transaction(s) confirmed`);
  return hashes;
}

function withHashes<E extends Error>(e: E, hashes: string[]): E & { hashes: string[] } {
  return Object.assign(e, { hashes: [...hashes] });
}

// ─── fee splitter reads ─────────────────────────────────────────────

const SPLITTER_VIEW_ABI = [
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platform", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "platformBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "distributable", stateMutability: "view", inputs: [{ type: "address", name: "token" }], outputs: [{ type: "uint256" }] },
] as const;

export interface FeeSplitterInfo {
  address: string;
  creator: string;
  platform: string;
  creatorBps: number;
  platformBps: number;
  /** Native coin (ETH) waiting to be distributed, in wei. */
  distributableNative: bigint;
  /** Per token (address → wei-sized amount) for the tokens you asked about. */
  distributableTokens: Record<string, bigint>;
}

/** Reads a Claudia FeeSplitter on-chain: who gets what (bps are fixed at creation) and what is waiting to be split. */
export async function readFeeSplitter(splitter: string, opts: { chain?: EvmChainId; rpcUrl?: string; tokens?: string[] } = {}): Promise<FeeSplitterInfo> {
  if (!isAddress(splitter)) throw new ClaudiaConfigError("bad_address", "The splitter must be a 0x address");
  const chain = viemChainOf(opts.chain ?? "hood");
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]) });
  const address = splitter as Address;
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const read = <T>(functionName: "creator" | "platform" | "creatorBps" | "platformBps") => pub.readContract({ address, abi: SPLITTER_VIEW_ABI, functionName }) as Promise<T>;
  const [creator, platform, creatorBps, platformBps, native] = await Promise.all([
    read<string>("creator"),
    read<string>("platform"),
    read<number>("creatorBps"),
    read<number>("platformBps"),
    pub.readContract({ address, abi: SPLITTER_VIEW_ABI, functionName: "distributable", args: [zero] }) as Promise<bigint>,
  ]);
  const distributableTokens: Record<string, bigint> = {};
  for (const t of opts.tokens ?? []) {
    if (!isAddress(t)) continue;
    distributableTokens[t.toLowerCase()] = (await pub.readContract({ address, abi: SPLITTER_VIEW_ABI, functionName: "distributable", args: [t as Address] })) as bigint;
  }
  return { address: splitter, creator, platform, creatorBps: Number(creatorBps), platformBps: Number(platformBps), distributableNative: native, distributableTokens };
}

/** Native balance of an address, in wei. */
export async function evmBalance(address: string, opts: { chain?: EvmChainId; rpcUrl?: string } = {}): Promise<bigint> {
  if (!isAddress(address)) throw new ClaudiaConfigError("bad_address", "Not a 0x address");
  const chain = viemChainOf(opts.chain ?? "hood");
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]) });
  return pub.getBalance({ address: address as Address });
}

// ─── flows ──────────────────────────────────────────────────────────

export interface ClaudiaEvmOptions {
  /** Your EVM private key (0x + 64 hex). Never sent anywhere: transactions are signed locally. */
  privateKey: string;
  /** Default "hood" (Robinhood Chain, beta). "bsc" is coming soon and refused until it opens. */
  chain?: EvmChainId;
  rpcUrl?: string;
  onStep?: (step: string, detail: string) => void;
}

export interface EvmLaunchInput extends Omit<LaunchInput, "chain" | "launchpad" | "creator"> {
  launchpad: RobinhoodLaunchpadId;
}

export interface EvmLaunchResult {
  id: string;
  token?: string;
  splitter?: string;
  hashes: string[];
  plan: PlannedLaunch;
  confirmation: LaunchConfirmation | null;
}

export interface EvmTradeResult {
  prepared: PreparedTrade;
  hashes: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch, trade and harvest fees on Robinhood Chain with your own key. Real money: dev buys, trades and gas come out
 * of this wallet. Robinhood Chain is in beta on Claudia.
 *
 *   const evm = new ClaudiaEvm(client, { privateKey: process.env.EVM_KEY! });
 *   await evm.launch({ launchpad: "pons", name: "Kitty", symbol: "KITTY", imageUri, devBuyNative: 0.001 });
 */
export class ClaudiaEvm {
  readonly chain: EvmChainId;
  readonly address: string;
  private readonly key: `0x${string}`;
  private readonly rpcUrl?: string;
  private readonly onStep?: (step: string, detail: string) => void;

  constructor(
    readonly client: ClaudiaClient,
    opts: ClaudiaEvmOptions,
  ) {
    this.chain = (opts.chain ? parseChain(opts.chain) : "hood") as EvmChainId;
    if ((this.chain as ChainId) === "sol") throw new ClaudiaConfigError("not_evm", "ClaudiaEvm is for EVM chains (hood)");
    this.key = normalizeEvmKey(opts.privateKey);
    this.address = evmAddressOf(this.key);
    this.rpcUrl = opts.rpcUrl;
    this.onStep = opts.onStep;
  }

  private send(txs: PreparedTx[]): Promise<string[]> {
    return sendEvmTransactions(txs, this.key, { chain: this.chain, rpcUrl: this.rpcUrl, onStep: this.onStep });
  }

  /** Native balance (ETH on Robinhood), in wei. */
  balance(): Promise<bigint> {
    return evmBalance(this.address, { chain: this.chain, rpcUrl: this.rpcUrl });
  }

  /** Plan only (nothing is signed): shows the transactions, fees, split and simulation result. */
  async planLaunch(input: EvmLaunchInput): Promise<PlannedLaunch> {
    await this.client.assertChainOpen(this.chain);
    if (!ROBINHOOD_LAUNCHPADS.some((p) => p.id === input.launchpad)) {
      throw new ClaudiaConfigError("bad_launchpad", `Robinhood launchpads: ${ROBINHOOD_LAUNCHPADS.map((p) => p.id).join(", ")}`);
    }
    return this.client.planLaunch({ ...input, chain: this.chain, creator: this.address });
  }

  /** Plan → check the simulation → sign and send every transaction in order → confirm with Claudia. */
  async launch(input: EvmLaunchInput, opts: { allowFailedSimulation?: boolean } = {}): Promise<EvmLaunchResult> {
    this.onStep?.("plan", `Planning ${input.name} ($${input.symbol}) on ${input.launchpad}`);
    return this.executeLaunch(await this.planLaunch(input), opts);
  }

  /** Sign → send → confirm a plan from `planLaunch` (send it soon after planning). */
  async executeLaunch(planned: PlannedLaunch, opts: { allowFailedSimulation?: boolean } = {}): Promise<EvmLaunchResult> {
    const { plan } = planned;
    if (plan.request.creator.toLowerCase() !== this.address.toLowerCase()) {
      throw new ClaudiaConfigError("wallet_mismatch", `The plan's creator is ${plan.request.creator}, but this wallet is ${this.address}`);
    }
    if (!plan.txs.length) throw new ClaudiaTxError("nothing_to_sign", `The server returned no transactions: ${[...plan.split.warnings, plan.simulation?.error].filter(Boolean).join(" · ") || "unknown reason"}`);
    if (plan.simulation && !plan.simulation.ok && !opts.allowFailedSimulation) {
      throw new ClaudiaTxError("simulation_failed", `The launch would fail: ${plan.simulation.error ?? "simulation failed"}`);
    }
    const hashes = await this.send(plan.txs);
    this.onStep?.("confirm", "Confirming with Claudia");
    let confirmation: LaunchConfirmation | null = null;
    for (let i = 0; i < 6; i++) {
      try {
        confirmation = await this.client.confirmLaunch(planned.id, hashes);
        if (!confirmation.pending) break;
      } catch (e) {
        if (!(e instanceof ClaudiaApiError) || e.status >= 500 || i === 5) throw e;
      }
      await sleep(3_000);
    }
    const token = (confirmation?.launch.token as string | undefined) ?? plan.predicted.token;
    this.onStep?.("done", `Launched ${token ?? ""}`.trim());
    return { id: planned.id, token, splitter: plan.predicted.splitter, hashes, plan: planned, confirmation };
  }

  /** Quote + unsigned transactions for this wallet (nothing is sent). */
  prepareTrade(token: string, side: "buy" | "sell", amount: number, opts: { slippageBps?: number; priorityFee?: number; approveMax?: boolean } = {}): Promise<PreparedTrade> {
    return this.client.tradePrepare({
      token: toTokenKey(token, this.chain),
      side,
      ...(side === "buy" ? { amountNative: amount } : { pct: amount }),
      trader: this.address,
      slippageBps: opts.slippageBps,
      priorityFee: opts.priorityFee,
      approveMax: opts.approveMax,
    });
  }

  /** Buy `eth` worth of a token. */
  async buy(token: string, eth: number, opts: { slippageBps?: number; priorityFee?: number } = {}): Promise<EvmTradeResult> {
    await this.client.assertChainOpen(this.chain);
    const prepared = await this.prepareTrade(token, "buy", eth, opts);
    return { prepared, hashes: await this.send(prepared.txs) };
  }

  /** Sell `pct` percent (0–100] of this wallet's balance of a token (includes the approval when needed). */
  async sell(token: string, pct: number, opts: { slippageBps?: number; priorityFee?: number; approveMax?: boolean } = {}): Promise<EvmTradeResult> {
    await this.client.assertChainOpen(this.chain);
    const prepared = await this.prepareTrade(token, "sell", pct, opts);
    return { prepared, hashes: await this.send(prepared.txs) };
  }

  /** Accrued fees of one of your launches (with the creator's 70%). */
  fees(launchId: string): Promise<LaunchFees> {
    return this.client.launchFees(launchId);
  }

  /** Collect a launch's fees and split them 70/30 on-chain. */
  async harvest(launchId: string): Promise<{ plan: HarvestPlan; hashes: string[] }> {
    const plan = await this.client.harvestPlan(launchId);
    if (!plan.txs.length) return { plan, hashes: [] };
    return { plan, hashes: await this.send(plan.txs) };
  }

  /** On-chain view of a launch's FeeSplitter. */
  splitter(address: string, tokens?: string[]): Promise<FeeSplitterInfo> {
    return readFeeSplitter(address, { chain: this.chain, rpcUrl: this.rpcUrl, tokens });
  }
}
