// Live streams as async iterators. One WebSocket per client (the website's realtime hub at /ws), shared by every
// stream, with auto-reconnect (exponential backoff + jitter), resubscribe after reconnect, an app-level ping to spot
// dead connections, and de-duplication of the snapshot the hub re-sends on every subscribe.
//
// Hub topics (server/hub.ts): "board:<chain>", "token:<key>", "trades:<key>", "status". The thread and wallets have no
// hub topic, so `thread()` and `wallet()` poll the HTTP API instead (same iterator interface).
//
// Runs in browsers and Node 18+: uses the global WebSocket when there is one (browsers, Node 22+), else the optional
// `ws` package (npm i ws), else the `WebSocket` constructor you pass in the client options.
import { ClaudiaApiError, ClaudiaConfigError } from "./errors.js";
import type { HttpCore } from "./http.js";
import type { FeedTrade, WalletReport } from "./insights-types.js";
import { toTokenKey } from "./token-key.js";
import type { ChainId, MessageQuery, Page, ThreadMessage, TokenAlert, TokenSnapshot, Trade } from "./types.js";

// ─── types ────────────────────────────────────────────────────────────

export interface ChainStatus {
  chain: ChainId;
  source: "live" | "simulated" | "offline";
  latencyMs: number;
  lastBlock: number;
  lastEventAt: number;
  gas?: string;
  nativeUsd: number;
}

/** Raw hub messages (DexPumpzip/shared/types.ts `ServerMsg`). */
export type HubMessage =
  | { t: "hello"; serverTime: number; version: string }
  | { t: "pong"; ts: number; serverTime: number }
  | { t: "board"; chain: ChainId; tokens: TokenSnapshot[] }
  | { t: "token"; token: TokenSnapshot }
  | { t: "tokens"; tokens: TokenSnapshot[] }
  | { t: "remove"; keys: string[] }
  | { t: "trade"; trade: Trade }
  | { t: "trades"; trades: Trade[] }
  | { t: "status"; chains: ChainStatus[] }
  | { t: "alert"; key: string; alert: TokenAlert };

export type BoardEvent =
  | { type: "snapshot"; chain: ChainId; tokens: TokenSnapshot[] }
  | { type: "upsert"; tokens: TokenSnapshot[] }
  | { type: "remove"; keys: string[] }
  | { type: "alert"; key: string; alert: TokenAlert };

export type TokenEvent = { type: "token"; token: TokenSnapshot } | { type: "alert"; key: string; alert: TokenAlert };

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** An async iterator you can also stop from outside (`close()`), e.g. on Ctrl-C. `for await` ends when it's closed. */
export interface LiveStream<T> extends AsyncIterableIterator<T> {
  close(): void;
  readonly closed: boolean;
}

export interface StreamCommonOptions {
  signal?: AbortSignal;
  /** Max buffered events before the oldest are dropped (slow consumer). Default 1000. */
  buffer?: number;
}

/** Anything shaped like the browser WebSocket. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface HubOptions {
  /** ws(s)://…/ws. Default: the client's base URL with http→ws. */
  url?: string;
  WebSocket?: WebSocketCtor;
  /** First reconnect delay (default 500 ms), doubling up to `maxBackoffMs` (default 30 s), with jitter. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called on every state change (and with the error that caused a reconnect). */
  onState?: (state: ConnectionState, detail?: { attempt: number; delayMs?: number; error?: unknown }) => void;
}

// ─── a tiny bounded async queue ───────────────────────────────────────

class Channel<T> implements LiveStream<T> {
  private items: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private done = false;
  private error: unknown = undefined;
  private onClose: (() => void)[] = [];

  constructor(private readonly max = 1000, signal?: AbortSignal) {
    if (signal) {
      if (signal.aborted) this.close();
      else signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  get closed(): boolean {
    return this.done;
  }

  whenClosed(fn: () => void): void {
    if (this.done) fn();
    else this.onClose.push(fn);
  }

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) return w.resolve({ value: item, done: false });
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  fail(e: unknown): void {
    if (this.done) return;
    this.error = e;
    this.finish();
  }

  close(): void {
    if (!this.done) this.finish();
  }

  private finish(): void {
    this.done = true;
    for (const fn of this.onClose.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    for (const w of this.waiters.splice(0)) {
      if (this.error !== undefined && !this.items.length) w.reject(this.error);
      else w.resolve({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.done) {
      if (this.error !== undefined) {
        const e = this.error;
        this.error = undefined;
        return Promise.reject(e);
      }
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

// ─── the shared hub connection ────────────────────────────────────────

type Listener = (m: HubMessage) => void;

const OPEN = 1;
const PING_EVERY_MS = 25_000;
const DEAD_AFTER_MS = 75_000;
const IDLE_CLOSE_MS = 2_000;

async function resolveWebSocket(given?: WebSocketCtor): Promise<WebSocketCtor> {
  if (given) return given;
  const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (g) return g;
  try {
    const name = "ws"; // optional peer dependency — not bundled
    const mod = (await import(/* @vite-ignore */ name)) as { default?: WebSocketCtor; WebSocket?: WebSocketCtor };
    const ctor = mod.WebSocket ?? mod.default;
    if (ctor) return ctor;
  } catch {
    /* fall through */
  }
  throw new ClaudiaConfigError("no_websocket", "Live streams need a WebSocket: use Node 22+, install the `ws` package (npm i ws), or pass `WebSocket` in the client options.");
}

export class Hub {
  readonly url: string;
  private readonly opts: HubOptions;
  private ws: WebSocketLike | null = null;
  private topics = new Map<string, number>(); // topic → refcount
  private listeners = new Set<Listener>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = 0;
  private connecting = false;
  private stopped = false;
  state: ConnectionState = "closed";
  /** Hub version and clock from the last `hello`. */
  server?: { version: string; serverTime: number; skewMs: number };

  constructor(baseUrl: string, opts: HubOptions = {}) {
    this.opts = opts;
    this.url = opts.url ?? `${baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "")}/ws`;
  }

  /** Adds a listener and subscribes topics (ref-counted). Returns an unsubscribe function. */
  subscribe(topics: string[], listener: Listener): () => void {
    this.stopped = false;
    if (this.idleTimer) clearTimeout(this.idleTimer), (this.idleTimer = null);
    this.listeners.add(listener);
    const fresh: string[] = [];
    for (const t of topics) {
      const n = this.topics.get(t) ?? 0;
      this.topics.set(t, n + 1);
      if (n === 0) fresh.push(t);
    }
    if (this.ws && this.ws.readyState === OPEN) {
      if (fresh.length) this.send({ t: "sub", topics: fresh });
    } else void this.connect();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(listener);
      const gone: string[] = [];
      for (const t of topics) {
        const n = (this.topics.get(t) ?? 1) - 1;
        if (n <= 0) {
          this.topics.delete(t);
          gone.push(t);
        } else this.topics.set(t, n);
      }
      if (gone.length && this.ws && this.ws.readyState === OPEN) this.send({ t: "unsub", topics: gone });
      if (!this.topics.size) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    };
  }

  /** Closes the socket and stops reconnecting (streams stay open but get nothing until a new subscribe). */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer), (this.reconnectTimer = null);
    if (this.pingTimer) clearInterval(this.pingTimer), (this.pingTimer = null);
    if (this.idleTimer) clearTimeout(this.idleTimer), (this.idleTimer = null);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try {
        ws.close(1000, "bye");
      } catch {
        /* ignore */
      }
    }
    this.setState("closed");
  }

  private stateListeners = new Set<NonNullable<HubOptions["onState"]>>();

  /** Listen to connection state changes (in addition to `onState`). Returns an unsubscribe function. */
  onStateChange(cb: NonNullable<HubOptions["onState"]>): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private setState(s: ConnectionState, detail?: { delayMs?: number; error?: unknown }) {
    this.state = s;
    const d = { attempt: this.attempt, ...detail };
    this.opts.onState?.(s, d);
    for (const cb of [...this.stateListeners]) cb(s, d);
  }

  private send(m: unknown) {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch {
      /* the close handler reconnects */
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped || (this.ws && this.ws.readyState <= OPEN)) return;
    this.connecting = true;
    this.setState(this.attempt ? "reconnecting" : "connecting");
    let Ctor: WebSocketCtor;
    try {
      Ctor = await resolveWebSocket(this.opts.WebSocket);
    } catch (e) {
      this.connecting = false;
      for (const l of [...this.listeners]) (l as Listener & { fail?: (e: unknown) => void }).fail?.(e);
      this.setState("closed", { error: e });
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new Ctor(this.url);
    } catch (e) {
      this.connecting = false;
      this.scheduleReconnect(e);
      return;
    }
    this.ws = ws;
    this.connecting = false;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.setState("open");
      if (this.topics.size) this.send({ t: "sub", topics: [...this.topics.keys()] });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
          try {
            ws.close(4000, "no traffic");
          } catch {
            /* ignore */
          }
          this.onDrop(ws, new Error("connection went quiet"));
          return;
        }
        this.send({ t: "ping", ts: Date.now() });
      }, PING_EVERY_MS);
      (this.pingTimer as { unref?: () => void }).unref?.();
    };
    ws.onmessage = (ev) => {
      this.lastSeen = Date.now();
      const raw = ev.data;
      const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw as ArrayBuffer) : String(raw);
      let m: HubMessage;
      try {
        m = JSON.parse(text) as HubMessage;
      } catch {
        return;
      }
      if (m.t === "hello") this.server = { version: m.version, serverTime: m.serverTime, skewMs: m.serverTime - Date.now() };
      for (const l of [...this.listeners]) {
        try {
          l(m);
        } catch {
          /* a bad listener must not break the others */
        }
      }
    };
    ws.onerror = (e) => this.onDrop(ws, e);
    ws.onclose = (e) => this.onDrop(ws, e);
  }

  private onDrop(ws: WebSocketLike, why: unknown) {
    if (this.ws !== ws) return;
    ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer), (this.pingTimer = null);
    if (this.stopped || !this.topics.size) return this.setState("closed");
    this.scheduleReconnect(why);
  }

  private scheduleReconnect(error: unknown) {
    if (this.stopped) return;
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** Math.min(this.attempt, 16));
    const delayMs = Math.round(base / 2 + Math.random() * (base / 2));
    this.attempt += 1;
    this.setState("reconnecting", { delayMs, error });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }
}

// ─── streams ──────────────────────────────────────────────────────────

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Remembers the last N ids so re-sent snapshots don't repeat events. */
class Seen {
  private set = new Set<string>();
  constructor(private readonly max = 5000) {}
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value as string);
    return true;
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
}

export interface TradesOptions extends StreamCommonOptions {
  /** Also yield the last ~50 trades the hub sends on subscribe (default false: only new ones). */
  history?: boolean;
  /** Only trades of at least this many USD. */
  minUsd?: number;
}

export interface BoardOptions extends StreamCommonOptions {
  chain?: ChainId;
}

export interface LaunchesOptions extends StreamCommonOptions {
  chain?: ChainId;
  /** Only coins launched through Claudia. */
  launchedHere?: boolean;
  /** Ignore coins created more than this long ago when they first show up (default 15 min). */
  maxAgeMs?: number;
}

export interface ThreadStreamOptions extends StreamCommonOptions {
  /** Yield this many recent messages first (default 0). */
  history?: number;
  intervalMs?: number;
  onError?: (err: unknown, nextDelayMs: number) => void;
}

export interface WalletStreamOptions extends StreamCommonOptions {
  chain?: ChainId;
  /** Poll interval (default 30 s, minimum 15 s — the data comes from a shared, cache-first GMGN budget). */
  intervalMs?: number;
  /** Also yield the trades already in the first answer (default false). */
  history?: boolean;
  onError?: (err: unknown, nextDelayMs: number) => void;
}

interface ThreadSource {
  messages(room: string, q?: MessageQuery): Promise<Page<ThreadMessage>>;
}
interface WalletSource {
  wallet(chain: ChainId, address: string): Promise<WalletReport>;
}

/** `client.stream` — live data as async iterators. */
export class StreamApi {
  private hubInstance?: Hub;

  constructor(
    private readonly http: HttpCore,
    private readonly hubOptions: HubOptions,
    private readonly sources: { thread: ThreadSource; wallets: WalletSource },
  ) {}

  /** The shared hub connection (created on first use). */
  get hub(): Hub {
    this.hubInstance ??= new Hub(this.http.baseUrl, this.hubOptions);
    return this.hubInstance;
  }

  /** Closes the WebSocket. Open iterators simply stop receiving until something subscribes again. */
  close(): void {
    this.hubInstance?.close();
  }

  /** Any hub topics, raw messages. */
  raw(topics: string[], opts: StreamCommonOptions = {}): LiveStream<HubMessage> {
    const ch = new Channel<HubMessage>(opts.buffer, opts.signal);
    const listener = Object.assign((m: HubMessage) => ch.push(m), { fail: (e: unknown) => ch.fail(e) });
    const off = this.hub.subscribe(topics, listener);
    ch.whenClosed(off);
    return ch;
  }

  /** Live trades of one coin (oldest first within each batch). Starts the website's live-trades feed for the coin. */
  trades(token: string, opts: TradesOptions = {}): LiveStream<Trade> {
    const key = toTokenKey(token);
    const ch = new Channel<Trade>(opts.buffer, opts.signal);
    const seen = new Seen();
    const since = Date.now() - 2_000;
    const listener = Object.assign(
      (m: HubMessage) => {
        const list = m.t === "trades" ? m.trades : m.t === "trade" ? [m.trade] : null;
        if (!list) return;
        for (const t of list) {
          if (t.key !== key || !seen.add(t.id)) continue;
          if (!opts.history && t.ts < since) continue;
          if (opts.minUsd !== undefined && !(t.amountUsd >= opts.minUsd)) continue;
          ch.push(t);
        }
      },
      { fail: (e: unknown) => ch.fail(e) },
    );
    ch.whenClosed(this.hub.subscribe([`trades:${key}`], listener));
    return ch;
  }

  /** One coin's card as it changes (upserts) and its alerts. */
  token(token: string, opts: StreamCommonOptions = {}): LiveStream<TokenEvent> {
    const key = toTokenKey(token);
    const ch = new Channel<TokenEvent>(opts.buffer, opts.signal);
    const listener = Object.assign(
      (m: HubMessage) => {
        if (m.t === "token" && m.token.key === key) ch.push({ type: "token", token: m.token });
        else if (m.t === "tokens") for (const t of m.tokens) t.key === key && ch.push({ type: "token", token: t });
        else if (m.t === "alert" && m.key === key) ch.push({ type: "alert", key, alert: m.alert });
      },
      { fail: (e: unknown) => ch.fail(e) },
    );
    ch.whenClosed(this.hub.subscribe([`token:${key}`], listener));
    return ch;
  }

  /** The live board of a chain (default Solana): a snapshot first (and after every reconnect), then upserts, removals and alerts. */
  board(opts: BoardOptions = {}): LiveStream<BoardEvent> {
    const chain = opts.chain ?? "sol";
    const ch = new Channel<BoardEvent>(opts.buffer, opts.signal);
    const mine = (key: string) => key.startsWith(`${chain}:`);
    const listener = Object.assign(
      (m: HubMessage) => {
        if (m.t === "board" && m.chain === chain) ch.push({ type: "snapshot", chain, tokens: m.tokens });
        else if (m.t === "tokens" || m.t === "token") {
          const tokens = (m.t === "tokens" ? m.tokens : [m.token]).filter((t) => t.chain === chain);
          if (tokens.length) ch.push({ type: "upsert", tokens });
        } else if (m.t === "remove") ch.push({ type: "remove", keys: m.keys });
        else if (m.t === "alert" && mine(m.key)) ch.push({ type: "alert", key: m.key, alert: m.alert });
      },
      { fail: (e: unknown) => ch.fail(e) },
    );
    ch.whenClosed(this.hub.subscribe([`board:${chain}`], listener));
    return ch;
  }

  /**
   * New coins as they appear on the board (derived from `board:<chain>`; the hub has no separate launches topic).
   * Coins already on the board when the stream starts are skipped.
   */
  launches(opts: LaunchesOptions = {}): LiveStream<TokenSnapshot> {
    const chain = opts.chain ?? "sol";
    const maxAge = opts.maxAgeMs ?? 15 * 60_000;
    const ch = new Channel<TokenSnapshot>(opts.buffer, opts.signal);
    const known = new Seen(20_000);
    let primed = false;
    const fresh = (t: TokenSnapshot) => (!opts.launchedHere || t.launchedHere) && (!t.createdAt || Date.now() - t.createdAt <= maxAge);
    const listener = Object.assign(
      (m: HubMessage) => {
        if (m.t === "board" && m.chain === chain) {
          for (const t of m.tokens) {
            if (known.add(t.key) && primed && fresh(t)) ch.push(t);
          }
          primed = true;
          return;
        }
        if (!primed || (m.t !== "tokens" && m.t !== "token")) return;
        for (const t of m.t === "tokens" ? m.tokens : [m.token]) {
          if (t.chain !== chain || !known.add(t.key)) continue;
          if (fresh(t)) ch.push(t);
        }
      },
      { fail: (e: unknown) => ch.fail(e) },
    );
    ch.whenClosed(this.hub.subscribe([`board:${chain}`], listener));
    return ch;
  }

  /** Chain health every ~2 s (source, latency, last block, SOL price). */
  status(opts: StreamCommonOptions = {}): LiveStream<ChainStatus[]> {
    const ch = new Channel<ChainStatus[]>(opts.buffer ?? 10, opts.signal);
    const listener = Object.assign((m: HubMessage) => m.t === "status" && ch.push(m.chains), { fail: (e: unknown) => ch.fail(e) });
    ch.whenClosed(this.hub.subscribe(["status"], listener));
    return ch;
  }

  /** New messages in a thread room, oldest first (polls `after=<cursor>`; the hub has no thread topic). */
  thread(room: string, opts: ThreadStreamOptions = {}): LiveStream<ThreadMessage> {
    const ch = new Channel<ThreadMessage>(opts.buffer, opts.signal);
    const ctl = new AbortController();
    ch.whenClosed(() => ctl.abort());
    const interval = Math.max(1_000, opts.intervalMs ?? 5_000);
    const byId = (a: ThreadMessage, b: ThreadMessage) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    void (async () => {
      let cursor: string | undefined;
      let fails = 0;
      while (!ctl.signal.aborted) {
        let delay = interval;
        try {
          if (cursor === undefined) {
            const first = await this.sources.thread.messages(room, { limit: Math.max(1, Math.min(100, opts.history ?? 1)) });
            const list = [...first.data].sort(byId);
            cursor = list.length ? list[list.length - 1].id : "0";
            if (opts.history) for (const m of list.slice(-opts.history)) ch.push(m);
          } else {
            const page = await this.sources.thread.messages(room, { after: cursor, limit: 50 });
            const list = [...page.data].sort(byId);
            for (const m of list) {
              ch.push(m);
              cursor = m.id;
            }
            if (list.length >= 50) delay = 0;
          }
          fails = 0;
        } catch (e) {
          fails += 1;
          delay = Math.min(60_000, interval * 2 ** Math.min(fails, 4));
          if (e instanceof ClaudiaApiError && e.retryAfter !== undefined) delay = Math.max(delay, Math.min(e.retryAfter * 1000, 10 * 60_000));
          opts.onError?.(e, delay);
        }
        if (delay) await sleep(delay, ctl.signal);
      }
    })();
    return ch;
  }

  /** A wallet's new buys and sells (polls the cache-first wallet insights; no hub topic carries wallets yet). */
  wallet(address: string, opts: WalletStreamOptions = {}): LiveStream<FeedTrade> {
    const chain = opts.chain ?? "sol";
    const ch = new Channel<FeedTrade>(opts.buffer, opts.signal);
    const ctl = new AbortController();
    ch.whenClosed(() => ctl.abort());
    const interval = Math.max(15_000, opts.intervalMs ?? 30_000);
    const seen = new Seen();
    const idOf = (t: FeedTrade) => t.tx ?? `${t.tokenKey}:${t.side}:${t.at}:${t.amountUsd}`;
    void (async () => {
      let first = true;
      let fails = 0;
      while (!ctl.signal.aborted) {
        let delay = interval;
        try {
          const w = await this.sources.wallets.wallet(chain, address);
          const list = [...(w.recent ?? [])].sort((a, b) => a.at - b.at);
          for (const t of list) if (seen.add(idOf(t)) && (!first || opts.history)) ch.push(t);
          first = false;
          fails = 0;
        } catch (e) {
          fails += 1;
          delay = Math.min(5 * 60_000, interval * 2 ** Math.min(fails, 3));
          if (e instanceof ClaudiaApiError && e.retryAfter !== undefined) delay = Math.max(delay, e.retryAfter * 1000);
          opts.onError?.(e, delay);
        }
        await sleep(delay, ctl.signal);
      }
    })();
    return ch;
  }
}
