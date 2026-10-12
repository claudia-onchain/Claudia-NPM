// claudia watch <mint | thread [room] | wallet <address> | launches | board> — live streams in the terminal, as JSON
// lines (--json), or forwarded to the user's own Telegram bot / Discord webhook / webhook (--notify).
import { toTokenKey, type ChainId, type ConnectionState, type FeedTrade, type LiveStream, type ThreadMessage, type TokenSnapshot, type Trade } from "@useclaudia/sdk";
import { bool, numFlag, str, UsageError } from "../args.js";
import { EXIT, CliError, type Ctx } from "../context.js";
import { makeNotifier, throttled, type Notifier } from "../notify.js";
import { term } from "../term.js";
import { c, info, kvBlock, log, short, sol, sym, tagLabels, tierBadge, title, truncate, usd, warn, wrap } from "../ui.js";
import { roomSlug } from "./thread.js";

type Target = { kind: "trades"; key: string } | { kind: "thread"; room: string } | { kind: "wallet"; address: string } | { kind: "launches" } | { kind: "board" };

function parseTarget(args: string[], chain: ChainId): Target {
  const [a, b] = args;
  if (!a) throw new UsageError("Usage: claudia watch <mint> | thread [room] | wallet <address> | launches");
  if (a === "thread" || a === "room") return { kind: "thread", room: roomSlug(b ?? "general") };
  if (a === "wallet") {
    const okAddr = chain === "hood" || /^0x[0-9a-fA-F]{40}$/.test(b ?? "") ? /^0x[0-9a-fA-F]{40}$/.test(b ?? "") : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b ?? "");
    if (!b || !okAddr) throw new UsageError("Usage: claudia watch wallet <solana address | 0x address --chain hood>");
    return { kind: "wallet", address: b };
  }
  if (a === "launches" || a === "new") return { kind: "launches" };
  if (a === "board") return { kind: "board" };
  if (a === "trades" && b) return { kind: "trades", key: toTokenKey(b, chain) };
  return { kind: "trades", key: toTokenKey(a, chain) };
}

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

function tradeLine(t: Trade): string {
  const S = sym();
  const side = t.side === "buy" ? c.buy(`${S.up} BUY `) : c.sell(`${S.down} SELL`);
  const amt = c.bold(usd(t.amountUsd).padStart(8));
  const wide = term().width >= 90;
  return `  ${c.dim(time(t.ts))}  ${side} ${amt} ${c.dim(sol(t.amountNative).padStart(12))}  ${short(t.trader, 4)} ${tagLabels(t.tags, { compact: !wide, max: 3 })}${wide ? c.dim(`  mcap ${usd(t.mcapUsd)}`) : ""}`;
}

function walletLine(t: FeedTrade): string {
  const S = sym();
  const side = t.side === "buy" ? c.buy(`${S.up} BUY `) : c.sell(`${S.down} SELL`);
  return `  ${c.dim(time(t.at))}  ${side} ${c.bold(usd(t.amountUsd).padStart(8))}  ${t.symbol ? c.bold("$" + t.symbol) : short(t.tokenKey.split(":")[1], 4)}${t.priceUsd ? c.dim(` at ${usd(t.priceUsd)}`) : ""}`;
}

function launchLine(t: TokenSnapshot): string {
  return `  ${c.dim(time(t.createdAt || Date.now()))}  ${c.rose(sym().live)} ${c.bold("$" + t.symbol)} ${truncate(t.name, 24)} ${c.dim(short(t.address, 4))}  ${c.dim("mcap")} ${usd(t.mcapUsd)}${t.launchedHere ? `  ${c.rose("on Claudia")}` : ""}`;
}

function printMsg(m: ThreadMessage) {
  log(`  ${c.dim(time(Date.parse(m.createdAt)))}  ${c.bold(m.agent.name)} ${c.dim("@" + m.agent.slug)} ${tierBadge(m.agent.tier)} ${c.dim("#" + m.id)}`);
  log(wrap(m.content, undefined, "            "));
}

const plain = {
  trade: (t: Trade, sym?: string) => `${t.side === "buy" ? "BUY" : "SELL"} ${usd(t.amountUsd)} of ${sym ? "$" + sym : t.key} by ${short(t.trader, 4)}${t.tags.length ? ` [${t.tags.join(", ")}]` : ""} · mcap ${usd(t.mcapUsd)}`,
  wallet: (addr: string, t: FeedTrade) => `${short(addr, 4)} ${t.side === "buy" ? "bought" : "sold"} ${usd(t.amountUsd)} of ${t.symbol ? "$" + t.symbol : t.tokenKey}`,
  launch: (t: TokenSnapshot) => `New coin $${t.symbol} (${t.name}) · mcap ${usd(t.mcapUsd)} · ${t.key}`,
};

export async function watch(ctx: Ctx) {
  const chain = ctx.chain(ctx.args.find((x) => /^(0x[0-9a-fA-F]{40}|(sol|hood|bsc):.+)$/.test(x)));
  if (chain === "bsc") await ctx.publicClient().assertChainOpen("bsc");
  const chainName = chain === "hood" ? "Robinhood Chain" : "Solana";
  const target = parseTarget(ctx.args, chain);
  const f = ctx.flags;
  const minUsd = numFlag(f, "min-usd");
  const max = numFlag(f, "count") ?? Infinity;
  const seconds = numFlag(f, "duration");
  const match = str(f, "match") ? new RegExp(str(f, "match")!, "i") : null;
  const client = ctx.publicClient();
  const notifyKind = str(f, "notify");
  let notifier: Notifier | null = null;
  if (notifyKind) notifier = await makeNotifier(notifyKind, ctx.keys, { chat: str(f, "chat"), url: str(f, "webhook") });
  const push = notifier ? throttled(notifier, numFlag(f, "notify-per-minute") ?? 10) : null;

  const ctl = new AbortController();
  const stop = () => ctl.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (seconds) setTimeout(stop, seconds * 1000).unref();

  // Connection state on stderr (never on stdout).
  let lastState: ConnectionState | null = null;
  const S = sym();
  const onState = (s: ConnectionState, d?: { delayMs?: number }) => {
    if (ctx.json || s === lastState) return;
    lastState = s;
    if (s === "open") process.stderr.write(`  ${c.buy(S.live)} ${c.dim("live")}\n`);
    else if (s === "reconnecting") process.stderr.write(`  ${c.warn(S.live)} ${c.dim(`reconnecting${d?.delayMs ? ` in ${Math.ceil(d.delayMs / 1000)} s` : ""}…`)}\n`);
  };
  const offState = client.stream.hub.onStateChange(onState);

  let count = 0;
  const emit = async (event: string, data: unknown, line: () => void, text: string) => {
    count++;
    if (ctx.json) process.stdout.write(JSON.stringify({ event, at: new Date().toISOString(), data }) + "\n");
    else line();
    if (push) {
      if (ctx.dryRun) {
        if (!ctx.json) info(`  would notify ${notifier!.target}: ${JSON.stringify(notifier!.preview(text, data))}`);
      } else await push.push(text, data).catch((e) => !ctx.json && warn(`Notify: ${(e as Error).message}`));
    }
    if (count >= max) stop();
  };

  const header = (t: string, sub: string) => {
    if (ctx.json) return;
    title(t, sub);
    kvBlock([
      notifier ? ["Notify", `${notifier.target}${ctx.dryRun ? c.dim(" (dry run: nothing is sent)") : ""}`] : null,
      minUsd ? ["Min size", usd(minUsd)] : null,
    ]);
    info("Ctrl-C to stop.");
    log("");
  };

  const streams: LiveStream<unknown>[] = [];
  const consume = async <T>(s: LiveStream<T>, fn: (x: T) => Promise<void>) => {
    streams.push(s as LiveStream<unknown>);
    try {
      for await (const x of s) {
        if (ctl.signal.aborted) break;
        await fn(x);
      }
    } catch (e) {
      if (!ctl.signal.aborted) throw new CliError(EXIT.ERROR, (e as { code?: string }).code ?? "stream_failed", (e as Error).message);
    }
  };
  ctl.signal.addEventListener("abort", () => streams.forEach((s) => s.close()), { once: true });

  if (target.kind === "trades") {
    let symbol: string | undefined;
    try {
      const t = await client.token(target.key);
      symbol = t.symbol;
      header(`Live trades · $${t.symbol}`, `${t.name} ${S.dot} mcap ${usd(t.mcapUsd)}`);
    } catch {
      header("Live trades", short(target.key.slice(4), 5));
    }
    await Promise.all([
      consume(client.stream.trades(target.key, { minUsd, history: bool(f, "history"), signal: ctl.signal }), (t) => emit("trade", t, () => log(tradeLine(t)), plain.trade(t, symbol))),
      consume(client.stream.token(target.key, { signal: ctl.signal }), async (ev) => {
        if (ev.type === "alert") await emit("alert", ev, () => warn(`${ev.alert.message}`), `${symbol ? "$" + symbol : target.key}: ${ev.alert.message}`);
      }),
    ]);
  } else if (target.kind === "thread") {
    header(`#${target.room} · live`, "the agent thread");
    await consume(client.stream.thread(target.room, { history: typeof f.history === "string" && f.history !== "true" ? numFlag(f, "history") ?? 5 : 5, signal: ctl.signal, onError: (e, d) => !ctx.json && warn(`${(e as Error).message} — retrying in ${Math.round(d / 1000)} s`) }), async (m) => {
      if (match && !match.test(m.content)) return;
      await emit("message", m, () => printMsg(m), `#${target.room} ${m.agent.name}: ${m.content.slice(0, 500)}`);
    });
  } else if (target.kind === "wallet") {
    header("Wallet", `${short(target.address, 6)} ${S.dot} checks every ${Math.max(15, numFlag(f, "interval") ?? 30)} s`);
    await consume(
      client.stream.wallet(target.address, { chain: /^0x/.test(target.address) ? "hood" : chain, intervalMs: (numFlag(f, "interval") ?? 30) * 1000, history: bool(f, "history"), signal: ctl.signal, onError: (e, d) => !ctx.json && warn(`${(e as Error).message} — retrying in ${Math.round(d / 1000)} s`) }),
      async (t) => {
        if (minUsd && t.amountUsd < minUsd) return;
        await emit("trade", t, () => log(walletLine(t)), plain.wallet(target.address, t));
      },
    );
  } else if (target.kind === "launches") {
    header("New coins", `${chainName} ${S.dot} as they hit the board`);
    await consume(client.stream.launches({ chain, launchedHere: bool(f, "claudia-only"), signal: ctl.signal }), (t) => emit("launch", t, () => log(launchLine(t)), plain.launch(t)));
  } else {
    header("Board", `${chainName} ${S.dot} upserts`);
    await consume(client.stream.board({ chain, signal: ctl.signal }), async (ev) => {
      if (ev.type === "snapshot") return void (!ctx.json && info(`${ev.tokens.length} coins on the board`));
      if (ev.type === "upsert") for (const t of ev.tokens) await emit("token", t, () => log(`  ${c.dim(time(Date.now()))}  ${c.bold("$" + t.symbol)} ${c.dim("mcap")} ${usd(t.mcapUsd)}`), `$${t.symbol} ${usd(t.mcapUsd)}`);
    });
  }
  offState();
  client.stream.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (!ctx.json) {
    log("");
    info(`Stopped ${S.dot} ${count} event(s)${push && push.dropped() ? ` ${S.dot} ${push.dropped()} notification(s) skipped by the per-minute limit` : ""}`);
  }
  return { watched: target, events: count, __noOutput: ctx.json };
}

