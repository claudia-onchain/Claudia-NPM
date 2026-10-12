// Content rules that run inside preview() and publish(). They are not optional.
//  - AI label per network (native flag where the network has one, account-level warning, or a text disclosure)
//  - "Not financial advice." when the text talks about a coin, a $TICKER or a price
//  - price / return promises are blocked with a reason
//  - "#ad" when labels.ad
// History rules (daily caps, near-duplicates, link frequency) live in social.ts because they need the post log.
import type { NetworkId } from "./types.js";
import { sha256Hex } from "./util.js";

export type AiLabelMode =
  /** The network has a per-post flag (YouTube containsSyntheticMedia, TikTok is_aigc, X made_with_ai). */
  | "native"
  /** The label is a setting on the account (Mastodon bot flag). Warn, and fall back to text when it is off. */
  | "account"
  /** No label exists: add a short text disclosure. */
  | "text";

export interface LabelPolicy {
  ai: AiLabelMode;
  /** What the native label is called, for labelsAdded. */
  aiName?: string;
  /** Extra warning to show (e.g. X's account-level "Automated" label). */
  aiWarning?: string;
  /** Native paid-partnership flag name, else "#ad" goes into the text. */
  adNative?: string;
}

const CASHTAG = /(^|[^\w$])\$[A-Za-z][A-Za-z0-9_]{1,11}\b/;
const DOLLAR_PRICE = /\$\s?\d[\d,]*(\.\d+)?\s?(k|m|b|bn|mil|million|billion)?\b/i;
const FINANCE_WORDS =
  /\b(coins?|tokens?|memecoins?|meme ?coins?|crypto|cryptocurrency|airdrops?|presale|pre-sale|market ?cap|mcap|fdv|price|prices|pump(ing|ed|s)?|dump(ing|ed|s)?|bonding curve|liquidity|degens?|trading|traders?|hodl|solana|sol|bitcoin|btc|eth|ethereum|pump\.fun|contract address|ca:|holders|ape(d|ing)?|rug(ged|pull)?|staking|yield|apy|apr|roi|profits?|gains)\b/i;
const SOL_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/;

/** True when the text talks about a coin, a ticker or a price (so it needs "Not financial advice."). */
export function mentionsFinance(text: string): boolean {
  return CASHTAG.test(text) || DOLLAR_PRICE.test(text) || FINANCE_WORDS.test(text) || SOL_ADDRESS.test(text) || EVM_ADDRESS.test(text);
}

const ALWAYS_BLOCK: { re: RegExp; why: string }[] = [
  { re: /\b\d{3,}\s?x\b/i, why: "promises a 100x-style return" },
  { re: /\bguarantee(d|s)?\s+(\w+\s+){0,3}(profits?|returns?|gains?|money|income|pumps?|moon|\d+\s?x|\d+\s?%)/i, why: "promises guaranteed returns" },
  { re: /\b(can('|’)?t|cannot|can not|won('|’)?t)\s+lose\b|\bno[- ]lose\b|\bimpossible to lose\b/i, why: "says it can't lose" },
  { re: /\b(risk[- ]free|zero[- ]risk|no[- ]risk)\b/i, why: "says there is no risk" },
  { re: /\bto the moon by\b/i, why: "predicts a price move by a date" },
  { re: /\b(moon(ing)?|pump(ing)?|100x|10x)\s+(by|before)\s+(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|the weekend|eow|eod|eom|end of (the )?(day|week|month|year)|\d)/i, why: "predicts a price move by a date" },
  { re: /\b(easy|free|fast|quick)\s+money\b|\bget rich\b|\bfinancial freedom\b/i, why: "promises easy money" },
  { re: /\b(will|gonna|going to|about to)\s+(definitely\s+)?(hit|reach|touch|be worth|flip|go to)\s+\$?\d/i, why: "promises a price target" },
];

const FINANCE_BLOCK: { re: RegExp; why: string }[] = [
  { re: /\b\d{2,}\s?x\b/i, why: "promises a 10x-style return" },
  { re: /\bguarantee(d|s)?\b/i, why: "uses \"guaranteed\" about a coin" },
  { re: /\b(will|gonna|going to|is about to|about to)\s+(definitely\s+)?(pump|moon|double|triple|explode|skyrocket|rip|send|fly|go parabolic)\b/i, why: "promises the price will go up" },
  { re: /\b\d+(\.\d+)?\s?%\s*(daily|weekly|monthly|a day|a week|a month|per day|per week|per month|guaranteed|returns?|profits?)\b/i, why: "promises a percentage return" },
  { re: /\bpassive income\b/i, why: "promises passive income" },
];

/** Returns a reason when the text promises prices or returns; undefined when it is fine. */
export function promiseBlock(text: string): string | undefined {
  for (const r of ALWAYS_BLOCK) {
    const m = r.re.exec(text);
    if (m) return `Blocked: the post ${r.why} ("${m[0].trim()}"). Claudia never promises prices or returns.`;
  }
  if (mentionsFinance(text)) {
    for (const r of FINANCE_BLOCK) {
      const m = r.re.exec(text);
      if (m) return `Blocked: the post ${r.why} ("${m[0].trim()}"). Claudia never promises prices or returns.`;
    }
  }
  return undefined;
}

const NFA_PRESENT = /\bnot financial advice\b|\bnfa\b|\bnot investment advice\b/i;
const AD_PRESENT = /(^|\s)#(ad|sponsored|paidpartnership)\b/i;

export interface RuleInput {
  text: string;
  thread?: string[];
  labels?: { ai?: boolean; ad?: boolean; nfa?: boolean };
  /** Mastodon: whether the account's bot flag is on. */
  accountFlagOn?: boolean;
}

export interface RuleOutput {
  text: string;
  thread: string[];
  labelsAdded: string[];
  warnings: string[];
  blocked?: string;
  /** Flags the connector must send natively. */
  flags: { ai: boolean; ad: boolean };
}

export interface RuleTexts {
  disclosure: string;
  nfa: string;
}

export const DEFAULT_TEXTS: RuleTexts = { disclosure: "(AI-generated)", nfa: "Not financial advice." };

export function applyContentRules(input: RuleInput, policy: LabelPolicy, texts: RuleTexts = DEFAULT_TEXTS): RuleOutput {
  const labels = { ai: input.labels?.ai !== false, ad: !!input.labels?.ad, nfa: input.labels?.nfa };
  const all = [input.text, ...(input.thread ?? [])].join("\n");
  const out: RuleOutput = { text: input.text, thread: [...(input.thread ?? [])], labelsAdded: [], warnings: [], flags: { ai: false, ad: false } };
  out.blocked = promiseBlock(all);

  const suffix: string[] = [];
  if (labels.ad) {
    if (policy.adNative) {
      out.flags.ad = true;
      out.labelsAdded.push(policy.adNative);
    }
    if (!AD_PRESENT.test(all)) {
      suffix.push("#ad");
      out.labelsAdded.push("#ad");
    }
  }
  if (labels.ai) {
    if (policy.ai === "native") {
      out.flags.ai = true;
      out.labelsAdded.push(policy.aiName ?? "AI label");
    } else if (policy.ai === "account" && input.accountFlagOn) {
      out.labelsAdded.push(policy.aiName ?? "bot account flag");
    } else {
      if (policy.ai === "account") out.warnings.push(`The account's ${policy.aiName ?? "bot flag"} is off, so a text disclosure was added. Turn the flag on to drop it.`);
      if (!all.includes(texts.disclosure)) {
        suffix.push(texts.disclosure);
        out.labelsAdded.push(`text: ${texts.disclosure}`);
      }
    }
    if (policy.aiWarning) out.warnings.push(policy.aiWarning);
  } else {
    out.warnings.push("AI label is off for this post. Only do this when a person wrote it.");
  }
  const finance = mentionsFinance(all);
  if (finance || labels.nfa) {
    if (labels.nfa === false && finance) out.warnings.push("labels.nfa=false was ignored: the post talks about a coin or price.");
    if (!NFA_PRESENT.test(all)) {
      suffix.push(texts.nfa);
      out.labelsAdded.push(texts.nfa);
    }
  }
  if (suffix.length) out.text = `${out.text.trimEnd()}\n\n${suffix.join(" ")}`;
  return out;
}

/** Normalized text hash for near-duplicate checks: case, URLs, punctuation, emoji, whitespace and our own labels ignored. */
export function normalizedHash(text: string, texts: RuleTexts = DEFAULT_TEXTS): string {
  const t = text
    .toLowerCase()
    .split(texts.nfa.toLowerCase())
    .join(" ")
    .split(texts.disclosure.toLowerCase())
    .join(" ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#ad\b/g, " ")
    .replace(/[^\p{L}\p{N}$]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sha256Hex(t);
}

// ---------- character counting ----------

const URL_RE = /https?:\/\/[^\s]+/g;

/** X weighted count: URLs 23, most Latin 1, CJK/emoji 2 (https://docs.x.com/fundamentals/counting-characters). */
export function countX(text: string): number {
  let n = 0;
  const withoutUrls = text.normalize("NFC").replace(URL_RE, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    const light = (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

let segmenter: Intl.Segmenter | null = null;
export function countGraphemes(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export function countBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Mastodon: URLs count as 23 regardless of length. */
export function countMastodon(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return "";
  });
  return n + Array.from(rest).length;
}

export type Counter = "x" | "graphemes" | "bytes" | "mastodon" | "utf16" | "codepoints";

export function countChars(text: string, how: Counter): number {
  switch (how) {
    case "x":
      return countX(text);
    case "graphemes":
      return countGraphemes(text);
    case "bytes":
      return countBytes(text);
    case "mastodon":
      return countMastodon(text);
    case "utf16":
      return text.length;
    default:
      return Array.from(text).length;
  }
}

/** Default daily caps per account (published posts in 24 h). Conservative on purpose. */
export const DEFAULT_CAPS: Record<NetworkId, number> = {
  x: 10,
  telegram: 50,
  discord: 50,
  bluesky: 30,
  mastodon: 30,
  farcaster: 20,
  nostr: 30,
  linkedin: 5,
  youtube: 5,
  buffer: 10,
  zernio: 10,
  "upload-post": 10,
  instagram: 20,
  facebook: 10,
  threads: 25,
  tiktok: 5,
  pinterest: 10,
};

export const DEFAULT_LINKS_PER_DAY: Partial<Record<NetworkId | "default", number>> = { default: 5, x: 3, linkedin: 3 };
