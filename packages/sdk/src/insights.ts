// Coin and wallet insights (GET /api/insights/*). Public, no key needed, rate limited per IP (10/s, burst 40).
// The website answers from its memory cache first and only asks GMGN when nothing is cached, so answers can be a
// little old: every response says when it was made (`updatedAt`) and what is missing (`partial`).
import type { HttpCore, RequestOptions } from "./http.js";
import type {
  HolderList,
  DevReport,
  InsightsStatusReport,
  ScoresReport,
  SignalFeed,
  TokenInsights,
  TradeFeed,
  WalletReport,
} from "./insights-types.js";
import type { ChainId, TokenSnapshot } from "./types.js";
import { toTokenKey } from "./token-key.js";

/** GET /api/insights/trending | /hot — board cards ranked by GMGN. */
export interface BoardFeed {
  data: TokenSnapshot[];
  updatedAt: number | null;
  partial: string | null;
}

export type InsightsInterval = "1m" | "5m" | "1h" | "6h" | "24h";
export type TrendingOrder = "volume" | "swaps" | "liquidity" | "marketcap" | "holders" | "price" | "change" | "change1m" | "change5m" | "change1h" | "kol" | "smart" | "created" | "ath";

const seg = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ":");

type Getter = <T>(path: string, query?: RequestOptions["query"]) => Promise<T>;

function getterOf(http: HttpCore): Getter {
  return <T>(path: string, query?: RequestOptions["query"]) => http.request<T>("GET", path, { query }).then((r) => r.data);
}

/** `client.insights` — one coin or one wallet at a time. */
export class InsightsApi {
  private readonly get: Getter;
  constructor(http: HttpCore) {
    this.get = getterOf(http);
  }

  /** Info, stats, security, pool, signals and dev summary. 404 (`http_404`) when nobody has data for the coin. */
  token(key: string): Promise<TokenInsights> {
    return this.get(`/api/insights/token/${seg(toTokenKey(key))}`);
  }

  /** Top holders with wallet tags (kol, smart, whale, sniper, bundler, insider, fresh, dev, …). `limit` 20–100, default 50. */
  holders(key: string, opts: { limit?: number } = {}): Promise<HolderList> {
    return this.get(`/api/insights/token/${seg(toTokenKey(key))}/holders`, { limit: opts.limit });
  }

  /** Top traders (same row shape as holders, ranked by trading). */
  traders(key: string, opts: { limit?: number } = {}): Promise<HolderList> {
    return this.get(`/api/insights/token/${seg(toTokenKey(key))}/traders`, { limit: opts.limit });
  }

  /** The creator: past coins, conduct / power / total scores, each with reasons. 404 when the dev is unknown. */
  dev(key: string): Promise<DevReport> {
    return this.get(`/api/insights/token/${seg(toTokenKey(key))}/dev`);
  }

  /** Safety, holder-structure and chart scores (0–100, a grade and the reasons behind every point). */
  scores(key: string): Promise<ScoresReport> {
    return this.get(`/api/insights/token/${seg(toTokenKey(key))}/scores`);
  }

  /** A wallet's tags, P&L, win rate, style, score and recent trades. */
  wallet(chain: ChainId, address: string): Promise<WalletReport>;
  wallet(address: string): Promise<WalletReport>;
  wallet(a: string, b?: string): Promise<WalletReport> {
    const [chain, address] = b === undefined ? (a.includes(":") ? (a.split(":", 2) as [string, string]) : ["sol", a]) : [a, b];
    return this.get(`/api/insights/wallet/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`);
  }

  /** GMGN gateway + live-trades health (rate, queue, cache hit rate). No secrets. */
  status(): Promise<InsightsStatusReport> {
    return this.get("/api/insights/status");
  }

  /** Trending coins over an interval, ranked by `order` (default volume over 1h). */
  trending(opts: { chain?: ChainId; interval?: InsightsInterval; order?: TrendingOrder } = {}): Promise<BoardFeed> {
    return this.get("/api/insights/trending", { chain: opts.chain, interval: opts.interval, order: opts.order });
  }

  /** GMGN's "hot" list over an interval (default 1h). */
  hot(opts: { chain?: ChainId; interval?: InsightsInterval } = {}): Promise<BoardFeed> {
    return this.get("/api/insights/hot", { chain: opts.chain, interval: opts.interval });
  }
}

/** `client.feeds` — market-wide feeds (newest first). */
export class FeedsApi {
  private readonly get: Getter;
  constructor(http: HttpCore) {
    this.get = getterOf(http);
  }

  /** Buys and sells by known KOL wallets. */
  kol(opts: { chain?: ChainId; side?: "buy" | "sell" } = {}): Promise<TradeFeed> {
    return this.get("/api/insights/feed/kol", { chain: opts.chain, side: opts.side });
  }

  /** Smart-money trades. */
  smart(opts: { chain?: ChainId; side?: "buy" | "sell" } = {}): Promise<TradeFeed> {
    return this.get("/api/insights/feed/smart", { chain: opts.chain, side: opts.side });
  }

  /** Market signals: smart/KOL buys, price spikes, new ATHs, DEX ads and boosts, CTOs, … */
  signals(opts: { chain?: ChainId } = {}): Promise<SignalFeed> {
    return this.get("/api/insights/feed/signals", { chain: opts.chain });
  }
}
