// The Claudia terminal design system: colours (rose → copper brand, truecolor / 256 / 16 / none), symbols with ASCII
// fallbacks, the wordmark, titles and sections, key/value blocks, box tables that turn into stacked cards on narrow
// terminals, wallet-tag labels, score bars, spinners and progress bars, errors with a "Try:" line, and prompts.
//
// Rules: human output goes to stdout; spinners, progress and errors go to stderr; in --json mode nothing but the
// JSON reaches stdout (log() is silent).
import { createInterface } from "node:readline";
import { term } from "./term.js";
import { center, padEnd, padStart, strWidth, stripAnsi, truncate, wrapText } from "./width.js";
import { ago, inSec, pctText, short, sol, usd } from "./format.js";

export { ago, age, bytes, compact, eth, inSec, int, mask, native, pctText, short, sol, usd } from "./format.js";
export { strWidth, stripAnsi, truncate, padEnd, padStart, middle, wrapText } from "./width.js";

let quiet = false;
export function setQuiet(on: boolean) {
  quiet = on;
}
export const isQuiet = () => quiet;
/** Kept for older call sites: colour is decided by term.ts (configureTerm). */
export function setColor(_on: boolean) {
  /* no-op: see configureTerm */
}

// ─── colour ───────────────────────────────────────────────────────────

export const PALETTE = {
  rose: "#ff6fa5",
  roseDeep: "#d63a76",
  copper: "#ff9a6b",
  buy: "#3ddc97",
  sell: "#ff5a52",
  warn: "#f5c84c",
  info: "#c3a6ff",
  kol: "#1d9bf0",
  gold: "#ffd166",
  cyan: "#5ec8ff",
  text: "#f8ece8",
  muted: "#a48b96",
  line: "#6a4a5c",
} as const;

const BASIC: Record<keyof typeof PALETTE, number> = {
  rose: 95, roseDeep: 35, copper: 33, buy: 32, sell: 31, warn: 33, info: 35, kol: 34, gold: 33, cyan: 36, text: 97, muted: 90, line: 90,
};

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function ansi256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round(((r - 8) / 247) * 24) + 232;
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function fgCode(rgb: [number, number, number], basic: number): [string, string] | null {
  const lvl = term().color;
  if (lvl === 0) return null;
  if (lvl === 3) return [`\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`, "\u001b[39m"];
  if (lvl === 2) return [`\u001b[38;5;${ansi256(rgb)}m`, "\u001b[39m"];
  return [`\u001b[${basic}m`, "\u001b[39m"];
}

/** A colour function for a palette name or any #rrggbb. */
export function paint(color: keyof typeof PALETTE | string, basic?: number): (s: string) => string {
  const hex = color in PALETTE ? PALETTE[color as keyof typeof PALETTE] : color;
  const b = basic ?? (color in BASIC ? BASIC[color as keyof typeof PALETTE] : 37);
  const rgb = hexRgb(hex);
  return (s: string) => {
    const code = fgCode(rgb, b);
    return code && s ? code[0] + s.split(code[1]).join(code[1] + code[0]) + code[1] : s;
  };
}

const sgr = (open: number, close: number) => (s: string) => (term().color && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const c = {
  bold: sgr(1, 22),
  dim: (s: string) => (term().color >= 2 ? paint("muted")(s) : sgr(2, 22)(s)),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  inverse: sgr(7, 27),
  rose: paint("rose"),
  copper: paint("copper"),
  buy: paint("buy"),
  sell: paint("sell"),
  warn: paint("warn"),
  info: paint("info"),
  kol: paint("kol"),
  gold: paint("gold"),
  muted: paint("muted"),
  line: (s: string) => (term().color >= 2 ? paint("line")(s) : sgr(2, 22)(s)),
  // older names
  cyan: paint("cyan"),
  green: paint("buy"),
  yellow: paint("warn"),
  red: paint("sell"),
  magenta: paint("rose"),
  blue: paint("kol"),
  brand: (s: string) => sgr(1, 22)(gradient(s)),
};

/** Rose → copper across the characters (solid rose on 16-colour terminals). */
export function gradient(s: string, from: string = PALETTE.rose, to: string = PALETTE.copper): string {
  const lvl = term().color;
  if (lvl === 0) return s;
  if (lvl === 1) return paint("rose")(s);
  const chars = [...s];
  const visible = chars.filter((ch) => ch !== " ").length;
  const a = hexRgb(from);
  const b = hexRgb(to);
  let i = 0;
  return (
    chars
      .map((ch) => {
        if (ch === " ") return ch;
        const t = visible <= 1 ? 0 : i++ / (visible - 1);
        const rgb: [number, number, number] = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as [number, number, number];
        return lvl === 3 ? `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${ch}` : `\u001b[38;5;${ansi256(rgb)}m${ch}`;
      })
      .join("") + "\u001b[39m"
  );
}

// ─── symbols ──────────────────────────────────────────────────────────

const UNI = {
  ok: "✓", fail: "✗", warn: "!", info: "·", dot: "·", bullet: "•", arrow: "→", back: "←", up: "▲", down: "▼", flat: "–",
  ellipsis: "…", prompt: "?", star: "★", diamond: "◆", circle: "●", ring: "○", live: "●", pointer: "›",
  h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", lt: "├", rt: "┤", tt: "┬", bt: "┴", x: "┼",
  full: "█", empty: "░", half: "▌",
};
const ASCII: typeof UNI = {
  ok: "+", fail: "x", warn: "!", info: "-", dot: "-", bullet: "*", arrow: "->", back: "<-", up: "^", down: "v", flat: "=",
  ellipsis: "...", prompt: "?", star: "*", diamond: "*", circle: "o", ring: "o", live: "*", pointer: ">",
  h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", lt: "+", rt: "+", tt: "+", bt: "+", x: "+",
  full: "#", empty: ".", half: "#",
};
export const sym = (): typeof UNI => (term().unicode ? UNI : ASCII);

// ─── output ───────────────────────────────────────────────────────────

const ASCII_MAP: [RegExp, string][] = [
  [/·/g, "-"], [/→/g, "->"], [/←/g, "<-"], [/…/g, ".."], [/[—–]/g, "-"], [/≈/g, "~"], [/×/g, "x"], [/[✓✔]/g, "+"], [/[✗✘]/g, "x"],
  [/[‘’]/g, "'"], [/[“”]/g, '"'], [/•/g, "*"], [/[▲]/g, "^"], [/[▼]/g, "v"], [/[◆◇●○■□★]/g, "*"], [/≡/g, "="], [/»/g, ">>"], [/±/g, "+/-"], [/≥/g, ">="], [/≤/g, "<="],
  [/[₀₁₂₃₄₅₆₇₈₉]/g, (d: string) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(d))] as unknown as [RegExp, string],
];

/** Replaces typographic characters with ASCII when the terminal can't show Unicode. */
export function asciiSafe(s: string): string {
  if (term().unicode) return s;
  let out = s;
  for (const [re, to] of ASCII_MAP) out = out.replace(re, to as string);
  return out;
}

export function log(s = ""): void {
  if (!quiet) process.stdout.write(asciiSafe(s) + "\n");
}
export const ok = (s: string) => log(`  ${c.buy(sym().ok)} ${s}`);
export const warn = (s: string) => log(`  ${c.warn(sym().warn)} ${s}`);
export const fail = (s: string) => log(`  ${c.sell(sym().fail)} ${s}`);
export const info = (s: string) => {
  for (const l of wrapText(s, Math.max(20, term().width - 4))) log(`  ${c.dim(l)}`);
};
export const note = (s: string) => log(wrap(c.dim(s), undefined, "  "));

export const width = () => term().width;
/** Content width inside the 2-space gutter, capped so lines stay readable on very wide terminals. */
export const contentWidth = (cap = 110) => Math.max(26, Math.min(cap, term().width - 4));

// ─── brand ────────────────────────────────────────────────────────────

/** The compact wordmark used on every title line. */
export const wordmark = () => c.bold(gradient("claudia"));

const BIG = [
  "▄▀▀ █   ▄▀▄ █ █ █▀▄ █ ▄▀▄",
  "█   █   █▀█ █ █ █ █ █ █▀█",
  " ▀▀ ▀▀▀ ▀ ▀ ▀▀▀ ▀▀  ▀ ▀ ▀",
];

/** The three-line wordmark with a caption on the right (help screen). Falls back to one line when narrow/ASCII. */
export function banner(caption: string[] = []): void {
  if (quiet) return;
  const t = term();
  log("");
  if (!t.unicode || t.width < 64) {
    log(`  ${c.bold(gradient("CLAUDIA"))}${caption[0] ? `  ${c.dim(caption[0])}` : ""}`);
    for (const line of caption.slice(1)) log(`  ${c.dim(line)}`);
    log("");
    return;
  }
  BIG.forEach((row, i) => log(`  ${gradient(row)}   ${i < caption.length ? (i === 0 ? c.bold(caption[i]) : c.dim(caption[i])) : ""}`));
  for (const line of caption.slice(BIG.length)) log(`  ${" ".repeat(strWidth(BIG[0]))}   ${c.dim(line)}`);
  log("");
}

/** "claudia › Insights · $WIF" plus a thin rule. */
export function title(s: string, sub?: string): void {
  if (quiet) return;
  const S = sym();
  log("");
  const head = `  ${wordmark()} ${c.dim(S.pointer)} ${c.bold(s)}${sub ? ` ${c.dim(S.dot)} ${c.dim(sub)}` : ""}`;
  log(truncate(head, term().width - 1));
  log(`  ${c.line(S.h.repeat(Math.min(contentWidth(), Math.max(20, strWidth(stripAnsi(head)) - 2))))}`);
}

/** A section heading inside a screen: "── Holders ─────────── 50 wallets". */
export function section(s: string, right?: string): void {
  if (quiet) return;
  const S = sym();
  const w = contentWidth(96);
  const left = `${S.h}${S.h} ${c.bold(s)} `;
  const r = right ? ` ${c.dim(right)}` : "";
  const fill = Math.max(2, w - strWidth(left) - strWidth(r));
  log("");
  log(`  ${c.line(S.h + S.h)} ${c.bold(s)} ${c.line(S.h.repeat(fill))}${r}`);
}

// ─── key / value ──────────────────────────────────────────────────────

export type KV = [label: string, value: string | null | undefined] | null | false | undefined;

/** Aligned key/value rows; long values wrap under themselves. Null rows are skipped. */
export function kvBlock(rows: KV[], opts: { indent?: number; keyWidth?: number } = {}): void {
  if (quiet) return;
  const list = rows.filter((r): r is [string, string] => !!r && r[1] !== null && r[1] !== undefined);
  if (!list.length) return;
  const ind = " ".repeat(opts.indent ?? 2);
  const kw = opts.keyWidth ?? Math.min(18, Math.max(...list.map(([k]) => strWidth(k))));
  const avail = term().width - ind.length - kw - 3;
  const stacked = avail < 24;
  for (const [k, v] of list) {
    if (stacked) {
      log(`${ind}${c.dim(k)}`);
      for (const line of wrapText(v, term().width - ind.length - 3)) log(`${ind}  ${line}`);
      continue;
    }
    const lines = wrapText(v, avail);
    log(`${ind}${c.dim(padEnd(truncate(k, kw), kw))}  ${lines[0] ?? ""}`);
    for (const line of lines.slice(1)) log(`${ind}${" ".repeat(kw)}  ${line}`);
  }
}

/** One key/value row (older call sites). */
export const kv = (k: string, v: string, w = 14) => kvBlock([[k, v]], { keyWidth: Math.max(w, strWidth(k)) > 18 ? strWidth(k) : w });

/** Wraps plain text to the screen with an indent (returns the string). */
export function wrap(text: string, w = contentWidth(100) - 2, indent = "    "): string {
  return wrapText(text, Math.min(w, term().width - indent.length - 1))
    .map((l) => indent + l)
    .join("\n");
}

// ─── tables ───────────────────────────────────────────────────────────

export interface Column<T> {
  header: string;
  /** Cell text (may contain colour). */
  get: (row: T, index: number) => string;
  align?: "left" | "right" | "center";
  /** Can shrink (and truncate) when space is short. Default true for left-aligned columns. */
  flex?: boolean;
  min?: number;
  max?: number;
  /** Dropped first on narrow screens (lower = dropped earlier). Columns without it are kept. */
  priority?: number;
  /** In stacked cards, show on the headline row instead of as "Header value". */
  headline?: boolean;
}

export interface TableOptions {
  /** Below this width rows become stacked cards (default 80). */
  stackBelow?: number;
  /** Max width (default the content width). */
  maxWidth?: number;
  empty?: string;
  /** Keep columns that are empty in every row (default: drop them). */
  keepEmpty?: boolean;
}

/** A box-drawn table with aligned columns. On narrow terminals (< 80 columns) it prints stacked cards instead. */
export function table<T>(columns: Column<T>[], rows: T[], opts: TableOptions = {}): void {
  if (quiet) return;
  if (!rows.length) {
    if (opts.empty) info(opts.empty);
    return;
  }
  const t = term();
  // Columns with nothing in them (every cell blank or "—") are dropped.
  const blank = (v: string) => /^[\s—–-]*$/.test(stripAnsi(v ?? ""));
  if (opts.keepEmpty !== true) columns = columns.filter((col) => col.headline || rows.some((r, i) => !blank(col.get(r, i))));
  if (t.width < (opts.stackBelow ?? 80)) return cards(columns, rows);
  const S = sym();
  const maxW = Math.min(opts.maxWidth ?? t.width - 3, t.width - 3);
  let cols = [...columns];
  const cell = rows.map((r, i) => cols.map((col) => col.get(r, i) ?? ""));
  const widthsOf = (cs: Column<T>[], cellsOf: string[][]) =>
    cs.map((col, j) => Math.min(col.max ?? 999, Math.max(strWidth(col.header), ...cellsOf.map((row) => strWidth(row[j])))));
  let cells = cell;
  let widths = widthsOf(cols, cells);
  const total = (ws: number[]) => ws.reduce((a, b) => a + b, 0) + ws.length * 3 + 1;
  // Drop low-priority columns first, then shrink flexible ones.
  while (total(widths) > maxW) {
    const drop = cols.map((col, j) => ({ j, p: col.priority })).filter((x) => x.p !== undefined).sort((a, b) => a.p! - b.p!)[0];
    const flexRoom = cols.reduce((acc, col, j) => acc + ((col.flex ?? col.align !== "right") ? Math.max(0, widths[j] - (col.min ?? 6)) : 0), 0);
    if (flexRoom >= total(widths) - maxW || !drop) break;
    cols = cols.filter((_, j) => j !== drop.j);
    cells = cells.map((row) => row.filter((_, j) => j !== drop.j));
    widths = widths.filter((_, j) => j !== drop.j);
  }
  let over = total(widths) - maxW;
  while (over > 0) {
    let best = -1;
    for (let j = 0; j < cols.length; j++) {
      const col = cols[j];
      if (!(col.flex ?? col.align !== "right")) continue;
      if (widths[j] <= (col.min ?? 6)) continue;
      if (best < 0 || widths[j] > widths[best]) best = j;
    }
    if (best < 0) break;
    widths[best] -= 1;
    over -= 1;
  }
  if (over > 0) return cards(columns, rows);
  const ell = t.unicode ? "…" : ".";
  const fit = (s: string, w: number, align: Column<T>["align"]) => {
    const v = truncate(s, w, ell);
    return align === "right" ? padStart(v, w) : align === "center" ? center(v, w) : padEnd(v, w);
  };
  const line = (l: string, m: string, r: string) => `  ${c.line(l + widths.map((w) => S.h.repeat(w + 2)).join(m) + r)}`;
  const bar = c.line(S.v);
  log(line(S.tl, S.tt, S.tr));
  log(`  ${bar}${cols.map((col, j) => ` ${c.bold(fit(col.header, widths[j], col.align))} `).join(bar)}${bar}`);
  log(line(S.lt, S.x, S.rt));
  for (const row of cells) log(`  ${bar}${row.map((v, j) => ` ${fit(v, widths[j], cols[j].align)} `).join(bar)}${bar}`);
  log(line(S.bl, S.bt, S.br));
}

/** Stacked cards: the headline columns on one line, the rest as "Header value" pairs wrapped below. */
export function cards<T>(columns: Column<T>[], rows: T[]): void {
  const S = sym();
  const w = term().width - 6;
  const heads = columns.filter((col) => col.headline);
  const rest = columns.filter((col) => !col.headline);
  rows.forEach((r, i) => {
    const head = (heads.length ? heads : columns.slice(0, 1)).map((col) => col.get(r, i)).filter((x) => stripAnsi(x).trim()).join("  ");
    log(`  ${c.line(S.pointer)} ${truncate(head, w)}`);
    const pairs = (heads.length ? rest : columns.slice(1))
      .map((col) => {
        const v = col.get(r, i);
        return stripAnsi(v).trim() && stripAnsi(v).trim() !== "—" && stripAnsi(v).trim() !== "-" ? `${c.dim(col.header)} ${v}` : "";
      })
      .filter(Boolean);
    let line = "";
    for (const p of pairs) {
      if (line && strWidth(line) + 3 + strWidth(p) > w) {
        log(`    ${line}`);
        line = p;
      } else line = line ? `${line}${c.dim("  ")}${p}` : p;
    }
    if (line) log(`    ${line}`);
  });
}

// ─── semantic pieces ──────────────────────────────────────────────────

/** "+12.3%" in green / "-4.1%" in red / "0%" dim. `ratio` when the input is 0–1. */
export function delta(n: number | null | undefined, opts: { ratio?: boolean; arrow?: boolean } = {}): string {
  const s = pctText(n, { ratio: opts.ratio, sign: true });
  if (n === null || n === undefined || !Number.isFinite(n)) return c.dim(s);
  const S = sym();
  const a = opts.arrow ? `${n > 0 ? S.up : n < 0 ? S.down : S.flat} ` : "";
  return n > 0 ? c.buy(a + s) : n < 0 ? c.sell(a + s) : c.dim(a + s);
}

/** Older name: coloured percent change (input already in %). */
export const pct = (n: number | null | undefined) => delta(n);

/** USD P&L coloured by sign. */
export function pnl(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return c.dim(usd(n));
  const s = `${n > 0 ? "+" : ""}${usd(n)}`;
  return n > 0 ? c.buy(s) : n < 0 ? c.sell(s) : c.dim(s);
}

export function tierBadge(tier: string): string {
  return tier === "official" ? c.rose("official") : tier === "verified" ? c.kol(`${sym().ok} verified`) : c.dim("unverified");
}

/** Wallet-tag labels (the website's tag icons as short coloured text). */
const TAGS: Record<string, { label: string; short: string; uni: string; color: keyof typeof PALETTE }> = {
  kol: { label: "KOL", short: "KOL", uni: "✓", color: "kol" },
  smart: { label: "smart", short: "SM", uni: "◆", color: "gold" },
  whale: { label: "whale", short: "WH", uni: "●", color: "cyan" },
  sniper: { label: "sniper", short: "SN", uni: "»", color: "copper" },
  bundler: { label: "bundler", short: "BN", uni: "≡", color: "warn" },
  insider: { label: "insider", short: "IN", uni: "◇", color: "sell" },
  fresh: { label: "fresh", short: "FR", uni: "○", color: "buy" },
  dev: { label: "dev", short: "DEV", uni: "★", color: "rose" },
  rat: { label: "rat", short: "RAT", uni: "×", color: "sell" },
  bot: { label: "bot", short: "BOT", uni: "□", color: "muted" },
  wash: { label: "wash", short: "WSH", uni: "~", color: "muted" },
  exchange: { label: "cex", short: "CEX", uni: "■", color: "muted" },
  pool: { label: "pool", short: "POOL", uni: "≈", color: "muted" },
  suspicious: { label: "flagged", short: "FLAG", uni: "!", color: "sell" },
  top10: { label: "top10", short: "T10", uni: "", color: "muted" },
  you: { label: "you", short: "YOU", uni: "", color: "rose" },
  tracked: { label: "tracked", short: "TRK", uni: "", color: "info" },
};

/** One tag: "KOL ✓" in blue, "≡ bundler" in yellow… `compact` uses 2–4 letter codes. */
export function tagLabel(tag: string, opts: { compact?: boolean } = {}): string {
  const d = TAGS[tag];
  if (!d) return c.dim(tag);
  const color = paint(d.color);
  if (opts.compact) return color(d.short);
  if (!term().unicode || !d.uni) return color(d.label);
  return tag === "kol" ? c.bold(color(`${d.label} ${d.uni}`)) : color(`${d.uni} ${d.label}`);
}

/** Tags in a stable order, most telling first; `skip` drops noise like top10/pool. */
export function tagLabels(tags: string[] | undefined, opts: { compact?: boolean; skip?: string[]; max?: number } = {}): string {
  const order = ["kol", "smart", "dev", "insider", "bundler", "sniper", "whale", "fresh", "rat", "bot", "wash", "suspicious", "exchange", "pool", "top10", "you", "tracked"];
  const skip = new Set(opts.skip ?? ["top10"]);
  const list = [...new Set(tags ?? [])].filter((t) => !skip.has(t)).sort((a, b) => (order.indexOf(a) + 99) % 999 - (order.indexOf(b) + 99) % 999);
  const shown = list.slice(0, opts.max ?? 4).map((t) => tagLabel(t, opts));
  if (list.length > shown.length) shown.push(c.dim(`+${list.length - shown.length}`));
  return shown.join(" ");
}

/** The legend printed under a holders table. */
export function tagLegend(tags: string[]): string {
  return [...new Set(tags)].filter((t) => TAGS[t] && t !== "top10").map((t) => `${tagLabel(t, { compact: true })} ${c.dim(TAGS[t].label)}`).join(c.dim("  "));
}

/** "good" green · "mixed" yellow · "risky" red · "unknown" dim. */
export function grade(g: string, text = g): string {
  return g === "good" ? c.buy(text) : g === "mixed" ? c.warn(text) : g === "risky" ? c.sell(text) : c.dim(text);
}

/** "██████░░░░ 62" coloured by the grade (or by value when no grade). */
export function scoreBar(value: number | null | undefined, g?: string, w = 12): string {
  const S = sym();
  if (value === null || value === undefined || !Number.isFinite(value)) return c.dim(S.empty.repeat(w) + "  –");
  const v = Math.max(0, Math.min(100, value));
  const filled = Math.round((v / 100) * w);
  const gg = g ?? (v >= 70 ? "good" : v >= 40 ? "mixed" : "risky");
  return `${grade(gg, S.full.repeat(filled))}${c.line(S.empty.repeat(w - filled))} ${c.bold(padStart(String(Math.round(v)), 3))}`;
}

/** "████████░░░░░░ 58%" (for jobs). */
export function progressBar(fraction: number, w = 24): string {
  const S = sym();
  const f = Math.max(0, Math.min(1, fraction || 0));
  const filled = Math.round(f * w);
  return `${c.rose(S.full.repeat(filled))}${c.line(S.empty.repeat(w - filled))} ${padStart(String(Math.round(f * 100)), 3)}%`;
}

export function phaseLabel(phase: string, bondingPct?: number | null): string {
  if (phase === "migrated") return c.buy("migrated");
  if (phase === "almost") return c.copper(`almost ${bondingPct !== undefined && bondingPct !== null ? Math.round(bondingPct) + "%" : ""}`.trim());
  return c.rose(`new ${bondingPct !== undefined && bondingPct !== null ? Math.round(bondingPct) + "%" : ""}`.trim());
}

// ─── spinner ──────────────────────────────────────────────────────────

const FRAMES_U = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAMES_A = ["-", "\\", "|", "/"];

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

/** A spinner on stderr (only on a terminal and never in --json mode). Prints a plain line otherwise. */
export function spinner(text: string): Spinner {
  const live = term().errTTY && !quiet && !process.env.CI;
  let label = text;
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const frames = term().unicode ? FRAMES_U : FRAMES_A;
  const clear = () => process.stderr.write("\r\u001b[2K");
  const draw = () => {
    clear();
    process.stderr.write(`  ${c.rose(frames[i++ % frames.length])} ${truncate(label, term().width - 6)}`);
  };
  if (live) {
    process.stderr.write("\u001b[?25l");
    draw();
    timer = setInterval(draw, 80);
  }
  const end = (mark: string, t?: string) => {
    if (timer) clearInterval(timer), (timer = null);
    if (live) {
      clear();
      process.stderr.write("\u001b[?25h");
    }
    if (t !== undefined && !quiet) process.stderr.write(`  ${mark} ${t}\n`);
  };
  return {
    update: (t) => {
      label = t;
      if (!live && !quiet) process.stderr.write(`  ${c.dim(t)}\n`);
    },
    succeed: (t) => end(c.buy(sym().ok), t ?? label),
    fail: (t) => end(c.sell(sym().fail), t ?? label),
    stop: () => end("", undefined),
  };
}

/** Runs `fn` with a spinner; the spinner clears when it settles. */
export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const s = spinner(text);
  try {
    const r = await fn();
    s.stop();
    return r;
  } catch (e) {
    s.stop();
    throw e;
  }
}

// ─── errors ───────────────────────────────────────────────────────────

/**
 * The error box on stderr. On a terminal: a rounded box in the error colour with the message in bold and "Try:" with
 * the next step. Piped / non-TTY / NO_COLOR: the plain two-line form ("✗ message" then "Try: hint"), easy to grep.
 */
export function errorBlock(message: string, hint?: string, code?: string): void {
  message = asciiSafe(message);
  hint = hint === undefined ? undefined : asciiSafe(hint);
  const S = sym();
  const t = term();
  if (t.errTTY && t.width >= 40) {
    const inner = Math.min(t.width - 8, 96);
    const msg = wrapText(message, inner);
    const tip = hint ? wrapText(hint.replace(/^(Run|Try):\s*/i, ""), inner - 5) : [];
    const used = Math.max(...msg.map(strWidth), ...tip.map((l, i) => strWidth(l) + (i === 0 ? 5 : 5)), code && process.env.CLAUDIA_DEBUG ? strWidth(code) + 3 : 0);
    const w = Math.min(inner, Math.max(used, 20));
    const label = ` ${S.fail} Error${code && process.env.CLAUDIA_DEBUG ? ` (${code})` : ""} `;
    const top = `${S.tl}${S.h}${label}${S.h.repeat(Math.max(0, w + 2 - strWidth(label) - 1))}${S.tr}`;
    const row = (txt: string) => `${c.sell(S.v)} ${padEnd(txt, w)} ${c.sell(S.v)}`;
    const lines = [
      `  ${c.sell(top)}`,
      ...msg.map((l) => `  ${row(c.bold(l))}`),
      ...tip.map((l, i) => `  ${row(i === 0 ? `${c.dim("Try:")} ${l}` : `     ${l}`)}`),
      `  ${c.sell(`${S.bl}${S.h.repeat(w + 2)}${S.br}`)}`,
    ];
    process.stderr.write(lines.join("\n") + "\n");
    return;
  }
  const w = t.width - 6;
  const lines = wrapText(message, w);
  process.stderr.write(`  ${c.sell(S.fail)} ${c.bold(lines[0] ?? "")}${code && process.env.CLAUDIA_DEBUG ? c.dim(` (${code})`) : ""}\n`);
  for (const l of lines.slice(1)) process.stderr.write(`    ${l}\n`);
  if (hint) {
    const h = hint.replace(/^(Run|Try):\s*/i, "");
    const hl = wrapText(h, w - 5);
    process.stderr.write(`    ${c.dim("Try:")} ${hl[0]}\n`);
    for (const l of hl.slice(1)) process.stderr.write(`         ${l}\n`);
  }
}

/** Older name. */
export function errorLine(s: string): void {
  errorBlock(s);
}

// ─── prompts ──────────────────────────────────────────────────────────

export const isInteractive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

const q = (s: string) => `  ${c.rose(sym().prompt)} ${s}`;

export async function confirm(question: string, def = false): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  for (;;) {
    const a = (await ask(`${q(question)} ${c.dim(`(${hint})`)} `)).trim().toLowerCase();
    if (!a) return def;
    if (["y", "yes"].includes(a)) return true;
    if (["n", "no"].includes(a)) return false;
  }
}

export async function text(question: string, def = ""): Promise<string> {
  const a = (await ask(`${q(question)}${def ? ` ${c.dim(`(${def})`)}` : ""} `)).trim();
  return a || def;
}

export async function choice(question: string, options: string[], def: string): Promise<string> {
  for (;;) {
    const a = (await ask(`${q(question)} ${c.dim(`[${options.join("/")}]`)} `)).trim().toLowerCase();
    if (!a) return def;
    if (options.includes(a)) return a;
  }
}

/** Reads a line without echoing it. */
export function secret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(`${q(question)} `).then((s) => s.trim());
  process.stdout.write(`${q(question)} `);
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stdout.write(term().unicode ? "•" : "*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ─── small helpers kept for older call sites ──────────────────────────

export { inSec as inSeconds };
export const fmtAgo = ago;
export const fmtSol = sol;
export const fmtShort = short;
