// Chains Claudia supports, in display order. Solana is the default and always first. Robinhood Chain is live in
// beta (an admin switch on the site); BNB Chain is coming soon. Live availability comes from GET /api/platform/config.
import { ClaudiaConfigError } from "./errors.js";
import type { ChainId, ChainSwitchState, LaunchpadId, PlatformConfig, SwitchState } from "./types.js";

export type ChainKind = "svm" | "evm";

export interface ChainInfo {
  id: ChainId;
  name: string;
  short: string;
  kind: ChainKind;
  /** EVM chain id (EVM chains only). */
  evmChainId?: number;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Public RPC (rate limited: fine for a bot, use your own for volume). */
  publicRpc: string;
  explorer: string;
  explorerName: string;
}

/** Display order everywhere. Solana first: it is the default chain. */
export const CHAIN_ORDER: readonly ChainId[] = ["sol", "hood", "bsc"];

export const CHAINS: Readonly<Record<ChainId, ChainInfo>> = {
  sol: {
    id: "sol",
    name: "Solana",
    short: "SOL",
    kind: "svm",
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    publicRpc: "https://api.mainnet-beta.solana.com",
    explorer: "https://solscan.io",
    explorerName: "Solscan",
  },
  hood: {
    id: "hood",
    name: "Robinhood Chain",
    short: "HOOD",
    kind: "evm",
    evmChainId: 4663,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpc: "https://rpc-robinhood.globalstake.io",
    explorer: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
  },
  bsc: {
    id: "bsc",
    name: "BNB Chain",
    short: "BSC",
    kind: "evm",
    evmChainId: 56,
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    publicRpc: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    explorerName: "BscScan",
  },
};

/** Chain ids that 0.2 accepted but Claudia no longer offers. Passing one throws `chain_retired`. */
export const RETIRED_CHAINS = ["base", "arc"] as const;
export type RetiredChainId = (typeof RETIRED_CHAINS)[number];

export const isChainId = (v: unknown): v is ChainId => typeof v === "string" && (CHAIN_ORDER as readonly string[]).includes(v);

/**
 * "sol" | "hood" | "bsc" from user input (also "solana", "robinhood", "bnb"). Default "sol". Retired ids (base, arc)
 * and unknown ones throw a `ClaudiaConfigError` with a clear message.
 */
export function parseChain(input: string | undefined | null, fallback: ChainId = "sol"): ChainId {
  const v = String(input ?? "").trim().toLowerCase();
  if (!v) return fallback;
  const alias: Record<string, ChainId> = { sol: "sol", solana: "sol", hood: "hood", robinhood: "hood", "robinhood-chain": "hood", bsc: "bsc", bnb: "bsc", "bnb-chain": "bsc" };
  if (alias[v]) return alias[v];
  if ((RETIRED_CHAINS as readonly string[]).includes(v)) {
    throw new ClaudiaConfigError("chain_retired", `${v} is no longer supported. Chains: ${CHAIN_ORDER.join(", ")}`);
  }
  throw new ClaudiaConfigError("bad_chain", `Unknown chain "${input}". Chains: ${CHAIN_ORDER.join(", ")}`);
}

/** Explorer link for a transaction or address on a chain. */
export function chainExplorerUrl(chain: ChainId, kind: "tx" | "address" | "token", id: string): string {
  const c = CHAINS[chain];
  if (c.kind === "svm") return `${c.explorer}/${kind === "address" ? "account" : kind}/${id}`;
  return `${c.explorer}/${kind === "token" ? "token" : kind}/${id}`;
}

// ─── live availability ───────────────────────────────────────────────

/** live: open · beta: open, marked beta by the site · view_only: data only, no launches · coming_soon: not yet. */
export type ChainAvailability = "live" | "beta" | "view_only" | "coming_soon";

export interface LaunchpadAvailability {
  launchpad: LaunchpadId;
  /** What actually applies on the site right now. */
  state: SwitchState;
  /** Whether agents (API keys) may launch here. */
  allowAgents: boolean;
  note: string | null;
}

export interface ChainStatusInfo extends ChainInfo {
  status: ChainAvailability;
  /** Raw switch state from the site. */
  state: ChainSwitchState;
  note: string | null;
  /** Launchpads on this chain, in the site's order. */
  launchpads: LaunchpadAvailability[];
}

function availability(state: ChainSwitchState, note: string | null | undefined): ChainAvailability {
  if (state === "coming_soon") return "coming_soon";
  if (state === "view_only") return "view_only";
  return /\bbeta\b/i.test(note ?? "") ? "beta" : "live";
}

/** Folds the platform config into one entry per supported chain (sol, hood, bsc — in that order). */
export function chainStatusFrom(cfg: Pick<PlatformConfig, "chains" | "launchpads">): ChainStatusInfo[] {
  return CHAIN_ORDER.map((id) => {
    const row = cfg.chains.find((r) => r.chain === id);
    const state: ChainSwitchState = row?.state ?? "coming_soon";
    return {
      ...CHAINS[id],
      status: availability(state, row?.note),
      state,
      note: row?.note ?? null,
      launchpads: cfg.launchpads
        .filter((p) => p.chain === id && p.effective !== "hidden")
        .map((p) => ({ launchpad: p.launchpad, state: p.effective, allowAgents: p.allowAgents, note: p.note ?? null })),
    };
  });
}

/** Throws `chain_coming_soon` / `chain_view_only` unless launches and trades are open on `chain`. */
export function assertChainOpen(status: ChainStatusInfo[], chain: ChainId): ChainStatusInfo {
  const s = status.find((x) => x.id === chain);
  if (!s || s.status === "coming_soon") throw new ClaudiaConfigError("chain_coming_soon", `${CHAINS[chain].name} is coming soon on Claudia.`);
  if (s.status === "view_only") throw new ClaudiaConfigError("chain_view_only", `${CHAINS[chain].name} is view-only on Claudia right now (no launches or trades).`);
  return s;
}

// ─── Robinhood launchpads (beta) ─────────────────────────────────────

export type RobinhoodLaunchpadId = "pons" | "pools" | "flap" | "bags" | "clanker" | "dyor";

export interface LaunchpadInfo {
  id: RobinhoodLaunchpadId;
  name: string;
  /** Whether the launch can include a dev buy (Dyor has none: it would go to the fee recipient). */
  devBuy: boolean;
  /** How the creator fees reach the per-launch FeeSplitter. */
  feeRoute: string;
}

/** The six Robinhood Chain launchpads Claudia launches on (beta). The creator fees split 70/30 on-chain
 * (a per-launch FeeSplitter, or Clanker's own fixed reward recipients). */
export const ROBINHOOD_LAUNCHPADS: readonly LaunchpadInfo[] = [
  { id: "pons", name: "Pons V2", devBuy: true, feeRoute: "Curve and escrow fees swept into the FeeSplitter" },
  { id: "pools", name: "Pools", devBuy: true, feeRoute: "LP fee vault claimed into the FeeSplitter" },
  { id: "flap", name: "Flap", devBuy: true, feeRoute: "Tax beneficiary is the FeeSplitter" },
  { id: "bags", name: "Bags", devBuy: true, feeRoute: "Fee claimer is the FeeSplitter" },
  { id: "clanker", name: "Clanker", devBuy: true, feeRoute: "Clanker reward recipients fixed at 70 creator / 30 Claudia" },
  { id: "dyor", name: "Dyor", devBuy: false, feeRoute: "Fee recipient is the FeeSplitter (no dev buy)" },
];

/** Claudia's Robinhood Chain contracts (public, verified on Blockscout). */
export const ROBINHOOD_CONTRACTS = {
  feeSplitterFactory: "0xe682a076cBa3d36943Bc2608D225AF8690Fc54Ba",
  socialVaultFactory: "0x89554B535B08330F1b3c502b07f11f7d198E35a7",
  shareSplitterFactory: "0x7f1889C3BfE83A79Bf5A9244Dd2D066f9A4815Eb",
  treasury: "0x8f50591D3C8C30A2c62437574e8843133Ba77FbC",
} as const;

/** Creator / platform split of creator fees on every Claudia launch, in bps. */
export const FEE_SPLIT = { creatorBps: 7000, platformBps: 3000 } as const;
