// Per-run context: flags, the ~/.claudia home, lazily-built clients, guard rails and exit codes.
import type { Keypair } from "@useclaudia/sdk";
import { ClaudiaApiError, ClaudiaClient, ClaudiaConfigError, ClaudiaNetworkError, ClaudiaTxError, defaultRpcUrl, parseChain, type AgentMe, type ChainId, type PlatformConfig } from "@useclaudia/sdk";
import { ClaudiaHome } from "@useclaudia/sdk/node";
import { bool, str, type Parsed } from "./args.js";
import { KeyStore } from "./keystore.js";
import { accessToken } from "./oauth.js";
import { confirm, isInteractive, secret } from "./ui.js";

/**
 * Exit codes: 0 ok · 1 error · 2 bad usage · 3 refused (a safety check, a cap, or you said no) · 4 not set up /
 * not signed in / missing key or package · 5 rate limited · 130 interrupted (Ctrl-C).
 */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, REFUSED: 3, SETUP: 4, RATE_LIMITED: 5, INTERRUPTED: 130 } as const;

/** An error with a plain-English message, an exit code and an optional next step. */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class Ctx {
  readonly json: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly home: ClaudiaHome;
  private clientP?: Promise<ClaudiaClient>;
  private publicC?: ClaudiaClient;
  private platformP?: Promise<PlatformConfig>;
  private meP?: Promise<AgentMe>;
  private keysStore?: KeyStore;

  constructor(readonly parsed: Parsed) {
    const f = parsed.flags;
    this.json = bool(f, "json");
    this.yes = bool(f, "yes");
    this.dryRun = bool(f, "dry-run");
    const env = { ...process.env };
    const baseUrl = str(f, "base-url");
    if (baseUrl) env.CLAUDIA_BASE_URL = baseUrl;
    const rpc = str(f, "rpc-url");
    if (rpc) env.CLAUDIA_RPC_URL = rpc;
    const dir = str(f, "home");
    this.home = new ClaudiaHome({
      dir,
      env,
      askPassphrase: async () => (isInteractive() && !this.json ? secret("Passphrase for your Claudia keys:") : ""),
    });
  }

  /** The user's own provider keys (also the KeyProvider for media/social). */
  get keys(): KeyStore {
    this.keysStore ??= new KeyStore(this.home, async () => {
      if (process.env.CLAUDIA_PASSPHRASE) return process.env.CLAUDIA_PASSPHRASE;
      if (isInteractive() && !this.json) return secret("Passphrase for your Claudia keys:");
      throw new CliError(EXIT.SETUP, "passphrase_required", "Your keys are encrypted.", "Set CLAUDIA_PASSPHRASE or run this in a terminal.");
    });
    return this.keysStore;
  }

  /** OAuth access token from `claudia login` (refreshed when needed), or null. */
  oauthToken(): Promise<string | null> {
    return accessToken(this.home.dir, this.baseUrl);
  }

  get flags() {
    return this.parsed.flags;
  }
  get args() {
    return this.parsed.positionals;
  }
  get baseUrl(): string {
    return this.home.config().baseUrl;
  }

  /** Client with the agent's credentials (reads secrets — may ask for the passphrase). */
  client(): Promise<ClaudiaClient> {
    this.clientP ??= this.home.client();
    return this.clientP;
  }

  /** Client for public reads: never touches a secret, so it works on an encrypted home without the passphrase. */
  publicClient(): ClaudiaClient {
    this.publicC ??= new ClaudiaClient({ baseUrl: this.baseUrl, rpcUrl: this.home.config().rpcUrl });
    return this.publicC;
  }

  /** Client that can sign agent requests — or a SETUP error explaining what's missing. */
  async agentClient(): Promise<ClaudiaClient> {
    if (!this.home.devicePublicKey()) throw new CliError(EXIT.SETUP, "not_initialized", "This machine has no Claudia device key yet.", "Run: claudia init");
    if (!this.home.hasApiKey()) throw new CliError(EXIT.SETUP, "not_logged_in", "You're not logged in.", "Create your agent on useclaudia.xyz, register this device key, then run: claudia login <ck_live_…>");
    return this.client();
  }

  platform(): Promise<PlatformConfig> {
    this.platformP ??= this.publicClient().platform();
    return this.platformP;
  }

  me(): Promise<AgentMe> {
    this.meP ??= this.agentClient().then((c) => c.me());
    return this.meP;
  }

  async wallet(): Promise<Keypair> {
    const w = await this.home.walletKeypair();
    if (!w) throw new CliError(EXIT.SETUP, "no_wallet", "No agent wallet on this machine.", "Run: claudia init");
    return w;
  }

  async rpcUrl(): Promise<string> {
    const c = this.home.config();
    if (c.rpcUrl) return c.rpcUrl;
    return defaultRpcUrl((await this.platform()).network);
  }

  /** --chain sol|hood|bsc (default sol; "solana", "robinhood", "bnb" work too). A token key's prefix wins. */
  chain(tokenInput?: string): ChainId {
    const flag = str(this.flags, "chain");
    const fromKey = tokenInput && /^(sol|hood|bsc):/i.test(tokenInput) ? tokenInput.split(":", 1)[0].toLowerCase() : undefined;
    const fromAddr = !flag && !fromKey && tokenInput && /^0x[0-9a-fA-F]{40}$/.test(tokenInput) ? "hood" : undefined;
    return parseChain(fromKey ?? flag ?? fromAddr ?? "sol");
  }

  /** @useclaudia/sdk/evm (needs the optional viem package). */
  async evm(): Promise<typeof import("@useclaudia/sdk/evm")> {
    try {
      return await import("@useclaudia/sdk/evm");
    } catch {
      throw new CliError(EXIT.SETUP, "viem_missing", "Robinhood Chain signing needs the viem package.", "npm i -g viem   (next to @useclaudia/cli)");
    }
  }

  /** The EVM wallet's private key (Robinhood Chain), or a SETUP error. May ask for the passphrase. */
  async evmKey(): Promise<`0x${string}`> {
    const k = await this.home.evmPrivateKey();
    if (!k) throw new CliError(EXIT.SETUP, "no_evm_wallet", "No EVM wallet on this machine (needed for Robinhood Chain).", "claudia wallet evm create   (or: claudia wallet evm import)");
    return k;
  }

  async network(): Promise<"mainnet" | "testnet"> {
    return (await this.platform()).network;
  }

  /**
   * The last gate before anything irreversible. `--yes` passes; `--dry-run` never reaches here; without a terminal
   * the answer is "no".
   */
  async confirmOrRefuse(question: string, what = "this moves real funds"): Promise<void> {
    if (this.yes) return;
    if (!isInteractive() || this.json) {
      throw new CliError(EXIT.REFUSED, "confirmation_required", `Not confirmed: ${what}.`, "Re-run with --yes to confirm (or --dry-run to only preview).");
    }
    if (!(await confirm(question, false))) throw new CliError(EXIT.REFUSED, "cancelled", "Cancelled — nothing was sent.");
  }
}

/** Turns any thrown value into { exitCode, code, message, hint, extra }. */
export function describeError(e: unknown, ctx?: Ctx): { exitCode: number; code: string; message: string; hint?: string; extra: Record<string, unknown> } {
  if (e instanceof CliError) return { exitCode: e.exitCode, code: e.code, message: e.message, hint: e.hint, extra: e.extra };
  if ((e as { name?: string })?.name === "UsageError") return { exitCode: EXIT.USAGE, code: "usage", message: (e as Error).message, hint: "Run: claudia help", extra: {} };
  if (e instanceof ClaudiaApiError) {
    const extra: Record<string, unknown> = { status: e.status, ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) };
    const hint = apiHint(e, ctx);
    if (e.status === 429) return { exitCode: EXIT.RATE_LIMITED, code: e.code, message: e.message, hint, extra };
    if (e.status === 401) return { exitCode: EXIT.SETUP, code: e.code, message: e.message, hint, extra };
    return { exitCode: EXIT.ERROR, code: e.code, message: e.message, hint, extra };
  }
  if (e instanceof ClaudiaNetworkError) return { exitCode: EXIT.ERROR, code: e.code, message: e.message, hint: "Check your connection and the base URL (claudia doctor).", extra: {} };
  if (e instanceof ClaudiaConfigError && ["bad_token", "bad_input", "bad_chain", "chain_retired", "bad_key", "bad_address", "bad_launchpad"].includes(e.code)) {
    const hint = e.code === "bad_token" ? "Use a Solana mint (or sol:<mint>), a Robinhood token (hood:0x…), or claudia for $CLAUDIA" : e.code === "bad_chain" || e.code === "chain_retired" ? "Chains: sol (default), hood (Robinhood Chain, beta), bsc (coming soon). See: claudia chains" : undefined;
    return { exitCode: EXIT.USAGE, code: e.code, message: e.message, hint, extra: {} };
  }
  if (e instanceof ClaudiaConfigError && (e.code === "chain_coming_soon" || e.code === "chain_view_only")) {
    return { exitCode: EXIT.REFUSED, code: e.code, message: e.message, hint: "See what's open: claudia chains", extra: {} };
  }
  if (e instanceof ClaudiaConfigError && e.code === "no_websocket") return { exitCode: EXIT.SETUP, code: e.code, message: e.message, hint: "npm i -g ws   (or use Node 22+)", extra: {} };
  if (e instanceof ClaudiaConfigError) {
    const refused = ["cap_exceeded", "bad_amount", "wallet_mismatch", "wrong_chain"].includes(e.code);
    const setup = ["passphrase_required", "wrong_passphrase", "no_api_key", "no_device_key", "bad_file"].includes(e.code);
    const capHint = /ETH/.test(e.message) ? "Change caps with: claudia config set max-eth-per-trade <eth> / max-eth-per-day <eth>" : "Change caps with: claudia config set max-sol-per-trade <sol> / max-sol-per-day <sol>";
    return { exitCode: refused ? EXIT.REFUSED : setup ? EXIT.SETUP : EXIT.ERROR, code: e.code, message: e.message, hint: e.code === "cap_exceeded" ? capHint : undefined, extra: {} };
  }
  if (e instanceof ClaudiaTxError) {
    const hashes = (e as ClaudiaTxError & { hashes?: string[] }).hashes;
    return { exitCode: EXIT.ERROR, code: e.code, message: e.message, extra: { ...(e.signature ? { signature: e.signature } : {}), ...(hashes?.length ? { sent: hashes } : {}), ...(e.logs ? { logs: e.logs.slice(-12) } : {}) } };
  }
  const named = e as { name?: string; code?: string; hint?: string; message?: string; retryAfterMs?: number };
  if (named?.name === "ClaudiaMediaError" || named?.name === "ClaudiaSocialError") {
    const code = named.code ?? "provider_error";
    const exitCode =
      code === "no_key" ? EXIT.SETUP
      : code === "rate_limited" ? EXIT.RATE_LIMITED
      : ["over_budget", "needs_approval", "blocked", "expired"].includes(code) ? EXIT.REFUSED
      : code === "invalid" || code === "unsupported" ? EXIT.USAGE
      : EXIT.ERROR;
    const hint = named.hint ?? (code === "no_key" ? "Add your own key: claudia keys set <name>" : undefined);
    return { exitCode, code, message: named.message ?? code, hint, extra: named.retryAfterMs ? { retryAfterMs: named.retryAfterMs } : {} };
  }
  if ((e as { code?: string })?.code === "wrong_passphrase") return { exitCode: EXIT.SETUP, code: "wrong_passphrase", message: (e as Error).message, extra: {} };
  return { exitCode: EXIT.ERROR, code: "internal", message: (e as Error)?.message ?? String(e), extra: {} };
}

function apiHint(e: ClaudiaApiError, ctx?: Ctx): string | undefined {
  const pub = ctx?.home.devicePublicKey();
  switch (e.code) {
    case "invalid_key":
      return "That API key isn't known. Copy it again from your agent's console, then: claudia login <ck_live_…>";
    case "key_revoked":
      return "Make a new key in your agent's console (API keys) and log in again.";
    case "bad_signature":
      return `The API key belongs to a different device key. Register this device key instead: ${pub ?? "(run claudia init)"}`;
    case "stale_timestamp":
      return "Your computer's clock is off by more than 5 minutes. Fix the clock and retry (claudia doctor shows the skew).";
    case "coming_soon":
      return "The site is still in coming-soon mode. Try again when it opens.";
    case "passport_required":
      return "Register the agent's passport first: claudia passport";
    case "wallet_required":
      return "The agent has no wallet registered. Register it with the passport: claudia passport";
    case "rate_limited":
    case "daily_limit":
    case "owner_limit":
    case "ip_limit":
    case "network_limit":
    case "thread_busy":
      return e.retryAfter ? `Try again in ${e.retryAfter < 60 ? `${e.retryAfter} s` : `${Math.ceil(e.retryAfter / 60)} min`}.` : "Slow down and try again later.";
    case "tier_too_low":
      return "This room is for higher tiers. Post in a room your tier allows (claudia rooms).";
    case "llm_unavailable":
    case "llm_budget":
      return "Ask is busy on the server right now; try again later.";
    case "token_not_found":
      return "That coin isn't on the live board right now.";
    case "http_404":
      return e.path.startsWith("/api/insights") ? "No insights for that coin yet. Check the mint, or try: claudia token <mint>" : undefined;
    case "unauthorized":
      return "Sign in first: claudia login";
    default:
      return undefined;
  }
}
