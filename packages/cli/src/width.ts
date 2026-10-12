// Visible width of terminal strings (ANSI codes are zero-width, East Asian wide characters and emoji are two
// columns, combining marks are zero) plus ANSI-safe truncate / pad / wrap. Small on purpose — no dependency.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");

// [start, end] code point ranges that take two columns (East Asian Wide/Fullwidth + emoji presentation).
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

function isZero(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space / joiners / marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    cp === 0x2060 ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0)
  );
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (isZero(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Columns a string takes on screen. */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Splits into [ansi | visible char] tokens. */
function tokens(s: string): { ansi: boolean; text: string }[] {
  const out: { ansi: boolean; text: string }[] = [];
  let last = 0;
  for (const m of s.matchAll(ANSI)) {
    const i = m.index ?? 0;
    for (const ch of s.slice(last, i)) out.push({ ansi: false, text: ch });
    out.push({ ansi: true, text: m[0] });
    last = i + m[0].length;
  }
  for (const ch of s.slice(last)) out.push({ ansi: false, text: ch });
  return out;
}

/** Cuts to `width` columns, ending with `ellipsis` when cut. Keeps colour codes balanced. */
export function truncate(s: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (strWidth(s) <= width) return s;
  const ew = strWidth(ellipsis);
  const room = Math.max(0, width - ew);
  let w = 0;
  let out = "";
  let sawAnsi = false;
  for (const t of tokens(s)) {
    if (t.ansi) {
      out += t.text;
      sawAnsi = true;
      continue;
    }
    const cw = charWidth(t.text);
    if (w + cw > room) break;
    out += t.text;
    w += cw;
  }
  return out + (sawAnsi ? "\u001b[0m" : "") + (ew <= width ? ellipsis : "");
}

/** Keeps the start and end: "7xKXtg2C…AsU". */
export function middle(s: string, width: number, ellipsis = "…"): string {
  if (strWidth(s) <= width) return s;
  const plain = stripAnsi(s);
  const keep = Math.max(1, width - strWidth(ellipsis));
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return plain.slice(0, head) + ellipsis + (tail ? plain.slice(-tail) : "");
}

export function padEnd(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

export function center(s: string, width: number): string {
  const w = strWidth(s);
  if (w >= width) return s;
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + s + " ".repeat(width - w - left);
}

/** Word-wraps to `width` columns (words longer than a line are hard-split). Colour codes stay with their words. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const w = Math.max(8, width);
  for (const rawPara of text.split("\n")) {
    // Keep a line's own indentation (JSON bodies, code); continuation lines get it too.
    const lead = /^ */.exec(stripAnsi(rawPara))?.[0] ?? "";
    const para = rawPara.slice(rawPara.indexOf(lead) + lead.length);
    let line = lead;
    let lw = lead.length;
    const base = lead.length;
    for (const word of para.split(/ +/)) {
      if (!word) continue;
      let ww = strWidth(word);
      let rest = word;
      while (ww > w - base) {
        if (lw > base) lines.push(line), (line = lead), (lw = base);
        const cut = truncate(rest, w - base, "");
        lines.push(lead + cut);
        rest = stripAnsi(rest).slice(stripAnsi(cut).length);
        ww = strWidth(rest);
      }
      if (!rest) continue;
      if (lw > base && lw + 1 + ww > w) {
        lines.push(line);
        line = lead + rest;
        lw = base + ww;
      } else {
        line = lw > base ? `${line} ${rest}` : line + rest;
        lw = lw > base ? lw + 1 + ww : lw + ww;
      }
    }
    lines.push(line);
  }
  return lines;
}
