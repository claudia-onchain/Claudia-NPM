// The Social engine: accounts, the approval queue, rules, publishing (once only), scheduling, inbox.
//
// Files under <dataDir>/social (JSON written atomically, no database):
//   accounts.json        AES-256-GCM sealed credentials (default TokenStore; key "social-vault")
//   accounts-index.json  account list without secrets (so sync calls like accounts()/draft() work)
//   posts.json           every post with its per-account results and idempotency keys
//   state.json           kill switch, inbox cursors and read budgets, known X mentions
//   audit.jsonl          one line per action (never secrets)
import { join } from "node:path";
import { ClaudiaSocialError, errorText } from "./errors.js";
import { Emitter } from "./emitter.js";
import { createMediaHelper } from "./media.js";
import { createPkce, DEFAULT_RELAY, loopbackRedirect, makeState } from "./oauth.js";
import {
  applyContentRules,
  countChars,
  DEFAULT_CAPS,
  DEFAULT_LINKS_PER_DAY,
  DEFAULT_TEXTS,
  normalizedHash,
  type RuleTexts,
} from "./rules.js";
import { Transport } from "./transport.js";
import { CONNECTORS, LISTED_ONLY } from "./connectors/index.js";
import type { ConnCtx, Connected, Connector, PublishJob } from "./connectors/base.js";
import type {
  Account,
  DryRunRequest,
  DryRunResult,
  InboxItem,
  NetworkId,
  Post,
  PostInput,
  PostResult,
  PostStatus,
  Preview,
  Social,
  SocialEvent,
  SocialOptions,
  StoredAccount,
  TokenStore,
} from "./types.js";
import { DAY_MS, appendLine, defaultDataDir, ensureDir, newId, readJson, sha256Hex, truncate, writeJsonAtomic } from "./util.js";
import { fileTokenStore } from "./vault.js";
import { defaultWsFactory, type WsFactory } from "./ws.js";
import { parseClientCreds } from "./keys.js";

interface StateFile {
  v: 1;
  killSwitch: boolean;
  inbox: Record<string, { cursor?: unknown; day?: string; reads?: number }>;
  mentions: Record<string, string[]>;
  expiryWarned: Record<string, string>;
}

interface PendingOAuth {
  network: NetworkId;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  params: Record<string, string>;
  extra: Record<string, any>;
  createdAt: number;
}

const EDITABLE: PostStatus[] = ["draft", "pending_approval", "approved", "scheduled"];
const OAUTH_TTL_MS = 15 * 60_000;
const REFRESH_EARLY_MS = 5 * 60_000;

export function createSocial(opts: SocialOptions): Social {
  return new SocialEngine(opts);
}

class SocialEngine implements Social {
  private dir: string;
  private files: { posts: string; state: string; index: string; audit: string; accounts: string };
  private http: Transport;
  private store: TokenStore;
  private ev = new Emitter();
  private postsList: Post[];
  private state: StateFile;
  private index: Account[];
  private creds: Map<string, Record<string, unknown>> | null = null;
  private loading: Promise<void> | null = null;
  private loadError: unknown = null;
  private pending = new Map<string, PendingOAuth>();
  private locks = new Map<string, Promise<unknown>>();
  private texts: RuleTexts;
  private now: () => number;
  private ws: WsFactory;
  private closed = false;

  constructor(private opts: SocialOptions) {
    this.dir = join(opts.dataDir ?? defaultDataDir(), "social");
    ensureDir(this.dir);
    this.files = {
      posts: join(this.dir, "posts.json"),
      state: join(this.dir, "state.json"),
      index: join(this.dir, "accounts-index.json"),
      audit: join(this.dir, "audit.jsonl"),
      accounts: join(this.dir, "accounts.json"),
    };
    this.http = new Transport({ fetch: opts.fetch, dryRun: opts.dryRun });
    this.store = opts.tokens ?? fileTokenStore(this.files.accounts, opts.keys);
    this.postsList = readJson<{ v: 1; posts: Post[] }>(this.files.posts, { v: 1, posts: [] }).posts;
    this.state = { v: 1, killSwitch: false, inbox: {}, mentions: {}, expiryWarned: {}, ...readJson<Partial<StateFile>>(this.files.state, {}) };
    this.index = readJson<{ v: 1; accounts: Account[] }>(this.files.index, { v: 1, accounts: [] }).accounts;
    this.texts = { disclosure: opts.rules?.disclosureText ?? DEFAULT_TEXTS.disclosure, nfa: opts.rules?.nfaText ?? DEFAULT_TEXTS.nfa };
    this.now = opts.now ?? Date.now;
    this.ws = defaultWsFactory(opts.WebSocket);
    this.recoverInterrupted();
  }

  // ---------------------------------------------------------------- persistence

  async ready(): Promise<void> {
    if (this.creds) return;
    this.loading ??= (async () => {
      try {
        const list = await this.store.load();
        this.creds = new Map(list.map((s) => [s.account.id, s.credentials]));
        // the token store is the source of truth for which accounts exist
        const known = new Map(this.index.map((a) => [a.id, a]));
        for (const s of list) known.set(s.account.id, { ...known.get(s.account.id), ...s.account });
        const next = [...known.values()].filter((a) => this.creds!.has(a.id));
        if (JSON.stringify(next) !== JSON.stringify(this.index)) {
          this.index = next;
          this.saveIndex();
        }
      } catch (e) {
        this.loadError = e;
        this.creds = new Map();
      }
    })();
    await this.loading;
  }

  private savePosts(): void {
    writeJsonAtomic(this.files.posts, { v: 1, posts: this.postsList });
  }
  private saveState(): void {
    writeJsonAtomic(this.files.state, this.state);
  }
  private saveIndex(): void {
    writeJsonAtomic(this.files.index, { v: 1, accounts: this.index });
  }
  private async saveCreds(): Promise<void> {
    // never overwrite a vault we could not open (that would drop every saved account)
    if (this.loadError) throw this.loadError;
    const list: StoredAccount[] = this.index
      .filter((a) => this.creds!.has(a.id))
      .map((a) => ({ account: a, credentials: this.creds!.get(a.id)! }));
    await this.store.save(list);
  }

  private audit(event: string, detail: Record<string, unknown> = {}): void {
    const line = { at: new Date(this.now()).toISOString(), event, ...detail };
    try {
      appendLine(this.files.audit, line);
    } catch {
      /* disk full etc: never block on the audit log */
    }
    this.ev.emit("audit", line);
  }

  /** A crash mid-publish leaves results "pending" + uncertain. They become failed (may be live) on load. */
  private recoverInterrupted(): void {
    let changed = false;
    for (const p of this.postsList) {
      if (p.status !== "publishing") continue;
      for (const r of p.results) {
        if (r.status === "pending" && r.uncertain) {
          r.status = "failed";
          r.error = "Interrupted while sending: it may already be live. Check the account, then publish with retryUncertain to send again.";
          changed = true;
        }
      }
      // targets that never started can simply be sent: the post goes back to "approved" for that
      const notStarted = p.results.some((r) => r.status === "pending");
      p.status = notStarted ? "approved" : settle(p.results);
      if (notStarted) p.note = "Interrupted before every account was sent. Publish again to finish (accounts already live are skipped).";
      p.updatedAt = this.now();
      changed = true;
      this.audit("publish_interrupted", { post: p.id });
    }
    if (changed) this.savePosts();
  }

  // ---------------------------------------------------------------- networks & accounts

  networks() {
    return [...Object.values(CONNECTORS).map((c) => c.info), ...LISTED_ONLY];
  }

  accounts(): Account[] {
    return this.index.map((a) => ({ ...a }));
  }

  /** Service channels (Buffer → Instagram) go through the service's connector. */
  private connectorOf(a: Account): Connector {
    return this.connector(a.via ?? a.network);
  }

  private connector(network: NetworkId): Connector {
    const c = CONNECTORS[network];
    if (!c) throw new ClaudiaSocialError("unsupported", `No connector for "${network}".`, { hint: "Call networks() to see what is supported." });
    return c;
  }

  private ctxFor(network: NetworkId, http: Transport, account?: Account): ConnCtx {
    const creds = account ? this.credsOf(account) : {};
    return {
      http,
      network,
      account,
      creds,
      dryRun: http.dryRun,
      now: this.now,
      media: createMediaHelper(http, this.opts.mediaRelay, network),
      saveCreds: async (c) => {
        if (!account || http.dryRun) return;
        const own = account.parent ? this.creds!.get(account.parent) : this.creds!.get(account.id);
        Object.assign(own ?? {}, c);
        await this.saveCreds();
      },
      ws: this.ws,
      mentionCache: new Set(account ? (this.state.mentions[account.id] ?? []) : []),
      warn: (m) => this.ev.emit("warning", { account: account?.id, network, message: m }),
    };
  }

  private credsOf(a: Account): Record<string, any> {
    if (!this.creds) return {};
    const own = this.creds.get(a.id) ?? {};
    if (a.parent) return { ...(this.creds.get(a.parent) ?? {}), ...own };
    return own;
  }

  private getAccount(id: string): Account {
    const a = this.index.find((x) => x.id === id);
    if (!a) throw new ClaudiaSocialError("invalid", `Unknown account "${id}".`, { hint: "Call accounts() for the ids, or connect() the network first." });
    return a;
  }

  private throwIfLoadFailed(): void {
    if (this.loadError) throw this.loadError;
  }

  async connect(network: NetworkId, params: Record<string, string> = {}, o: { dryRun?: boolean } = {}) {
    await this.ready();
    const c = this.connector(network);
    const http = o.dryRun || this.opts.dryRun ? this.http.dry() : this.http;
    const ctx = this.ctxFor(network, http);
    if (c.oauth && !(c.connectKey && hasDirectToken(network, params))) {
      const spec = c.oauth;
      const port = Number(params.port ?? this.opts.loopbackPort ?? 3939);
      const mode = params.redirect === "loopback" || params.redirect === "relay" ? params.redirect : spec.redirect;
      const redirectUri = params.redirectUri ?? (mode === "relay" ? (this.opts.relayUrl ?? DEFAULT_RELAY) : loopbackRedirect(port));
      let clientId: string | undefined = params.clientId;
      let clientSecret: string | undefined = params.clientSecret;
      if (!clientId) {
        const stored = parseClientCreds(await this.opts.keys.get(spec.keyName));
        clientId = stored.clientId;
        clientSecret ??= stored.clientSecret;
      }
      let extra: Record<string, any> = {};
      if (spec.prepare) {
        const r = await spec.prepare(ctx, { params, redirectUri, clientId, clientSecret });
        clientId = r.clientId;
        clientSecret = r.clientSecret;
        extra = r.extra ?? {};
      }
      if (!clientId) {
        throw new ClaudiaSocialError("no_key", `${c.info.name} needs your own developer app (client id${spec.needsSecret ? " + secret" : ""}).`, {
          network,
          hint: `${c.info.setup} Then store it under the key "${spec.keyName}" as {"clientId":"…","clientSecret":"…"} or pass params.clientId/clientSecret.`,
        });
      }
      if (spec.needsSecret && !clientSecret) {
        throw new ClaudiaSocialError("no_key", `${c.info.name} needs the client secret of your developer app too.`, { network, hint: `Store it under the key "${spec.keyName}".` });
      }
      const pkce = createPkce();
      const state = makeState(port);
      const authorizeUrl = spec.authorizeUrl({
        clientId,
        clientSecret,
        redirectUri,
        state,
        challenge: pkce.challenge,
        verifier: pkce.verifier,
        scopes: params.scopes ? params.scopes.split(/[ ,]+/) : spec.scopes,
        params,
        extra,
      });
      if (!http.dryRun) {
        this.prunePending();
        this.pending.set(state, { network, verifier: pkce.verifier, redirectUri, clientId, clientSecret, params, extra, createdAt: this.now() });
      }
      this.audit("oauth_start", { network, redirectUri, dryRun: http.dryRun || undefined });
      const out: { authorizeUrl: string; state: string; redirectUri: string; requests?: DryRunRequest[] } = { authorizeUrl, state, redirectUri };
      if (http.dryRun && http.requests.length) out.requests = http.requests;
      return out;
    }
    if (!c.connectKey) throw new ClaudiaSocialError("unsupported", `${c.info.name} has no key-based connect.`, { network });
    const list = await c.connectKey(ctx, params, this.opts.keys);
    if (http.dryRun) return { dryRun: true as const, requests: http.requests };
    const saved = await this.saveConnected(list);
    return saved[0]!;
  }

  private prunePending(): void {
    for (const [k, v] of this.pending) if (this.now() - v.createdAt > OAUTH_TTL_MS) this.pending.delete(k);
  }

  private async saveConnected(list: Connected[]): Promise<Account[]> {
    const out: Account[] = [];
    const prevCreds = new Map(this.creds!);
    const prevIndex = [...this.index];
    for (const { account, credentials } of list) {
      const a: Account = { ...account, connectedAt: account.connectedAt ?? this.now() };
      this.index = this.index.filter((x) => x.id !== a.id).concat(a);
      this.creds!.set(a.id, credentials);
      out.push(a);
    }
    try {
      await this.saveCreds();
    } catch (e) {
      this.creds = prevCreds;
      this.index = prevIndex;
      throw e;
    }
    this.saveIndex();
    for (const a of out) {
      this.audit("account_connected", { account: a.id, network: a.network, via: a.via });
      this.ev.emit("account", { kind: "connected", account: a });
    }
    return out;
  }

  async completeOAuth(state: string, code: string): Promise<Account> {
    await this.ready();
    this.prunePending();
    const p = this.pending.get(state);
    if (!p) {
      throw new ClaudiaSocialError("invalid", "Unknown or expired OAuth state.", { hint: "Start the connection again (links are valid for 15 minutes and work once)." });
    }
    this.pending.delete(state);
    const c = this.connector(p.network);
    const ctx = this.ctxFor(p.network, this.http);
    const got = await c.oauth!.exchange(ctx, {
      code,
      redirectUri: p.redirectUri,
      verifier: p.verifier,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      params: p.params,
      extra: p.extra,
    });
    const [a] = await this.saveConnected(Array.isArray(got) ? got : [got]);
    return a!;
  }

  async disconnect(accountId: string): Promise<void> {
    await this.ready();
    const a = this.getAccount(accountId);
    const gone = new Set([a.id, ...this.index.filter((x) => x.parent === a.id).map((x) => x.id)]);
    this.index = this.index.filter((x) => !gone.has(x.id));
    for (const id of gone) this.creds!.delete(id);
    await this.saveCreds().catch(() => undefined);
    this.saveIndex();
    for (const id of gone) {
      this.audit("account_disconnected", { account: id });
      this.ev.emit("account", { kind: "disconnected", account: { id } });
    }
  }

  /** Refreshes OAuth tokens shortly before they expire. */
  private async freshCtx(account: Account, http: Transport): Promise<ConnCtx> {
    const c = this.connectorOf(account);
    const owner = account.parent ? this.getAccount(account.parent) : account;
    let ctx = this.ctxFor(c.id, http, account);
    const exp = Number(ctx.creds.expiresAt ?? 0);
    if (exp && exp - this.now() < (c.refreshEarlyMs ?? REFRESH_EARLY_MS)) {
      if (c.refresh && ctx.creds.refreshToken) {
        if (http.dryRun) return ctx;
        const next = await c.refresh(ctx);
        if (next) {
          await ctx.saveCreds(next);
          if (next.expiresAt && owner.expiresAt) this.patchAccount(owner.id, { expiresAt: Number(next.expiresAt) });
          this.audit("token_refreshed", { account: owner.id });
          ctx = this.ctxFor(c.id, http, this.getAccount(account.id));
        }
      } else if (exp < this.now()) {
        throw new ClaudiaSocialError("expired", `The ${c.info.name} connection for ${account.handle} expired.`, {
          network: account.network,
          hint: "Reconnect the account (LinkedIn tokens last 60 days and cannot be refreshed by self-serve apps).",
        });
      }
    }
    return ctx;
  }

  private patchAccount(id: string, patch: Partial<Account>): void {
    this.index = this.index.map((a) => (a.id === id ? { ...a, ...patch } : a));
    this.saveIndex();
  }

  // ---------------------------------------------------------------- posts

  posts(f: { status?: PostStatus; limit?: number } = {}): Post[] {
    let list = [...this.postsList].sort((a, b) => b.createdAt - a.createdAt);
    if (f.status) list = list.filter((p) => p.status === f.status);
    if (f.limit) list = list.slice(0, f.limit);
    return structuredClone(list);
  }

  getPost(id: string): Post | null {
    const p = this.postsList.find((x) => x.id === id);
    return p ? structuredClone(p) : null;
  }

  private mustPost(id: string): Post {
    const p = this.postsList.find((x) => x.id === id);
    if (!p) throw new ClaudiaSocialError("invalid", `Unknown post "${id}".`);
    return p;
  }

  private validate(input: PostInput): void {
    if (!input || typeof input !== "object") throw new ClaudiaSocialError("invalid", "Post input is missing.");
    if (typeof input.text !== "string") throw new ClaudiaSocialError("invalid", "text must be a string.");
    if (!input.text.trim() && !input.media?.length) throw new ClaudiaSocialError("invalid", "A post needs text or media.");
    if (!Array.isArray(input.targets) || !input.targets.length) {
      throw new ClaudiaSocialError("invalid", "Pick at least one target account.", { hint: "targets: [{ account: \"bluesky:did:plc:…\" }]" });
    }
    for (const t of input.targets) this.getAccount(t.account);
    if (input.thread && !input.thread.every((s) => typeof s === "string")) throw new ClaudiaSocialError("invalid", "thread must be a list of strings.");
    if (input.scheduleAt !== undefined && !Number.isFinite(input.scheduleAt)) throw new ClaudiaSocialError("invalid", "scheduleAt must be a unix time in ms.");
  }

  private touch(p: Post, status?: PostStatus, note?: string): Post {
    if (status) p.status = status;
    if (note !== undefined) p.note = note || undefined;
    p.updatedAt = this.now();
    this.savePosts();
    this.ev.emit("post", structuredClone(p));
    return structuredClone(p);
  }

  draft(input: PostInput): Post {
    this.validate(input);
    const p: Post = {
      id: newId("post"),
      status: "draft",
      input: structuredClone(input),
      createdAt: this.now(),
      updatedAt: this.now(),
      results: [],
    };
    this.postsList.push(p);
    this.audit("draft", { post: p.id, targets: input.targets.map((t) => t.account), text: truncate(input.text, 80) });
    return this.touch(p);
  }

  update(id: string, patch: Partial<PostInput>): Post {
    const p = this.mustPost(id);
    if (!EDITABLE.includes(p.status)) {
      throw new ClaudiaSocialError("invalid", `A ${p.status} post can't be edited.`, { hint: "Draft a new post instead." });
    }
    const next = { ...p.input, ...structuredClone(patch) } as PostInput;
    this.validate(next);
    p.input = next;
    this.audit("update", { post: id });
    // content changed after a human said yes: ask again
    if (p.status === "approved" || p.status === "scheduled") return this.touch(p, "pending_approval", "Edited after approval: needs approval again.");
    return this.touch(p);
  }

  submit(id: string): Post {
    const p = this.mustPost(id);
    if (p.status !== "draft") throw new ClaudiaSocialError("invalid", `Only drafts can be submitted (this one is ${p.status}).`);
    const blocked = this.preview(id).filter((x) => x.blocked);
    if (blocked.length) {
      throw new ClaudiaSocialError("blocked", blocked.map((b) => `${b.account}: ${b.blocked}`).join(" | "), { hint: "Fix the text (or drop that target) and submit again." });
    }
    this.audit("submit", { post: id });
    return this.touch(p, "pending_approval", "");
  }

  approve(id: string): Post {
    const p = this.mustPost(id);
    if (p.status !== "pending_approval" && p.status !== "draft") {
      throw new ClaudiaSocialError("invalid", `Only drafts or posts waiting for approval can be approved (this one is ${p.status}).`);
    }
    const blocked = this.preview(id).filter((x) => x.blocked);
    if (blocked.length === p.input.targets.length) {
      throw new ClaudiaSocialError("blocked", blocked.map((b) => `${b.account}: ${b.blocked}`).join(" | "), { hint: "Every target is blocked; fix the post first." });
    }
    p.approvedAt = this.now();
    this.audit("approve", { post: id });
    if (p.input.scheduleAt && p.input.scheduleAt > this.now()) return this.touch(p, "scheduled", "");
    return this.touch(p, "approved", "");
  }

  reject(id: string, why?: string): Post {
    const p = this.mustPost(id);
    if (["published", "partial", "publishing"].includes(p.status)) throw new ClaudiaSocialError("invalid", `A ${p.status} post can't be rejected.`);
    this.audit("reject", { post: id, why });
    return this.touch(p, "canceled", why ? `Rejected: ${why}` : "Rejected");
  }

  schedule(id: string, at: number): Post {
    const p = this.mustPost(id);
    if (!Number.isFinite(at)) throw new ClaudiaSocialError("invalid", "at must be a unix time in ms.");
    if (at < this.now() - 60_000) throw new ClaudiaSocialError("invalid", "That time is in the past.");
    p.input.scheduleAt = at;
    this.audit("schedule", { post: id, at: new Date(at).toISOString() });
    if (p.status === "approved" || p.status === "scheduled") return this.touch(p, "scheduled", "");
    if (p.status === "draft" || p.status === "pending_approval") return this.touch(p, undefined, "Scheduled once approved.");
    throw new ClaudiaSocialError("invalid", `A ${p.status} post can't be scheduled.`);
  }

  // ---------------------------------------------------------------- rules & preview

  preview(id: string): Preview[] {
    const p = this.mustPost(id);
    return p.input.targets.map((t) => this.previewTarget(p, t.account, t.text));
  }

  private previewTarget(p: Post, accountId: string, override?: string): Preview & { job: Omit<PublishJob, "progress" | "done" | "key" | "postId" | "stableAt">; hash: string } {
    const account = this.index.find((a) => a.id === accountId);
    const network = account?.network ?? ("x" as NetworkId);
    const base: Preview = { account: accountId, network, text: "", chars: 0, media: p.input.media?.length ?? 0, labelsAdded: [], warnings: [] };
    const emptyJob = { text: "", thread: [], media: [], flags: { ai: false, ad: false }, options: {} };
    if (!account) return { ...base, blocked: "This account is no longer connected.", job: emptyJob, hash: "" };
    const c = this.connectorOf(account);
    // a service channel (Buffer → X) keeps the service's caps but the platform's text limits
    const platformC = account.via && account.network !== account.via ? CONNECTORS[account.network] : undefined;
    const info = { ...c.info, name: platformC ? `${platformC.info.name} via ${c.info.name}` : c.info.name, limits: { ...c.info.limits, ...(platformC ? { maxChars: platformC.info.limits.maxChars } : {}) } };
    const counter = platformC?.counter ?? c.counter;
    const policy = c.labelsFor?.(account) ?? c.labels;
    const options = { ...(p.input.options?.[account.network] ?? {}), ...(account.via ? (p.input.options?.[account.via] ?? {}) : {}) } as Record<string, any>;
    let text = override ?? p.input.text;
    const link = p.input.link;
    if (link && !text.includes(link)) text = `${text.trimEnd()}\n\n${link}`;
    let thread = [...(p.input.thread ?? [])];
    const warnings: string[] = [];
    // networks without threads: join when it fits
    if (thread.length && !info.caps.thread) {
      const joined = [text, ...thread].join("\n\n");
      if (!info.limits.maxChars || countChars(joined, counter) <= info.limits.maxChars) {
        text = joined;
        warnings.push(`${info.name} has no threads here, so the parts were joined into one post.`);
      } else warnings.push(`${info.name} has no threads here and the parts don't fit in one post: only the first part goes out.`);
      thread = [];
    }
    const r = applyContentRules(
      { text, thread, labels: p.input.labels, accountFlagOn: account.notes?.includes("bot flag on") },
      policy,
      this.texts,
    );
    warnings.push(...r.warnings);
    let blocked = r.blocked;
    const chars = countChars(r.text, counter);
    if (info.limits.maxChars) {
      if (chars > info.limits.maxChars) blocked ??= `Too long for ${info.name}: ${chars}/${info.limits.maxChars}${counter === "x" ? " (X counts links as 23 and emoji as 2)" : ""}.`;
      for (const [i, part] of r.thread.entries()) {
        const n = countChars(part, counter);
        if (n > info.limits.maxChars) blocked ??= `Thread part ${i + 2} is too long for ${info.name}: ${n}/${info.limits.maxChars}.`;
      }
    }
    const media = p.input.media ?? [];
    if (media.length) {
      const anyVideo = media.some((m) => (m.mime ?? m.path).match(/video|\.mp4|\.mov|\.webm|\.m4v/i));
      if (anyVideo && !info.caps.video) blocked ??= `${info.name} does not take video here.`;
      if (!anyVideo && !info.caps.image) blocked ??= `${info.name} does not take images here.`;
      if (info.limits.maxImages && media.length > info.limits.maxImages) blocked ??= `${info.name} takes at most ${info.limits.maxImages} media items.`;
      if (info.limits.maxVideoMb) {
        for (const m of media) {
          const size = createMediaHelper(this.http.dry(), undefined, account.network).size(m);
          if (size && size > info.limits.maxVideoMb * 1024 * 1024) blocked ??= `${m.path} is over ${info.limits.maxVideoMb} MB for ${info.name}.`;
        }
      }
    }
    if (p.input.replyTo && !info.caps.reply) blocked ??= `${info.name} replies are not supported.`;
    const job = {
      text: r.text,
      thread: r.thread,
      media,
      link,
      replyTo: p.input.replyTo && p.input.replyTo.network === account.network ? p.input.replyTo.id : undefined,
      flags: r.flags,
      options,
    };
    if (p.input.replyTo && p.input.replyTo.network !== account.network) warnings.push(`replyTo is a ${p.input.replyTo.network} post, so this goes out as a new post on ${info.name}.`);
    blocked ??= c.check?.(account, job);
    warnings.push(...(c.warnings?.(account, job) ?? []));
    if (account.network === "x" && job.replyTo && !(this.state.mentions[account.id] ?? []).includes(job.replyTo)) {
      warnings.push("X only allows API replies to posts that @mention this account (or quote it). Claudia checks this before sending; it costs one post read.");
    }
    if (account.expiresAt && account.expiresAt - this.now() < 7 * DAY_MS) {
      const days = Math.max(0, Math.round((account.expiresAt - this.now()) / DAY_MS));
      warnings.push(`This ${info.name} connection expires in ${days} day${days === 1 ? "" : "s"}: reconnect it soon.`);
    }
    // history rules
    const hash = normalizedHash([r.text, ...r.thread].join("\n"), this.texts);
    blocked ??= this.historyBlock(p.id, account, hash, !!link || /https?:\/\//.test(r.text));
    if (this.state.killSwitch) warnings.push("The kill switch is on: nothing will publish until it is turned off.");
    const costUsd = c.cost?.({ text: r.text, thread: r.thread, link, media: media.length, reply: !!job.replyTo });
    const out: Preview & { job: typeof job; hash: string } = {
      ...base,
      network: account.network,
      text: r.text,
      chars,
      labelsAdded: r.labelsAdded,
      warnings,
      job,
      hash,
    };
    if (r.thread.length) out.thread = r.thread;
    if (costUsd !== undefined) out.costUsd = Math.round(costUsd * 1000) / 1000;
    if (blocked) out.blocked = blocked;
    // do not leak the internal job in the public preview
    Object.defineProperty(out, "job", { enumerable: false });
    Object.defineProperty(out, "hash", { enumerable: false });
    return out;
  }

  private historyBlock(postId: string, account: Account, hash: string, hasLink: boolean): string | undefined {
    const since = this.now() - DAY_MS;
    const dupWindow = this.now() - (this.opts.rules?.duplicateWindowMs ?? DAY_MS);
    let count = 0;
    let links = 0;
    for (const p of this.postsList) {
      if (p.id === postId) continue;
      for (const r of p.results) {
        if (r.account !== account.id || r.status !== "published" || !r.at) continue;
        if (r.at >= since) {
          count++;
          if (r.hasLink) links++;
        }
        if (r.at >= dupWindow && r.hash === hash) {
          const hrs = Math.max(1, Math.round((this.now() - r.at) / 3_600_000));
          return `Near-duplicate of post ${p.id} sent ${hrs} h ago to this account. Networks treat repeats as spam.`;
        }
      }
    }
    const cap = this.opts.rules?.caps?.[account.network] ?? DEFAULT_CAPS[account.network];
    if (cap !== undefined && count >= cap) return `Daily cap reached for ${account.handle} on ${account.network}: ${count}/${cap} in 24 h.`;
    const lp = this.opts.rules?.linksPerDay ?? {};
    const linkCap = lp[account.network] ?? DEFAULT_LINKS_PER_DAY[account.network] ?? lp.default ?? DEFAULT_LINKS_PER_DAY.default!;
    if (hasLink && links >= linkCap) return `Link limit reached for ${account.handle}: ${links}/${linkCap} posts with links in 24 h.`;
    return undefined;
  }

  // ---------------------------------------------------------------- publish

  killSwitch(on?: boolean): boolean {
    if (on !== undefined && on !== this.state.killSwitch) {
      this.state.killSwitch = on;
      this.saveState();
      this.audit(on ? "kill_switch_on" : "kill_switch_off");
      this.ev.emit("warning", { message: on ? "Kill switch on: nothing publishes." : "Kill switch off." });
    }
    return this.state.killSwitch;
  }

  async publish(id: string, o: { dryRun?: boolean; retryUncertain?: boolean } = {}): Promise<Post | DryRunResult> {
    await this.ready();
    this.throwIfLoadFailed();
    if (o.dryRun || this.opts.dryRun) return this.dryPublish(id);
    return this.withLock(id, () => this.publishNow(id, !!o.retryUncertain));
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => undefined));
    return next;
  }

  private async dryPublish(id: string): Promise<DryRunResult> {
    const p = this.mustPost(id);
    const requests: DryRunRequest[] = [];
    for (const t of p.input.targets) {
      const pv = this.previewTarget(p, t.account, t.text);
      const account = this.index.find((a) => a.id === t.account);
      if (pv.blocked || !account) {
        requests.push({ method: "BLOCKED", url: "", headers: {}, body: pv.blocked ?? "unknown account", label: t.account });
        continue;
      }
      const http = this.http.dry();
      const c = this.connectorOf(account);
      try {
        const ctx = await this.freshCtx(account, http);
        const key = resultKey(p.id, account.id);
        await c.publish(ctx, { ...pv.job, postId: p.id, key, done: [], progress: async () => undefined, stableAt: this.now() });
        await ctx.media.cleanup();
      } catch (e) {
        requests.push({ method: "ERROR", url: "", headers: {}, body: errorText(e), label: t.account });
      }
      for (const r of http.requests) requests.push({ ...r, label: r.label ? `${t.account} · ${r.label}` : t.account });
    }
    this.audit("publish_dry_run", { post: id, requests: requests.length });
    return { dryRun: true, requests };
  }

  private async publishNow(id: string, retryUncertain: boolean): Promise<Post> {
    const p = this.mustPost(id);
    if (this.state.killSwitch) {
      this.audit("publish_blocked_kill_switch", { post: id });
      throw new ClaudiaSocialError("blocked", "The kill switch is on: nothing publishes.", { hint: "Turn it off with killSwitch(false) when you are ready." });
    }
    if (p.status === "published") return structuredClone(p); // once only
    if (p.status === "canceled") throw new ClaudiaSocialError("invalid", "This post was canceled.");
    if (p.status === "draft" || p.status === "pending_approval") {
      throw new ClaudiaSocialError("needs_approval", "This post has not been approved.", { hint: "submit() it, then a person approves it with approve()." });
    }
    // make sure there is one result (with a stable idempotency key) per target
    for (const t of p.input.targets) {
      if (!p.results.find((r) => r.account === t.account)) {
        const a = this.index.find((x) => x.id === t.account);
        p.results.push({ account: t.account, network: a?.network ?? ("x" as NetworkId), status: "pending", key: resultKey(p.id, t.account) });
      }
    }
    this.touch(p, "publishing", "");
    for (const t of p.input.targets) {
      const r = p.results.find((x) => x.account === t.account)!;
      if (r.status === "published") continue;
      const account = this.index.find((a) => a.id === t.account);
      if (!account) {
        r.status = "failed";
        r.error = "This account is no longer connected.";
        continue;
      }
      const c = this.connectorOf(account);
      if (r.uncertain && !retryUncertain && !c.idempotent) continue; // may be live: a person decides
      const pv = this.previewTarget(p, t.account, t.text);
      if (pv.blocked) {
        r.status = "failed";
        r.error = pv.blocked;
        r.uncertain = false;
        this.audit("publish_blocked", { post: id, account: account.id, reason: pv.blocked });
        continue;
      }
      // mark "sending" BEFORE the request: a crash from here on leaves an uncertain result, never a silent resend
      r.status = "pending";
      r.uncertain = true;
      r.error = undefined;
      r.key ??= resultKey(p.id, account.id);
      r.startedAt ??= this.now();
      r.hash = pv.hash;
      r.hasLink = !!pv.job.link || /https?:\/\//.test(pv.text);
      this.savePosts();
      let ctx: ConnCtx | undefined;
      try {
        ctx = await this.freshCtx(account, this.http);
        const out = await c.publish(ctx, {
          ...pv.job,
          postId: p.id,
          key: r.key,
          done: [...(r.remoteIds ?? [])],
          stableAt: r.startedAt,
          progress: async (rid) => {
            r.remoteIds = [...(r.remoteIds ?? []), rid];
            this.savePosts();
          },
        });
        r.status = "published";
        r.uncertain = false;
        r.remoteId = out.remoteId;
        r.url = out.url;
        if (out.remoteIds) r.remoteIds = out.remoteIds;
        r.at = this.now();
        this.audit("published", { post: id, account: account.id, network: account.network, remoteId: out.remoteId, url: out.url, costUsd: pv.costUsd });
      } catch (e) {
        r.status = "failed";
        r.uncertain = e instanceof ClaudiaSocialError ? !!e.uncertain : false;
        r.error = errorText(e);
        this.audit("publish_failed", { post: id, account: account.id, network: account.network, error: r.error, uncertain: r.uncertain || undefined });
      } finally {
        await ctx?.media.cleanup().catch(() => undefined);
      }
      p.updatedAt = this.now();
      this.savePosts();
    }
    return this.touch(p, settle(p.results));
  }

  // ---------------------------------------------------------------- reply & inbox

  async reply(accountId: string, to: string, text: string, o: { dryRun?: boolean } = {}): Promise<unknown> {
    await this.ready();
    this.throwIfLoadFailed();
    const account = this.getAccount(accountId);
    const c = this.connectorOf(account);
    if (!c.reply) throw new ClaudiaSocialError("unsupported", `Replies are not supported on ${c.info.name}.`, { network: account.network });
    const dry = o.dryRun || this.opts.dryRun;
    if (!dry && this.state.killSwitch) throw new ClaudiaSocialError("blocked", "The kill switch is on: nothing publishes.");
    const r = applyContentRules({ text, labels: {}, accountFlagOn: account.notes?.includes("bot flag on") }, c.labelsFor?.(account) ?? c.labels, this.texts);
    if (r.blocked) {
      this.audit("reply_blocked", { account: accountId, reason: r.blocked });
      throw new ClaudiaSocialError("blocked", r.blocked);
    }
    if (c.info.limits.maxChars && countChars(r.text, c.counter) > c.info.limits.maxChars) {
      throw new ClaudiaSocialError("invalid", `Reply too long for ${c.info.name}.`);
    }
    const hash = normalizedHash(r.text, this.texts);
    const hb = this.historyBlock("", account, hash, /https?:\/\//.test(r.text));
    if (hb) throw new ClaudiaSocialError("blocked", hb);
    const http = dry ? this.http.dry() : this.http;
    const ctx = await this.freshCtx(account, http);
    const out = await c.reply(ctx, to, r.text, r.flags);
    if (dry) return { dryRun: true, requests: http.requests };
    // replies count toward caps: keep them as published posts
    const p: Post = {
      id: newId("reply"),
      status: "published",
      input: { text, targets: [{ account: accountId }], replyTo: { network: account.network, id: to } },
      createdAt: this.now(),
      updatedAt: this.now(),
      approvedAt: this.now(),
      results: [{ account: accountId, network: account.network, status: "published", remoteId: out.remoteId, url: out.url, at: this.now(), hash, key: resultKey(to, accountId) }],
      note: "Direct reply",
    };
    this.postsList.push(p);
    this.touch(p);
    this.audit("reply", { account: accountId, to, remoteId: out.remoteId });
    return out;
  }

  async inbox(o: { since?: number; accounts?: string[] } = {}): Promise<InboxItem[]> {
    await this.ready();
    this.throwIfLoadFailed();
    const items: InboxItem[] = [];
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const targets = this.index.filter((a) => (o.accounts ? o.accounts.includes(a.id) : true));
    for (const a of targets) {
      const c = CONNECTORS[a.via ?? a.network];
      if (!c?.inbox) continue;
      const budget = this.opts.inboxBudget?.[a.network]?.perDay ?? (a.network === "x" ? 0 : 200);
      const st = (this.state.inbox[a.id] ??= {});
      if (st.day !== day) {
        st.day = day;
        st.reads = 0;
      }
      const left = budget - (st.reads ?? 0);
      if (left <= 0) {
        if (a.network === "x" && budget === 0) {
          this.ev.emit("warning", { account: a.id, network: a.network, message: "X inbox is off: reads cost $0.005 per post returned. Set inboxBudget.x.perDay to turn it on." });
        }
        continue;
      }
      try {
        const ctx = await this.freshCtx(a, this.http);
        const got = await c.inbox(ctx, st.cursor, left);
        st.cursor = got.cursor;
        st.reads = (st.reads ?? 0) + got.reads;
        if (a.network === "x") {
          const known = new Set(this.state.mentions[a.id] ?? []);
          for (const it of got.items) if (it.kind !== "dm") known.add(it.id);
          this.state.mentions[a.id] = [...known].slice(-500);
        }
        for (const it of got.items) if (!o.since || it.at >= o.since) items.push({ account: a.id, network: a.network, ...it });
      } catch (e) {
        this.ev.emit("warning", { account: a.id, network: a.network, message: `Inbox: ${errorText(e)}` });
      }
    }
    this.saveState();
    return items.sort((x, y) => y.at - x.at);
  }

  // ---------------------------------------------------------------- scheduler

  async tick(): Promise<void> {
    if (this.closed) return;
    await this.ready();
    const lateMs = (this.opts.rules?.lateAfterMin ?? 10) * 60_000;
    for (const p of this.postsList.filter((x) => x.status === "scheduled")) {
      const at = p.input.scheduleAt ?? 0;
      if (at > this.now()) continue;
      if (this.now() - at > lateMs) {
        this.audit("schedule_missed", { post: p.id, at: new Date(at).toISOString() });
        this.touch(p, "pending_approval", `Posting late? It was due ${Math.round((this.now() - at) / 60_000)} min ago. Approve again to send now.`);
        continue;
      }
      if (this.state.killSwitch) continue;
      try {
        await this.withLock(p.id, () => this.publishNow(p.id, false));
      } catch (e) {
        this.ev.emit("warning", { post: p.id, message: errorText(e) });
      }
    }
    // connections close to expiry (LinkedIn: 60 days, no refresh for self-serve apps)
    const day = new Date(this.now()).toISOString().slice(0, 10);
    for (const a of this.index) {
      if (a.expiresAt && a.expiresAt - this.now() < 7 * DAY_MS && this.state.expiryWarned[a.id] !== day) {
        const c = CONNECTORS[a.via ?? a.network];
        if (c?.refresh && this.creds?.get(a.id)?.refreshToken) continue;
        this.state.expiryWarned[a.id] = day;
        this.saveState();
        this.ev.emit("account", { kind: "expiring", account: a, expiresAt: a.expiresAt });
      }
    }
  }

  on(ev: SocialEvent, cb: (x: any) => void): void {
    this.ev.on(ev, cb);
  }
  off(ev: SocialEvent, cb: (x: any) => void): void {
    this.ev.off(ev, cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    // let in-flight publishes finish, but never hang forever on a network that stopped answering
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.locks.values()]),
      new Promise<void>((r) => {
        timer = setTimeout(r, 10_000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    this.ev.clear();
    this.pending.clear();
  }
}

function settle(results: PostResult[]): PostStatus {
  if (!results.length) return "failed";
  const pub = results.filter((r) => r.status === "published").length;
  if (pub === results.length) return "published";
  if (results.some((r) => r.status === "pending")) return "publishing";
  return pub ? "partial" : "failed";
}

/** Stable per (post, account): reused for every retry and sent as the provider idempotency key where one exists. */
function resultKey(postId: string, accountId: string): string {
  return sha256Hex(`${postId}|${accountId}`).slice(0, 32);
}

/** Key-based connect is used for OAuth networks when the caller already has an access token. */
function hasDirectToken(network: NetworkId, params: Record<string, string>): boolean {
  return network === "mastodon" && !!params.accessToken;
}
