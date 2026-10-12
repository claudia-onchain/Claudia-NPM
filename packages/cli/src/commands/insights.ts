// insights · holders · feed — coin and wallet insights from useclaudia.xyz (cache-first GMGN data + Claudia's own).
import { toTokenKey, type DevReport, type FeedSignal, type FeedTrade, type HolderRow, type Score, type ScoresReport, type TokenInsights, type TokenSnapshot } from "@useclaudia/sdk";
import { bool, numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import {
  age,
  ago,
  c,
  compact,
  delta,
  grade,
  info,
  int,
  kvBlock,
  log,
  padEnd,
  pctText,
  phaseLabel,
  pnl,
  scoreBar,
  section,
  short,
  sym,
  table,
  tagLabels,
  tagLegend,
  title,
  usd,
  warn,
  withSpinner,
  wrapText,
  wrap,
  type Column,
} from "../ui.js";
import { term } from "../term.js";

const plural = (n: number | null | undefined, w: string) => `${int(n)} ${w}${n === 1 ? "" : "s"}`;
const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/** "updated 2m ago · from GMGN · partial: GMGN rate limited" */
function freshness(updatedAt: number | null | undefined, source?: string, partial?: string | null): string {
  const bits = [updatedAt ? `updated ${ago(updatedAt)}` : "", source ? `from ${source === "gmgn" ? "GMGN" : source === "claudia" ? "Claudia" : source}` : ""].filter(Boolean);
  return bits.join(` ${sym().dot} `) + (partial ? ` ${sym().dot} ${partial}` : "");
}

/** A share 0–1 coloured by how worrying it is (higher = worse). */
function share(v: number | null | undefined, warnAt: number, badAt: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return c.dim("—");
  const s = pctText(v, { ratio: true });
  return v >= badAt ? c.sell(s) : v >= warnAt ? c.warn(s) : c.buy(s);
}

const yes = (v: boolean | null | undefined, good: boolean) => {
  const S = sym();
  if (v === null || v === undefined) return c.dim("unknown");
  return v === good ? c.buy(`${S.ok} ${v ? "yes" : "no"}`) : c.sell(`${S.fail} ${v ? "yes" : "no"}`);
};

function printScore(label: string, s: Score | null | undefined, extra?: string) {
  if (!s) return;
  const w = term().width;
  const bar = scoreBar(s.grade === "unknown" ? null : s.value, s.grade, w < 70 ? 8 : 12);
  log(`  ${c.bold(label.padEnd(9))} ${bar}  ${grade(s.grade, s.title)}${extra ? c.dim(` ${sym().dot} ${extra}`) : ""}`);
  if (s.summary) log(wrap(c.dim(s.summary), undefined, "            "));
  const reasons = [...(s.reasons ?? [])].filter((r) => r.points !== 0 && !/^starts at/i.test(r.label)).sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, term().width < 80 ? 2 : 4);
  for (const r of reasons) {
    const pts = `${r.points > 0 ? "+" : ""}${Math.round(r.points * 10) / 10}`;
    const lines = wrapText(r.label, Math.max(20, term().width - 22));
    log(`          ${(r.points > 0 ? c.buy : c.sell)(pts.padStart(6))}  ${lines[0]}`);
    for (const l of lines.slice(1)) log(`                  ${l}`);
  }
}

// ─── insights ─────────────────────────────────────────────────────────

export async function insights(ctx: Ctx) {
  const raw = ctx.args[0];
  if (!raw) throw new UsageError("Usage: claudia insights <mint | sol:<mint> | claudia>");
  const key = toTokenKey(raw, ctx.chain(raw));
  const api = ctx.publicClient().insights;
  const [ti, sc, dv] = await withSpinner(`Reading ${short(key.slice(4), 6)}…`, () => Promise.allSettled([api.token(key), api.scores(key), api.dev(key)]));
  const t = settled(ti);
  const scores = settled(sc);
  const dev = settled(dv);
  const allUnknown = !scores || [scores.safety, scores.holders, scores.chart].every((x) => !x || x.grade === "unknown");
  if (!t && allUnknown) throw new CliError(EXIT.ERROR, "not_found", `No data for ${short(key.slice(4), 6)} yet.`, "Check the mint, or try again in a minute (new coins take a moment to index).", { status: 404 });
  if (!ctx.json) renderInsights(key, t, scores, dev);
  return { key, insights: t, scores, dev };
}

export function renderInsights(key: string, t: TokenInsights | null, scores: ScoresReport | null, dev: DevReport | null) {
  const S = sym();
  const s = t?.stats;
  title(t?.symbol ? `$${t.symbol}` : short(key.slice(4), 6), [t?.name, short(key.slice(4), 5)].filter(Boolean).join(` ${S.dot} `));
  if (t && s) {
    const curve = s.migrated ? c.buy("migrated") : s.bondingPct !== null && s.bondingPct !== undefined ? `${phaseLabel("new", s.bondingPct)} ${c.dim("curve")}` : null;
    kvBlock([
      ["Price", [c.bold(usd(s.priceUsd)), `${c.dim("mcap")} ${c.bold(usd(s.mcapUsd))}`, `${c.dim("liquidity")} ${usd(s.liquidityUsd)}`, s.athPriceUsd ? `${c.dim("ATH")} ${usd(s.athPriceUsd)}` : ""].filter(Boolean).join(c.dim(` ${S.dot} `))],
      ["Holders", [int(s.holders), s.counts?.kol ? c.kol(`${s.counts.kol} KOL`) : "", s.counts?.smart ? c.gold(`${s.counts.smart} smart`) : ""].filter(Boolean).join(c.dim(` ${S.dot} `))],
      ["Age", [age(s.createdAt), s.launchpad ?? "", curve ?? ""].filter(Boolean).join(c.dim(` ${S.dot} `))],
      t.socials && (t.socials.twitter || t.socials.telegram || t.socials.website)
        ? ["Links", [t.socials.twitter ? `X${t.socials.xFollowers ? ` (${compact(t.socials.xFollowers)})` : ""}` : "", t.socials.telegram ? "Telegram" : "", t.socials.website ? "website" : ""].filter(Boolean).join(c.dim(` ${S.dot} `))]
        : null,
    ]);

    const wins = (["5m", "1h", "6h", "24h"] as const).filter((k) => s.windows?.[k]);
    if (wins.length) {
      section("Activity");
      table(
        [
          { header: "Window", get: (k: string) => c.bold(k) },
          { header: "Change", get: (k) => delta(s.windows[k as "1h"]?.priceChangePct), align: "right" },
          { header: "Volume", get: (k) => usd(s.windows[k as "1h"]?.volumeUsd), align: "right" },
          { header: "Buys", get: (k) => c.buy(int(s.windows[k as "1h"]?.buys)), align: "right" },
          { header: "Sells", get: (k) => c.sell(int(s.windows[k as "1h"]?.sells)), align: "right" },
          { header: "Net flow", get: (k) => pnl((s.windows[k as "1h"]?.buyVolumeUsd ?? 0) - (s.windows[k as "1h"]?.sellVolumeUsd ?? 0) || null), align: "right", priority: 1 },
        ],
        wins,
        { stackBelow: 60 },
      );
    }

    section("Wallet mix");
    const mix: [string, string][] = [
      ["Top 10", share(s.top10Pct, 0.3, 0.5)],
      ["Dev", share(s.devHoldPct, 0.05, 0.15)],
      ["Snipers", share(s.snipersPct, 0.1, 0.25)],
      ["Bundlers", share(s.bundlersPct, 0.1, 0.25)],
      ["Insiders", share(s.insidersPct, 0.1, 0.25)],
      ["Fresh", share(s.freshPct, 0.2, 0.4)],
      ["Bots", share(s.botPct, 0.2, 0.4)],
    ];
    const per = term().width >= 100 ? 4 : term().width >= 70 ? 3 : 2;
    for (let i = 0; i < mix.length; i += per) log("  " + mix.slice(i, i + per).map(([k, v]) => `${c.dim(k.padEnd(9))}${padEnd(v, 8)}`).join("   "));
  }

  if (scores) {
    section("Scores", freshness(scores.updatedAt, undefined, null));
    printScore("Safety", scores.safety);
    printScore("Holders", scores.holders);
    printScore("Chart", scores.chart, scores.chart?.pattern && scores.chart.pattern !== "unknown" ? scores.chart.pattern : undefined);
    if (dev) printScore("Dev", dev.total);
  }

  const sec = t?.security;
  if (sec) {
    section("Security");
    kvBlock([
      ["Mint renounced", yes(sec.mintRenounced, true)],
      ["Freeze renounced", yes(sec.freezeRenounced, true)],
      ["Honeypot", yes(sec.honeypot, false)],
      sec.buyTaxPct || sec.sellTaxPct ? ["Tax", `buy ${pctText(sec.buyTaxPct)} ${S.dot} sell ${pctText(sec.sellTaxPct)}`] : null,
      sec.lpLocked !== null && sec.lpLocked !== undefined ? ["LP locked", yes(sec.lpLocked, true)] : null,
      sec.burnRatio ? ["Burned", pctText(sec.burnRatio, { ratio: true })] : null,
    ]);
    for (const w of sec.warnings ?? []) warn(w);
  }

  if (dev) {
    const d = dev.summary;
    section("Dev", short(d.address, 5));
    kvBlock([
      ["Track record", `${plural(d.launches, "coin")} ${S.dot} ${int(d.migrated)} graduated (${pctText(d.migratedRatio, { ratio: true })})${d.bestMcapUsd ? ` ${S.dot} best ${usd(d.bestMcapUsd)}` : ""}`],
      ["In this coin", `${d.holdsPct !== null && d.holdsPct !== undefined ? `holds ${pctText(d.holdsPct, { ratio: true })}` : "holding unknown"}${d.status && d.status !== "unknown" ? ` ${S.dot} ${d.status === "sold" ? c.warn("sold") : d.status}` : ""}`],
      d.rugRatio !== null && d.rugRatio !== undefined ? ["Rug ratio", share(d.rugRatio, 0.2, 0.5)] : null,
      ["Conduct", `${grade(dev.conduct.grade, dev.conduct.title)}${dev.conduct.grade !== "unknown" ? c.dim(` (${Math.round(dev.conduct.value)})`) : ""}`],
      ["Power", `${grade(dev.power.grade, dev.power.title)}${dev.power.grade !== "unknown" ? c.dim(` (${Math.round(dev.power.value)})`) : ""}`],
    ]);
  }

  if (t?.signals?.length) {
    section("Signals");
    for (const sig of [...t.signals].sort((a, b) => b.at - a.at).slice(0, 5)) log(`  ${c.dim(ago(sig.at).padEnd(9))} ${c.copper(sig.label)}${sig.mcapUsd ? c.dim(` at ${usd(sig.mcapUsd)}`) : ""}`);
  }

  log("");
  info(freshness(t?.updatedAt ?? scores?.updatedAt, t?.source, t?.partial ?? scores?.partial));
  info(`More: claudia holders ${short(key.slice(4), 4)} ${S.dot} claudia watch ${short(key.slice(4), 4)} ${S.dot} not financial advice`);
}

// ─── holders ──────────────────────────────────────────────────────────

export async function holders(ctx: Ctx) {
  const raw = ctx.args[0];
  if (!raw) throw new UsageError("Usage: claudia holders <mint> [--limit 30] [--tag kol] [--traders]");
  const key = toTokenKey(raw, ctx.chain(raw));
  const traders = bool(ctx.flags, "traders");
  const tag = str(ctx.flags, "tag");
  const want = Math.max(1, Math.min(100, numFlag(ctx.flags, "limit") ?? 30));
  const api = ctx.publicClient().insights;
  const r = await withSpinner(traders ? "Reading top traders…" : "Reading holders…", () => (traders ? api.traders(key, { limit: 100 }) : api.holders(key, { limit: tag ? 100 : Math.max(20, want) })));
  const rows = (tag ? r.data.filter((h) => h.tags.includes(tag as never)) : r.data).slice(0, want);
  if (!ctx.json) {
    title(traders ? "Top traders" : "Holders", short(key.slice(4), 5));
    renderHolders(rows, traders);
    log("");
    if (rows.length && term().width >= 80 && term().width < 100) {
      const legend = tagLegend(rows.flatMap((h) => h.tags));
      if (legend) log(`  ${legend}`);
    }
    info(freshness(r.updatedAt, r.source, r.partial));
  }
  // `data` matches the feeds (and the API); `holders` stays for 0.2 scripts.
  return { key, kind: traders ? "traders" : "holders", data: rows, holders: rows, updatedAt: r.updatedAt, source: r.source, partial: r.partial };
}

export function renderHolders(rows: HolderRow[], traders = false) {
  const narrow = term().width >= 80 && term().width < 100;
  const cols: Column<HolderRow>[] = [
    { header: "#", get: (h) => c.dim(String(h.rank)), align: "right", headline: true },
    { header: "Wallet", get: (h) => (h.name ? `${c.bold(h.name)} ${c.dim(short(h.address, 3))}` : short(h.address, 4)), min: 9, headline: true },
    { header: "Tags", get: (h) => tagLabels(h.tags, { compact: narrow, skip: ["top10"] }), min: 6, headline: true },
    { header: "Share", get: (h) => c.bold(pctText(h.pct, { ratio: true })), align: "right" },
    { header: "Value", get: (h) => usd(h.usdValue), align: "right" },
    { header: "P&L", get: (h) => (sumPnl(h) !== null ? pnl(sumPnl(h)) : h.pnlRatio !== null && h.pnlRatio !== undefined ? delta(h.pnlRatio, { ratio: true }) : c.dim("—")), align: "right", priority: 3 },
    { header: "Buys/Sells", get: (h) => (h.buys !== null && h.buys !== undefined ? `${c.buy(int(h.buys))}${c.dim("/")}${c.sell(int(h.sells))}` : c.dim("—")), align: "right", priority: traders ? 4 : 1 },
    { header: "Active", get: (h) => c.dim(h.lastActiveAt ? ago(h.lastActiveAt) : "—"), align: "right", priority: 2 },
  ];
  table(cols, rows, { empty: "No holder data yet for this coin." });
}

const sumPnl = (h: HolderRow) => (h.realizedPnlUsd === null || h.realizedPnlUsd === undefined) && (h.unrealizedPnlUsd === null || h.unrealizedPnlUsd === undefined) ? null : (h.realizedPnlUsd ?? 0) + (h.unrealizedPnlUsd ?? 0);

// ─── feed ─────────────────────────────────────────────────────────────

const FEEDS = ["kol", "smart", "signals", "trending", "hot"] as const;

export async function feed(ctx: Ctx) {
  const kind = (ctx.args[0] ?? "kol").toLowerCase();
  if (!(FEEDS as readonly string[]).includes(kind)) throw new UsageError(`Feeds: ${FEEDS.join(", ")} (e.g. claudia feed kol)`);
  const limit = Math.max(1, Math.min(100, numFlag(ctx.flags, "limit") ?? 25));
  const side = str(ctx.flags, "side") as "buy" | "sell" | undefined;
  if (side && side !== "buy" && side !== "sell") throw new UsageError("--side is buy or sell");
  const cl = ctx.publicClient();
  const chain = ctx.chain();
  if (chain === "bsc") await cl.assertChainOpen("bsc");
  const chainName = chain === "hood" ? "Robinhood Chain" : "Solana";
  const interval = str(ctx.flags, "interval") as never;
  const label = { kol: "KOL trades", smart: "Smart money", signals: "Signals", trending: "Trending", hot: "Hot" }[kind as (typeof FEEDS)[number]];
  const r = await withSpinner(`Loading ${label.toLowerCase()}…`, async () =>
    kind === "kol" ? cl.feeds.kol({ chain, side })
    : kind === "smart" ? cl.feeds.smart({ chain, side })
    : kind === "signals" ? cl.feeds.signals({ chain })
    : kind === "trending" ? cl.insights.trending({ chain, interval, order: str(ctx.flags, "order") as never })
    : cl.insights.hot({ chain, interval }),
  );
  const data = (r.data as unknown[]).slice(0, limit);
  if (!ctx.json) {
    title(label, kind === "trending" || kind === "hot" ? `${chainName} ${sym().dot} ${str(ctx.flags, "interval") ?? "1h"}` : chainName);
    if (kind === "kol" || kind === "smart") renderTrades(data as FeedTrade[]);
    else if (kind === "signals") renderSignals(data as FeedSignal[]);
    else renderBoard(data as TokenSnapshot[]);
    log("");
    info(freshness(r.updatedAt, "gmgn", r.partial));
  }
  return { feed: kind, chain, data, updatedAt: r.updatedAt, partial: r.partial };
}

const coinName = (symbol?: string | null, key?: string) => (symbol ? c.bold(`$${symbol}`) : c.dim(short(key?.split(":")[1], 4)));

export function renderTrades(rows: FeedTrade[]) {
  const narrow = term().width >= 80 && term().width < 100;
  table(
    [
      { header: "When", get: (t) => c.dim(ago(t.at)), headline: true },
      { header: "Side", get: (t) => (t.side === "buy" ? c.buy("buy") : c.sell("sell")), headline: true },
      { header: "Coin", get: (t) => coinName(t.symbol, t.tokenKey), headline: true, min: 6 },
      { header: "Amount", get: (t) => c.bold(usd(t.amountUsd)), align: "right" },
      { header: "Wallet", get: (t) => (t.wallet.name ? t.wallet.name : short(t.wallet.address, 4)), min: 8 },
      { header: "Tags", get: (t) => tagLabels(t.wallet.tags, { compact: narrow, max: 3 }), priority: 2 },
      { header: "Price", get: (t) => usd(t.priceUsd), align: "right", priority: 1 },
    ],
    rows,
    { empty: "Nothing in this feed right now." },
  );
}

export function renderSignals(rows: FeedSignal[]) {
  table(
    [
      { header: "When", get: (s) => c.dim(ago(s.at)), headline: true },
      { header: "Coin", get: (s) => coinName(s.symbol, s.tokenKey), headline: true, min: 6 },
      { header: "Signal", get: (s) => c.copper(s.label), headline: true, min: 10 },
      { header: "Mcap", get: (s) => usd(s.mcapUsd), align: "right" },
      { header: "Detail", get: (s) => c.dim(s.detail ?? ""), priority: 1 },
    ],
    rows,
    { empty: "No signals right now." },
  );
}

export function renderBoard(rows: TokenSnapshot[]) {
  table(
    [
      { header: "#", get: (_t, i) => c.dim(String(i + 1)), align: "right", headline: true },
      { header: "Coin", get: (t) => `${c.bold("$" + t.symbol)} ${c.dim(t.name ?? "")}`, headline: true, min: 8, max: 30 },
      { header: "Mcap", get: (t) => c.bold(usd(t.mcapUsd)), align: "right" },
      { header: "1h", get: (t) => delta(t.change1hPct), align: "right" },
      { header: "Vol 1h", get: (t) => usd(t.volume1hUsd), align: "right" },
      { header: "Holders", get: (t) => int(t.holders), align: "right", priority: 2 },
      { header: "Age", get: (t) => c.dim(age(t.createdAt)), align: "right", priority: 1 },
      { header: "Phase", get: (t) => phaseLabel(t.phase, t.bondingPct), priority: 3 },
    ],
    rows,
    { empty: "Nothing here right now." },
  );
}
