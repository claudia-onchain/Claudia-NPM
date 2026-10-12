// pump.fun coin field rules (same as the server: NFKC, ticker A–Z0–9 ≤ 13, name ≤ 32 bytes — rejected, never truncated).
export const PUMP_LIMITS = { nameMax: 32, symbolMax: 13, uriMax: 200 } as const;

export type FieldCheck = { ok: true; value: string } | { ok: false; error: string };

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export function normalizeTicker(raw: string, max: number = PUMP_LIMITS.symbolMax): FieldCheck {
  const v = (raw ?? "").normalize("NFKC").trim().replace(/^\$+/, "").toUpperCase();
  if (!v) return { ok: false, error: "Add a ticker" };
  if (!/^[A-Z0-9]+$/.test(v)) return { ok: false, error: "Tickers can only use letters A–Z and digits 0–9" };
  if (v.length > max) return { ok: false, error: `Tickers are limited to ${max} characters — yours has ${v.length}` };
  return { ok: true, value: v };
}

export function normalizeCoinName(raw: string, maxBytes: number = PUMP_LIMITS.nameMax): FieldCheck {
  const v = (raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!v) return { ok: false, error: "Give your coin a name" };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return { ok: false, error: "The name contains control characters" };
  const n = utf8Len(v);
  if (n > maxBytes) return { ok: false, error: `Names are limited to ${maxBytes} bytes (emoji and accents count double or more) — yours is ${n}. Shorten it.` };
  return { ok: true, value: v };
}

/** Solscan link for a transaction or address (devnet when the platform runs on testnet). */
export function explorerUrl(kind: "tx" | "account" | "token", id: string, network: "mainnet" | "testnet" = "mainnet"): string {
  return `https://solscan.io/${kind}/${id}${network === "testnet" ? "?cluster=devnet" : ""}`;
}
