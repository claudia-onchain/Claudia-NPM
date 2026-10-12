// Number and time formatting for the terminal. Every function takes null/undefined/NaN and returns "—".
import { term } from "./term.js";

const DASH = () => (term().unicode ? "—" : "-");
const bad = (n: number | null | undefined): n is null | undefined => n === null || n === undefined || !Number.isFinite(n);

/** 1234 → "1.2K", 3_400_000 → "3.4M", 0.5 → "0.5". */
export function compact(n: number | null | undefined, digits = 1): string {
  if (bad(n)) return DASH();
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const f = (x: number, s: string) => `${sign}${trim(x.toFixed(x >= 100 ? 0 : digits))}${s}`;
  if (a >= 1e12) return f(a / 1e12, "T");
  if (a >= 1e9) return f(a / 1e9, "B");
  if (a >= 1e6) return f(a / 1e6, "M");
  if (a >= 1e4) return f(a / 1e3, "K");
  if (a >= 1e3) return f(a / 1e3, "K");
  if (a >= 1) return `${sign}${trim(a.toFixed(a >= 100 ? 0 : digits))}`;
  if (a === 0) return "0";
  return `${sign}${trim(a.toPrecision(2))}`;
}

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** Whole numbers with thousands separators. */
export function int(n: number | null | undefined): string {
  if (bad(n)) return DASH();
  return Math.round(n).toLocaleString("en-US");
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Money: compact for amounts ($1.2K, $4.5M), cents for normal prices, and memecoin prices with a zero count
 * ($0.0₅123 = 0.00000123) when the terminal has Unicode.
 */
export function usd(n: number | null | undefined, opts: { exact?: boolean } = {}): string {
  if (bad(n)) return DASH();
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (a >= 1e4 && !opts.exact) return `${sign}$${compact(a)}`;
  if (a >= 1) return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: a >= 1000 ? 0 : 2, maximumFractionDigits: a >= 1000 ? 0 : 2 })}`;
  if (a >= 0.1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${trim(a.toFixed(4))}`;
  // tiny prices: count the zeros after "0."
  const s = a.toFixed(20);
  const m = /^0\.(0+)(\d{1,4})/.exec(s);
  if (!m) return `${sign}$${trim(a.toPrecision(3))}`;
  const zeros = m[1].length;
  const digits = m[2].replace(/0+$/, "") || "0";
  if (term().unicode && zeros >= 4) return `${sign}$0.0${String(zeros).split("").map((d) => SUB[Number(d)]).join("")}${digits}`;
  return `${sign}$${trim(a.toFixed(zeros + Math.min(4, digits.length)))}`;
}

/** SOL amounts: up to 4 decimals for small numbers, compact for big ones. */
export function sol(n: number | null | undefined): string {
  if (bad(n)) return DASH();
  const a = Math.abs(n);
  if (a >= 1e4) return `${compact(n)} SOL`;
  if (a >= 1) return `${trim(n.toFixed(3))} SOL`;
  if (a === 0) return "0 SOL";
  return `${trim(n.toFixed(a >= 0.001 ? 4 : 6)) || "0"} SOL`;
}

/** ETH amounts (Robinhood Chain): same rules as SOL, more decimals for dust. */
export function eth(n: number | null | undefined): string {
  if (bad(n)) return DASH();
  const a = Math.abs(n);
  if (a >= 1e4) return `${compact(n)} ETH`;
  if (a >= 1) return `${trim(n.toFixed(3))} ETH`;
  if (a === 0) return "0 ETH";
  return `${trim(n.toFixed(a >= 0.001 ? 5 : 8)) || "0"} ETH`;
}

/** An amount in a chain's native coin. */
export const native = (n: number | null | undefined, chain: string): string => (chain === "hood" ? eth(n) : sol(n));

/** 12.345 → "+12.3%". Pass `ratio: true` when the input is 0–1. Uncoloured (see ui.delta for colour). */
export function pctText(n: number | null | undefined, opts: { ratio?: boolean; sign?: boolean; digits?: number } = {}): string {
  if (bad(n)) return DASH();
  const v = opts.ratio ? n * 100 : n;
  const a = Math.abs(v);
  if (a > 0 && a < 0.01 && opts.digits === undefined) return `${v < 0 ? "-" : ""}<0.01%`;
  if (a >= 1000 && opts.digits === undefined) return `${v < 0 ? "-" : opts.sign ? "+" : ""}${compact(a)}%`;
  const d = opts.digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : 2);
  const body = trim(a.toFixed(d));
  const sign = v < 0 ? "-" : opts.sign && v > 0 ? "+" : "";
  return `${sign}${body}%`;
}

export function ago(t: string | number | null | undefined): string {
  if (t === null || t === undefined || t === "") return DASH();
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return DASH();
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / (86400 * 30))}mo ago`;
}

/** Age of something created at `t`: "4m", "3h", "12d". */
export function age(t: number | null | undefined): string {
  if (bad(t) || !t) return DASH();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function inSec(sec: number): string {
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.round((sec / 3600) * 10) / 10} h`;
}

export function bytes(n: number | null | undefined): string {
  if (bad(n)) return DASH();
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${trim((n / 1024).toFixed(1))} KB`;
  if (n < 1024 ** 3) return `${trim((n / 1024 ** 2).toFixed(1))} MB`;
  return `${trim((n / 1024 ** 3).toFixed(2))} GB`;
}

/** "7xKX…kAsU". */
export function short(addr: string | null | undefined, n = 4): string {
  if (!addr) return DASH();
  const e = term().unicode ? "…" : "..";
  return addr.length > n * 2 + 1 ? `${addr.slice(0, n)}${e}${addr.slice(-n)}` : addr;
}

/** Masks a secret: "sk-or-v1-…9f2c" (prefix kept when it's a known shape, last 4 always). */
export function mask(secret: string | null | undefined): string {
  if (!secret) return DASH();
  const s = secret.trim();
  if (s.length <= 8) return (term().unicode ? "•" : "*").repeat(Math.max(4, s.length));
  const prefix = /^(sk-or-v1-|sk-ant-|sk-proj-|sk-|xai-|ck_live_|gsk_|AIza|ghp_|xoxb-)/.exec(s)?.[0] ?? s.slice(0, 2);
  return `${prefix}${term().unicode ? "…" : "..."}${s.slice(-4)}`;
}
