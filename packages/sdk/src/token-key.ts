import { ClaudiaConfigError } from "./errors.js";
import type { ChainId } from "./types.js";
import { CLAUDIA_TOKEN } from "./types.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Token key from user input: "sol:<mint>" from a bare Solana mint, "hood:0x…" from a bare 0x address (Robinhood
 * Chain unless `chain` says otherwise), "$CLAUDIA"/"claudia", or an existing key (EVM addresses are lower-cased).
 */
export function toTokenKey(input: string, chain?: ChainId): string {
  const s = String(input ?? "").trim();
  if (!s) throw new ClaudiaConfigError("bad_token", "Give a token mint or key (sol:<mint>, hood:0x…)");
  if (/^\$?claudia$/i.test(s)) return `sol:${CLAUDIA_TOKEN.mint}`;
  const m = /^([a-z]+):(.+)$/i.exec(s);
  if (m) {
    const [, c, addr] = m;
    return EVM_ADDRESS.test(addr) ? `${c.toLowerCase()}:${addr.toLowerCase()}` : `${c.toLowerCase()}:${addr}`;
  }
  if (EVM_ADDRESS.test(s)) {
    const c = chain && chain !== "sol" ? chain : "hood";
    return `${c}:${s.toLowerCase()}`;
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) {
    if (chain && chain !== "sol") throw new ClaudiaConfigError("bad_token", `"${s}" is a Solana mint, not a ${chain} token address`);
    return `sol:${s}`;
  }
  throw new ClaudiaConfigError("bad_token", `"${s}" doesn't look like a Solana mint, a 0x token address or a token key (sol:<mint>, hood:0x…)`);
}

/** The chain of a token key ("hood:0x…" → "hood"); bare input is classified like `toTokenKey`. */
export function chainOfKey(key: string): ChainId {
  const c = toTokenKey(key).split(":", 1)[0];
  return (c === "hood" || c === "bsc" ? c : "sol") as ChainId;
}
