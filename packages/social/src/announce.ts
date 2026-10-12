// Launch-announcement templates: a plain, rule-safe post for a coin launched through Claudia. Solana (pump.fun) and
// Robinhood Chain (beta: Pons V2, Pools, Flap, Bags, Clanker, Dyor). No price talk, no calls to buy; the AI and
// not-financial-advice labels are added per network when the post is drafted.
import { ClaudiaSocialError } from "./errors.js";

export type AnnounceChain = "sol" | "hood" | "bsc";

export interface LaunchAnnouncementInput {
  /** Default "sol". "bsc" is coming soon and refused. */
  chain?: AnnounceChain;
  /** Launchpad id: pump on Solana; pons, pools, flap, bags, clanker or dyor on Robinhood Chain. */
  launchpad?: string;
  name: string;
  symbol: string;
  /** Token address (mint on Solana, 0x on Robinhood). Adds the explorer link. */
  token?: string;
  /** The coin page (e.g. https://useclaudia.xyz/t/hood/0x…). */
  url?: string;
  /** Mention the 70/30 creator-fee split (default true). */
  feeSplit?: boolean;
}

export interface LaunchAnnouncement {
  text: string;
  chainLabel: string;
  launchpadLabel: string;
  explorerUrl?: string;
}

const LAUNCHPADS: Record<string, string> = { pump: "pump.fun", pons: "Pons V2", pools: "Pools", flap: "Flap", bags: "Bags", clanker: "Clanker", dyor: "Dyor" };
const ROBINHOOD_PADS = new Set(["pons", "pools", "flap", "bags", "clanker", "dyor"]);

/** Builds the announcement text for a launch (Solana or Robinhood Chain). */
export function launchAnnouncement(i: LaunchAnnouncementInput): LaunchAnnouncement {
  const chain = i.chain ?? "sol";
  if (chain === "bsc") throw new ClaudiaSocialError("unsupported", "BNB Chain launches are coming soon on Claudia.");
  const pad = (i.launchpad ?? (chain === "sol" ? "pump" : "")).toLowerCase();
  if (chain === "hood" && !ROBINHOOD_PADS.has(pad)) throw new ClaudiaSocialError("invalid", "Pick the Robinhood Chain launchpad: pons, pools, flap, bags, clanker or dyor.");
  if (chain === "sol" && pad !== "pump") throw new ClaudiaSocialError("invalid", "Solana launches on Claudia use pump.fun (launchpad: pump).");
  const symbol = String(i.symbol ?? "").trim().replace(/^\$+/, "").toUpperCase();
  const name = String(i.name ?? "").replace(/\s+/g, " ").trim();
  if (!symbol || !name) throw new ClaudiaSocialError("invalid", "A launch announcement needs the coin's name and ticker.");
  const chainLabel = chain === "hood" ? "Robinhood Chain (beta)" : "Solana";
  const launchpadLabel = LAUNCHPADS[pad] ?? pad;
  const explorerUrl = i.token ? (chain === "hood" ? `https://robinhoodchain.blockscout.com/token/${i.token}` : `https://solscan.io/token/${i.token}`) : undefined;
  const lines = [
    `$${symbol} (${name}) just launched on ${launchpadLabel}, ${chainLabel}, through Claudia.`,
    i.feeSplit === false ? "" : chain === "hood" ? "Creator fees split 70/30 on-chain, fixed at launch." : "Creator fees split 70/30 on-chain.",
    i.url ?? "",
    !i.url && explorerUrl ? explorerUrl : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), chainLabel, launchpadLabel, explorerUrl };
}
