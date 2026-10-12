// Public types for @useclaudia/social. The names in this file follow the shared Claudia v2 contract.

/** Where secrets come from. The host (Claudia Local, the CLI, your script) owns secret storage. */
export interface KeyProvider {
  get(name: string): Promise<string | null> | string | null;
}

export type NetworkId =
  | "x"
  | "telegram"
  | "discord"
  | "bluesky"
  | "mastodon"
  | "farcaster"
  | "nostr"
  | "linkedin"
  | "youtube"
  | "buffer"
  | "zernio"
  | "upload-post"
  | "instagram"
  | "facebook"
  | "threads"
  | "tiktok"
  | "pinterest";

/** Networks listed by `networks()` that have no connector (skip/later), with the reason. */
export type ListedOnlyId = "whatsapp" | "snapchat" | "reddit" | "zora" | "lemon8" | "weibo" | "douyin";

export type Tier = "direct" | "service" | "v2" | "later" | "skip";
export type AuthKind = "oauth-loopback" | "oauth-relay" | "key" | "service";

export interface NetworkCaps {
  text: boolean;
  image: boolean;
  video: boolean;
  thread: boolean;
  reply: boolean;
  dm: boolean;
  schedule: boolean;
  inbox: boolean;
}

export interface NetworkLimits {
  maxChars?: number;
  maxImages?: number;
  maxVideoMb?: number;
  /** Claudia's default daily cap per account (change it with `createSocial({ rules: { caps } })`). */
  perDay?: number;
}

export interface NetworkInfo {
  id: NetworkId;
  name: string;
  tier: Tier;
  auth: AuthKind;
  caps: NetworkCaps;
  limits: NetworkLimits;
  costHint?: string;
  /** Plain-English steps, including which redirect URI to register. */
  setup: string;
  /** Official docs the request shapes were checked against. */
  docs: string;
  /** Extra detail: scopes, key names, why a network is skipped. */
  scopes?: string[];
  keyNames?: string[];
  reason?: string;
  /** Networks reachable through this posting service (services only). */
  reaches?: string[];
}

/** Same shape as NetworkInfo, for networks that are listed but have no connector. */
export interface ListedNetworkInfo extends Omit<NetworkInfo, "id"> {
  id: ListedOnlyId;
}

export interface Account {
  /** Stable id, e.g. "bluesky:did:plc:abc…" or "telegram:-1001234". */
  id: string;
  network: NetworkId;
  handle: string;
  name?: string;
  avatar?: string;
  connectedAt: number;
  /** When the connection stops working unless it is refreshed or reconnected (LinkedIn: 60 days). */
  expiresAt?: number;
  /** The posting service this account goes through (Buffer, Zernio, Upload-Post). */
  via?: NetworkId;
  /** Raw platform name from a posting service ("instagram", "googlebusiness", …). */
  platform?: string;
  /** Account id of the service connection this channel belongs to. */
  parent?: string;
  /** Short facts worth showing in a UI (e.g. "bot flag off", "posts go out private"). */
  notes?: string[];
}

export interface MediaInput {
  /** Local file path, or an https URL. */
  path: string;
  mime?: string;
  alt?: string;
}

export interface PostInput {
  text: string;
  media?: MediaInput[];
  link?: string;
  /** Follow-up posts after `text` (a thread). Networks without threads get them joined or refuse. */
  thread?: string[];
  replyTo?: { network: NetworkId; id: string };
  targets: { account: string; text?: string /* per-network override */ }[];
  scheduleAt?: number;
  /** ai defaults to true. nfa is forced on when the text talks about a coin, ticker or price. */
  labels?: { ai?: boolean; ad?: boolean; nfa?: boolean };
  /** Network-specific extras, e.g. { youtube: { title, privacyStatus }, tiktok: { privacyLevel } }. */
  options?: Partial<Record<NetworkId, Record<string, unknown>>>;
}

export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "partial"
  | "failed"
  | "canceled";

export interface PostResult {
  account: string;
  network: NetworkId;
  status: "pending" | "published" | "failed";
  url?: string;
  remoteId?: string;
  error?: string;
  at?: number;
  /** Idempotency key for this (post, account). The same key is reused on every retry. */
  key?: string;
  /** Set when a send started but no answer came back (crash, dropped connection). It may be live. */
  uncertain?: boolean;
  /** Ids of every part sent so far (threads). A retry continues after the last one. */
  remoteIds?: string[];
  /** Normalized text hash (near-duplicate checks). */
  hash?: string;
  /** Whether the post carried a link (link-frequency checks). */
  hasLink?: boolean;
  /** First send attempt (unix ms). */
  startedAt?: number;
}

export interface Post {
  id: string;
  status: PostStatus;
  input: PostInput;
  createdAt: number;
  updatedAt: number;
  results: PostResult[];
  /** Why the post is where it is ("posting late?", reject reason, …). */
  note?: string;
  approvedAt?: number;
}

export interface Preview {
  account: string;
  network: NetworkId;
  text: string;
  chars: number;
  media: number;
  labelsAdded: string[];
  costUsd?: number;
  warnings: string[];
  blocked?: string;
  /** Follow-up thread parts after rules were applied. */
  thread?: string[];
}

export interface DryRunRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Which account/step this request belongs to. */
  label?: string;
}

export interface DryRunResult {
  dryRun: true;
  requests: DryRunRequest[];
}

export interface InboxItem {
  account: string;
  network: NetworkId;
  kind: "mention" | "reply" | "dm";
  id: string;
  from: string;
  text: string;
  at: number;
  url?: string;
}

/** Where OAuth tokens and connection secrets are kept. Default: AES-256-GCM file at <dataDir>/social/accounts.json. */
export interface TokenStore {
  load(): Promise<StoredAccount[]>;
  save(accounts: StoredAccount[]): Promise<void>;
}

export interface StoredAccount {
  account: Account;
  credentials: Record<string, unknown>;
}

export interface RuleOptions {
  /** Daily cap per account by network (published posts in the last 24 h). */
  caps?: Partial<Record<NetworkId, number>>;
  /** Posts carrying a link per account per 24 h. Default 5 (X: 3). */
  linksPerDay?: Partial<Record<NetworkId | "default", number>>;
  /** Near-duplicate window. Default 24 h. */
  duplicateWindowMs?: number;
  /** Text added when a network has no native AI label. Default "(AI-generated)". */
  disclosureText?: string;
  /** Text added when the post talks about coins/prices. Default "Not financial advice." */
  nfaText?: string;
  /** Minutes after which a missed schedule goes back to approval instead of posting. Default 10. */
  lateAfterMin?: number;
}

export interface InboxBudget {
  /** Read requests per account per UTC day. X default 0 (reads cost money); others 200. */
  perDay?: number;
}

export interface MediaRelayOptions {
  /** POST endpoint. Default https://useclaudia.xyz/relay/media */
  url: string;
  /** Sent as `Authorization: Bearer <token>`: an OAuth access token from `claudia login`, or a Claudia agent key (ck_live_…). */
  token: () => Promise<string | null>;
  /**
   * Extra request-signature headers (needed with an agent key: the site's X-Claudia-* scheme, same as /api/v1).
   * `path` is the URL path including the query string (e.g. "/relay/media?ttl=15"); `body` is the exact raw bytes
   * sent (the multipart body for uploads, empty for DELETE). Return the headers to add.
   */
  sign?: (req: { method: string; path: string; body: Uint8Array }) => Promise<Record<string, string>>;
  /** Minutes the public link lives. Default 15, max 60. */
  ttlMin?: number;
}

export interface SocialOptions {
  keys: KeyProvider;
  dataDir?: string;
  fetch?: typeof fetch;
  dryRun?: boolean;
  /** Loopback port of the host's OAuth callback server. Default 3939 (Claudia Local). */
  loopbackPort?: number;
  /** Default https://useclaudia.xyz/relay/oauth/callback */
  relayUrl?: string;
  mediaRelay?: MediaRelayOptions;
  /** Where tokens go. Default: encrypted <dataDir>/social/accounts.json (needs key "social-vault"). */
  tokens?: TokenStore;
  rules?: RuleOptions;
  inboxBudget?: Partial<Record<NetworkId, InboxBudget>>;
  /** WebSocket constructor for Nostr (default: global WebSocket, or a small built-in client). */
  WebSocket?: unknown;
  /** Clock override (dry runs). */
  now?: () => number;
}

export type SocialEvent = "post" | "account" | "audit" | "warning";

export interface Social {
  networks(): (NetworkInfo | ListedNetworkInfo)[];
  connect(
    network: NetworkId,
    params?: Record<string, string>,
    opts?: { dryRun?: boolean },
  ): Promise<Account | { authorizeUrl: string; state: string; redirectUri: string } | DryRunResult>;
  completeOAuth(state: string, code: string): Promise<Account>;
  disconnect(accountId: string): Promise<void>;
  accounts(): Account[];
  draft(input: PostInput): Post;
  update(id: string, input: Partial<PostInput>): Post;
  preview(id: string): Preview[];
  submit(id: string): Post;
  approve(id: string): Post;
  reject(id: string, why?: string): Post;
  schedule(id: string, at: number): Post;
  publish(id: string, opts?: { dryRun?: boolean; retryUncertain?: boolean }): Promise<Post | DryRunResult>;
  posts(f?: { status?: PostStatus; limit?: number }): Post[];
  getPost(id: string): Post | null;
  inbox(opts?: { since?: number; accounts?: string[] }): Promise<InboxItem[]>;
  reply(account: string, to: string, text: string, opts?: { dryRun?: boolean }): Promise<unknown>;
  killSwitch(on?: boolean): boolean;
  on(ev: SocialEvent, cb: (x: any) => void): void;
  off(ev: SocialEvent, cb: (x: any) => void): void;
  tick(): Promise<void>;
  /** Resolves when accounts and posts are loaded from disk. Every async method awaits it. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
