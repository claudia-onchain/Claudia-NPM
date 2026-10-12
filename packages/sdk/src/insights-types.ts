// Copied from the website's shared contract (DexPumpzip/shared/insights.ts) — keep in sync by hand.
// Do not import across repos: the SDK must build on its own.
// Token / wallet insights — the shared contract between server/insights (GMGN gateway + endpoints), server/insights/scores
// (scores ported from the GMGN skills), server/trades (live trades while watched) and the client (coin page, Trenches,
// Tracker, Home). Data comes from GMGN's OpenAPI (cached in memory, never written to the database) plus our own feeds.
// Every field is optional on the wire: GMGN can be paused (rate limit / outage / no key) and pages must still render.
import type { ChainId } from "./types.js";

export type InsightSource = "gmgn" | "claudia" | "dexscreener" | "rpc";

/** Small icons next to wallets in Holders / Top traders / Trades. One wallet can carry several. */
export const WALLET_TAGS = [
  "kol", //            renowned / KOL wallet (blue tick)
  "smart", //          smart money
  "whale", //          large holder (≥ 1% of supply or ≥ $50k)
  "sniper", //         bought in the first seconds
  "bundler", //        bundled buy (stacked papers)
  "insider", //        suspected insider
  "fresh", //          new wallet (green leaf)
  "dev", //            creator / dev team
  "rat", //            rat trader (front-run / farm)
  "bot", //            bot degen
  "wash", //           wash trader
  "exchange", //       CEX / known exchange wallet
  "pool", //           liquidity pool / bonding curve
  "suspicious", //     GMGN flagged
  "top10", //          in the top 10 holders
] as const;
export type WalletTag = (typeof WALLET_TAGS)[number];

/** Trading terminal / bot a wallet uses (from GMGN tags): shown as a tiny text chip, not an icon. */
export type WalletTool = "axiom" | "gmgn" | "photon" | "bullx" | "trojan" | "padre" | "maestro" | "bonkbot" | "other";

export interface WalletIdentity {
  address: string;
  /** X / display name when known (KOLs). */
  name?: string | null;
  twitter?: string | null;
  avatar?: string | null;
  tags: WalletTag[];
  tools: WalletTool[];
}

export interface HolderRow extends WalletIdentity {
  rank: number;
  /** Share of total supply, 0–1. */
  pct: number;
  amount: number;
  usdValue?: number | null;
  avgCostUsd?: number | null;
  realizedPnlUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  /** Total P&L as a ratio (0.5 = +50%). */
  pnlRatio?: number | null;
  buys?: number | null;
  sells?: number | null;
  /** Unix ms. */
  firstSeenAt?: number | null;
  lastActiveAt?: number | null;
  /** Where its first SOL came from (funding wallet), for "related wallets". */
  fundedBy?: string | null;
}

/** Same shape as a holder; ranked by trading instead of balance. */
export type TraderRow = HolderRow;

export interface TokenSecurity {
  mintRenounced?: boolean | null;
  freezeRenounced?: boolean | null;
  honeypot?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  top10Pct?: number | null; // 0–1
  burnRatio?: number | null; // 0–1
  burnStatus?: string | null;
  lpLocked?: boolean | null;
  blacklist?: boolean | null;
  /** Human-readable flags ("Mint not renounced", "Top 10 hold 45%"…). */
  warnings: string[];
}

export interface TokenStats {
  priceUsd?: number | null;
  mcapUsd?: number | null;
  liquidityUsd?: number | null;
  athPriceUsd?: number | null;
  holders?: number | null;
  /** Buys / sells / volume (USD) / swaps over 1m, 5m, 1h, 6h, 24h. */
  windows: Partial<Record<"1m" | "5m" | "1h" | "6h" | "24h", { buys: number; sells: number; volumeUsd: number; buyVolumeUsd: number; sellVolumeUsd: number; swaps: number; priceChangePct?: number | null }>>;
  /** Wallet mix shares, 0–1. */
  top10Pct?: number | null;
  snipersPct?: number | null;
  bundlersPct?: number | null;
  insidersPct?: number | null;
  freshPct?: number | null;
  botPct?: number | null;
  ratPct?: number | null;
  devHoldPct?: number | null;
  /** Wallet counts by kind. */
  counts?: Partial<Record<"smart" | "kol" | "fresh" | "sniper" | "bundler" | "rat" | "whale" | "creator" | "top", number>>;
  bondingPct?: number | null;
  launchpad?: string | null;
  migrated?: boolean | null;
  createdAt?: number | null; // unix ms
  migratedAt?: number | null; // unix ms
  totalFeesUsd?: number | null;
}

export type SignalKind =
  | "smart_buy" | "kol_buy" | "price_spike" | "ath" | "mcap_level" | "dex_ad" | "dex_boost" | "dex_trending" | "dex_link"
  | "cto" | "bundler_sell" | "pump_claim" | "bags_claim" | "live" | "platform_call" | "other";

export interface TokenSignal {
  kind: SignalKind;
  label: string; // "Smart money bought", "New ATH"…
  at: number; // unix ms
  mcapUsd?: number | null;
  detail?: string | null;
}

export interface DevSummary {
  address: string;
  launches: number;
  migrated: number;
  migratedRatio: number; // 0–1
  bestMcapUsd?: number | null;
  holdsPct?: number | null; // 0–1, in this coin
  status?: "holding" | "sold" | "closed" | "unknown";
  fundedBy?: string | null;
  rugRatio?: number | null; // 0–1 (GMGN)
}

/** GET /api/insights/token/:key — the fast set (info + security + pool + signals + dev summary). */
export interface TokenInsights {
  key: string; // "sol:<mint>"
  chain: ChainId;
  address: string;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  socials?: { twitter?: string | null; telegram?: string | null; website?: string | null; xFollowers?: number | null } | null;
  stats: TokenStats;
  security?: TokenSecurity | null;
  pool?: { address: string; exchange?: string | null; liquidityUsd?: number | null; quoteSymbol?: string | null; createdAt?: number | null } | null;
  signals: TokenSignal[];
  dev?: DevSummary | null;
  source: InsightSource;
  /** Unix ms of the newest piece of data. */
  updatedAt: number;
  /** Set when some parts are missing because GMGN is paused / unavailable. */
  partial?: string | null;
}

// ─── scores (ported from the GMGN skills; every number explains itself) ──

export interface ScoreReason {
  label: string; // "Dev pulled out 2.7× what he put in"
  points: number; // signed contribution
  field?: string; // which input it read
}

export interface Score {
  value: number; // 0–100
  grade: "good" | "mixed" | "risky" | "unknown";
  title: string; // "Clean dev", "Dumps early"…
  reasons: ScoreReason[];
  /** Plain one-liner for the UI. */
  summary: string;
}

/** GET /api/insights/token/:key/dev */
export interface DevProfile {
  summary: DevSummary;
  /** conduct = will he dump on you; power = has he ever built anything (gmgn-dev-score). */
  conduct: Score;
  power: Score;
  total: Score;
  coins: { address: string; symbol?: string | null; name?: string | null; athMcapUsd?: number | null; migrated: boolean; createdAt?: number | null }[];
}

/** GET /api/insights/token/:key/scores */
export interface TokenScores {
  safety: Score; // gmgn-contract-dd
  holders: Score & { // gmgn-holder-analysis
    breakdown: { label: string; pct: number; tag?: WalletTag }[];
  };
  chart: Score & { pattern: string }; // gmgn-kline-pattern
}

/** GET /api/insights/wallet/:chain/:address */
export interface WalletProfile extends WalletIdentity {
  chain: ChainId;
  nativeBalance?: number | null;
  realizedPnlUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  winRate?: number | null; // 0–1
  buys7d?: number | null;
  sells7d?: number | null;
  tokensTraded?: number | null;
  /** gmgn-wallet-style / -score / -review. */
  style?: { title: string; subtitle?: string | null; badges: string[] } | null;
  score?: Score | null;
  review?: string | null;
  createdTokens?: number | null;
  /** X followers of the wallet's linked account (KOLs). */
  xFollowers?: number | null;
  /** Recent buys / sells (GET /v1/user/wallet_activity), newest first. */
  recent?: FeedTrade[];
}

/** Feed rows: KOL buys, smart-money trades (GET /api/insights/feed/kol | /feed/smart). */
export interface FeedTrade {
  wallet: WalletIdentity;
  tokenKey: string;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  side: "buy" | "sell";
  amountUsd: number;
  priceUsd?: number | null;
  tx?: string | null;
  at: number; // unix ms
}

export interface FeedSignal extends TokenSignal {
  tokenKey: string;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
}

/** GET /api/insights/status (public, no secrets) */
export interface InsightsStatus {
  gmgn: {
    enabled: boolean;
    reason?: string | null;
    ratePerSec: number; // current adaptive rate
    maxRatePerSec: number;
    queued: number;
    pausedUntil?: number | null; // unix ms (429 cooldown)
    calls1m: number;
    errors1m: number;
    cacheEntries: number;
    hitRate: number; // 0–1
  };
  liveTrades: {
    source: "pumpportal" | "alchemy" | "none";
    watching: number; // tokens with live subscriptions
    pumpportal: { connected: boolean; keyed: boolean; subscribed: number };
    alchemy: { configured: boolean; connected: boolean; subscribed: number };
  };
}

// ─── response envelopes (as served by server/insights/routes.ts) ─────────────
// Not part of shared/insights.ts: these mirror what each route actually returns around the shared types.

/** How fresh an answer is. `partial` explains what's missing (e.g. "GMGN rate limited"); `updatedAt` is unix ms. */
export interface Freshness {
  updatedAt: number | null;
  partial: string | null;
}

/** GET /api/insights/token/:key/holders | /traders */
export interface HolderList extends Freshness {
  data: HolderRow[];
  source: InsightSource;
}

/** GET /api/insights/token/:key/dev */
export type DevReport = DevProfile & Freshness;

/** GET /api/insights/token/:key/scores */
export type ScoresReport = TokenScores & Freshness;

/** GET /api/insights/wallet/:chain/:address */
export type WalletReport = WalletProfile & Freshness;

/** GET /api/insights/feed/kol | /feed/smart */
export interface TradeFeed extends Freshness {
  data: FeedTrade[];
}

/** GET /api/insights/feed/signals */
export interface SignalFeed extends Freshness {
  data: FeedSignal[];
}

/** GET /api/insights/status — plus the website's indexing counters (shape may grow). */
export type InsightsStatusReport = InsightsStatus & { indexing?: Record<string, unknown> };
