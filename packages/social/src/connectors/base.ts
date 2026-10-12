// The connector interface every network implements. Connectors build requests and call ctx.http,
// which either sends them or records them (dry run). Connectors never touch disk or the post queue.
import { ClaudiaSocialError } from "../errors.js";
import type { Account, KeyProvider, MediaInput, NetworkId, NetworkInfo } from "../types.js";
import type { Transport } from "../transport.js";
import type { Counter, LabelPolicy } from "../rules.js";
import type { MediaHelper } from "../media.js";
import type { WsFactory } from "../ws.js";

export interface ConnCtx {
  http: Transport;
  network: NetworkId;
  account?: Account;
  /** Decrypted credentials of this account (for service channels: merged with the parent's). */
  creds: Record<string, any>;
  dryRun: boolean;
  now(): number;
  media: MediaHelper;
  /** Persist changed credentials (refreshed tokens). */
  saveCreds(c: Record<string, any>): Promise<void>;
  ws: WsFactory;
  /** Ids of posts known to mention this account (X reply rule). */
  mentionCache: Set<string>;
  warn(msg: string): void;
}

export interface PublishJob {
  postId: string;
  /** Idempotency key for this (post, account). */
  key: string;
  text: string;
  /** Follow-up thread parts, labels already applied. */
  thread: string[];
  media: MediaInput[];
  link?: string;
  replyTo?: string;
  flags: { ai: boolean; ad: boolean };
  options: Record<string, any>;
  /** Parts already sent by an earlier attempt (threads resume after these). */
  done: string[];
  /** Called after each part is live so a crash mid-thread never re-sends earlier parts. */
  progress(remoteId: string): Promise<void>;
  /** Time of the first send attempt (unix ms). Stable across retries (Nostr created_at, Bluesky rkey). */
  stableAt: number;
}

export interface PublishOut {
  remoteId: string;
  url?: string;
  remoteIds?: string[];
}

export interface Connected {
  account: Omit<Account, "connectedAt"> & { connectedAt?: number };
  credentials: Record<string, unknown>;
}

export interface OAuthStart {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  state: string;
  challenge: string;
  /** PKCE verifier (TikTok wants hex(SHA-256(verifier)) instead of the standard challenge). */
  verifier: string;
  scopes: string[];
  params: Record<string, string>;
  extra: Record<string, any>;
}

export interface OAuthSpec {
  /** Default redirect style. "relay" for portals that reject http://127.0.0.1. */
  redirect: "loopback" | "relay";
  /** KeyProvider name holding the user's app credentials (JSON {clientId, clientSecret} or "id:secret"). */
  keyName: string;
  scopes: string[];
  /** Whether a client secret is required for the token exchange. */
  needsSecret: boolean;
  /** Optional step before the authorize URL (Mastodon registers an app on the instance). */
  prepare?(
    ctx: ConnCtx,
    p: { params: Record<string, string>; redirectUri: string; clientId?: string; clientSecret?: string },
  ): Promise<{ clientId: string; clientSecret?: string; extra?: Record<string, any> }>;
  authorizeUrl(p: OAuthStart): string;
  exchange(
    ctx: ConnCtx,
    p: { code: string; redirectUri: string; verifier: string; clientId: string; clientSecret?: string; params: Record<string, string>; extra: Record<string, any> },
  ): Promise<Connected | Connected[]>;
}

export interface InboxRaw {
  kind: "mention" | "reply" | "dm";
  id: string;
  from: string;
  text: string;
  at: number;
  url?: string;
}

export interface Connector {
  id: NetworkId;
  info: NetworkInfo;
  labels: LabelPolicy;
  /** Per-account label policy (posting services: depends on the platform behind the channel). */
  labelsFor?(account: Account): LabelPolicy;
  counter: Counter;
  /** True when a resend with the same key cannot create a duplicate (provider-side idempotency). */
  idempotent?: boolean;
  /** Refresh tokens this long before they expire (default 5 min; Meta 60-day tokens: 7 days). */
  refreshEarlyMs?: number;
  /** Estimated cost of one publish in USD (X pay-per-use). */
  cost?(job: { text: string; thread: string[]; link?: string; media: number; reply?: boolean }): number | undefined;
  connectKey?(ctx: ConnCtx, params: Record<string, string>, keys: KeyProvider): Promise<Connected[]>;
  oauth?: OAuthSpec;
  /** Returns new credentials when the access token was refreshed (null: nothing to do). */
  refresh?(ctx: ConnCtx): Promise<Record<string, unknown> | null>;
  publish(ctx: ConnCtx, job: PublishJob): Promise<PublishOut>;
  reply?(ctx: ConnCtx, to: string, text: string, flags: { ai: boolean; ad: boolean }): Promise<PublishOut>;
  inbox?(ctx: ConnCtx, cursor: any, budget: number): Promise<{ items: InboxRaw[]; cursor: any; reads: number }>;
  /** Extra preview warnings for this account/post. */
  warnings?(account: Account | undefined, job: { text: string; thread: string[]; media: MediaInput[]; link?: string; replyTo?: string; options: Record<string, any> }): string[];
  /** Hard checks before sending (return a reason to block). */
  check?(account: Account | undefined, job: { text: string; thread: string[]; media: MediaInput[]; link?: string; replyTo?: string; options: Record<string, any> }): string | undefined;
}

/** Throws a ClaudiaSocialError("no_key") naming the missing credential. */
export function need<T>(v: T | undefined | null | "", what: string, hint: string): T {
  if (v === undefined || v === null || v === "") throw new ClaudiaSocialError("no_key", `${what} is missing.`, { hint });
  return v;
}
