// ~/.claudia — the local agent home shared by the CLI and the MCP server (Node only).
//
//   ~/.claudia/              0700
//     config.json            0600  base URL, RPC, caps, cached agent profile (no secrets)
//     device.json            0600  device key (signs API requests)          — optionally passphrase-encrypted
//     wallet.json            0600  agent wallet (signs Solana transactions) — optionally passphrase-encrypted
//     evm-wallet.json        0600  EVM wallet (signs Robinhood Chain txs)   — same encryption as wallet.json
//     credentials.json       0600  API key (+ optional OpenRouter key)      — optionally passphrase-encrypted
//     spend.json             0600  local daily SOL spend ledger (enforces maxSolPerDay across CLI + MCP)
//
// Override the location with CLAUDIA_HOME. Env overrides (CLAUDIA_BASE_URL, CLAUDIA_API_KEY, CLAUDIA_DEVICE_KEY,
// CLAUDIA_WALLET_KEY, CLAUDIA_EVM_KEY, CLAUDIA_RPC_URL, CLAUDIA_HOOD_RPC_URL, CLAUDIA_PASSPHRASE,
// CLAUDIA_MAX_SOL_PER_TRADE, CLAUDIA_MAX_SOL_PER_DAY, CLAUDIA_MAX_ETH_PER_TRADE, CLAUDIA_MAX_ETH_PER_DAY,
// OPENROUTER_API_KEY) win over files.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Keypair } from "@solana/web3.js";
import { ClaudiaClient, type ClaudiaClientOptions } from "../client.js";
import { ClaudiaConfigError } from "../errors.js";
import { DEFAULT_BASE_URL } from "../http.js";
import { generateDeviceKey, generateWallet, publicKeyOf, toKeypair } from "../keys.js";
import { evmAddressOf, generateEvmWallet, normalizeEvmKey } from "../evm-keys.js";
import type { ChainId } from "../types.js";
import { toBase58, type SecretInput } from "../encoding.js";
import { isSealed, open, seal, type SealedBox } from "./crypto-box.js";

export interface Caps {
  /** Largest single buy / dev buy, in SOL. */
  maxSolPerTrade: number;
  /** Total SOL spent per UTC day across buys, dev buys and launches. */
  maxSolPerDay: number;
  /** Robinhood Chain: largest single buy / dev buy, in ETH. */
  maxEthPerTrade: number;
  /** Robinhood Chain: total ETH spent per UTC day. */
  maxEthPerDay: number;
}

export const DEFAULT_CAPS: Caps = { maxSolPerTrade: 0.05, maxSolPerDay: 0.2, maxEthPerTrade: 0.01, maxEthPerDay: 0.04 };

export interface ClaudiaConfig {
  version: 1;
  baseUrl: string;
  rpcUrl?: string;
  /** Robinhood Chain RPC (default: the public one). */
  hoodRpcUrl?: string;
  caps: Caps;
  /** Cached from /api/v1/me after login (display only — the server is the source of truth). */
  agent?: { id: string; slug: string; name: string; wallet?: string | null; tier?: string };
  llm?: { model?: string };
  createdAt: string;
  updatedAt?: string;
}

interface KeyFile {
  type: "claudia-device-key" | "claudia-wallet" | "claudia-evm-wallet";
  version: 1;
  publicKey: string;
  secretKey?: string;
  encrypted?: SealedBox;
  createdAt: string;
}

interface CredentialsFile {
  type: "claudia-credentials";
  version: 1;
  apiKey?: string;
  openrouterKey?: string;
  encrypted?: SealedBox;
}

interface SpendEntry {
  at: string;
  kind: string;
  sol: number;
  chain?: ChainId;
  /** Amount in the chain's native coin (ETH on Robinhood); `sol` mirrors it on Solana. */
  native?: number;
  token?: string;
  signatures?: string[];
}

interface SpendFile {
  days: Record<string, { sol: number; eth?: number; entries: SpendEntry[] }>;
}

export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDIA_HOME?.trim() || join(homedir(), ".claudia");
}

export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    /* not ours to fix (e.g. Windows) */
  }
}

/** Atomic 0600 write (tmp file + rename). */
export function writePrivateJson(file: string, data: unknown): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    throw new ClaudiaConfigError("bad_file", `${file} is not valid JSON: ${(e as Error).message}`);
  }
}

const today = (d = new Date()) => d.toISOString().slice(0, 10);
const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

export interface HomeOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Passphrase for encrypted secrets (default: CLAUDIA_PASSPHRASE). */
  passphrase?: string;
  /** Asked when a secret is encrypted and no passphrase is known yet. */
  askPassphrase?: () => Promise<string>;
}

export class ClaudiaHome {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  private passphrase?: string;
  private askPassphrase?: () => Promise<string>;

  constructor(opts: HomeOptions = {}) {
    this.env = opts.env ?? process.env;
    this.dir = opts.dir ?? defaultHomeDir(this.env);
    this.passphrase = opts.passphrase ?? (this.env.CLAUDIA_PASSPHRASE || undefined);
    this.askPassphrase = opts.askPassphrase;
  }

  get paths() {
    return {
      dir: this.dir,
      config: join(this.dir, "config.json"),
      device: join(this.dir, "device.json"),
      wallet: join(this.dir, "wallet.json"),
      evmWallet: join(this.dir, "evm-wallet.json"),
      credentials: join(this.dir, "credentials.json"),
      spend: join(this.dir, "spend.json"),
    };
  }

  exists(): boolean {
    return existsSync(this.paths.config);
  }

  setPassphrase(p: string | undefined): void {
    this.passphrase = p || undefined;
  }

  private async getPassphrase(what: string): Promise<string> {
    if (this.passphrase) return this.passphrase;
    if (this.askPassphrase) {
      this.passphrase = await this.askPassphrase();
      if (this.passphrase) return this.passphrase;
    }
    throw new ClaudiaConfigError("passphrase_required", `The ${what} is encrypted. Set CLAUDIA_PASSPHRASE or run interactively.`);
  }

  // ─── config ─────────────────────────────────────────────────────

  readConfig(): ClaudiaConfig | undefined {
    return readJson<ClaudiaConfig>(this.paths.config);
  }

  /** Config with env overrides and defaults applied. */
  config(): ClaudiaConfig {
    const c = this.readConfig() ?? { version: 1 as const, baseUrl: DEFAULT_BASE_URL, caps: { ...DEFAULT_CAPS }, createdAt: new Date().toISOString() };
    const caps = { ...DEFAULT_CAPS, ...(c.caps ?? {}) };
    const t = num(this.env.CLAUDIA_MAX_SOL_PER_TRADE);
    const d = num(this.env.CLAUDIA_MAX_SOL_PER_DAY);
    const et = num(this.env.CLAUDIA_MAX_ETH_PER_TRADE);
    const ed = num(this.env.CLAUDIA_MAX_ETH_PER_DAY);
    if (t !== undefined) caps.maxSolPerTrade = t;
    if (d !== undefined) caps.maxSolPerDay = d;
    if (et !== undefined) caps.maxEthPerTrade = et;
    if (ed !== undefined) caps.maxEthPerDay = ed;
    return {
      ...c,
      baseUrl: (this.env.CLAUDIA_BASE_URL?.trim() || c.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      rpcUrl: this.env.CLAUDIA_RPC_URL?.trim() || c.rpcUrl,
      hoodRpcUrl: this.env.CLAUDIA_HOOD_RPC_URL?.trim() || c.hoodRpcUrl,
      caps,
    };
  }

  writeConfig(patch: Partial<ClaudiaConfig>): ClaudiaConfig {
    const cur = this.readConfig() ?? { version: 1 as const, baseUrl: DEFAULT_BASE_URL, caps: { ...DEFAULT_CAPS }, createdAt: new Date().toISOString() };
    const next: ClaudiaConfig = { ...cur, ...patch, caps: { ...cur.caps, ...(patch.caps ?? {}) }, version: 1, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(next) as (keyof ClaudiaConfig)[]) if (next[k] === undefined) delete next[k];
    writePrivateJson(this.paths.config, next);
    return next;
  }

  // ─── keys ───────────────────────────────────────────────────────

  private writeKey(file: string, type: KeyFile["type"], secretB58: string, passphrase?: string): string {
    const publicKey = publicKeyOf(secretB58);
    const f: KeyFile = { type, version: 1, publicKey, createdAt: new Date().toISOString() };
    if (passphrase) f.encrypted = seal(secretB58, passphrase, `${type}:${publicKey}`);
    else f.secretKey = secretB58;
    writePrivateJson(file, f);
    return publicKey;
  }

  private keyPublic(file: string): string | undefined {
    return readJson<KeyFile>(file)?.publicKey;
  }

  private async keySecret(file: string, what: string): Promise<string | undefined> {
    const f = readJson<KeyFile>(file);
    if (!f) return undefined;
    let secret = f.secretKey;
    if (!secret && f.encrypted) secret = open(f.encrypted, await this.getPassphrase(what), `${f.type}:${f.publicKey}`);
    if (!secret) throw new ClaudiaConfigError("bad_file", `${file} has no key`);
    if (publicKeyOf(secret) !== f.publicKey) throw new ClaudiaConfigError("bad_file", `${file}: the secret doesn't match its public key`);
    return secret;
  }

  isEncrypted(): boolean {
    return !!(readJson<KeyFile>(this.paths.device)?.encrypted || readJson<KeyFile>(this.paths.wallet)?.encrypted || readJson<KeyFile>(this.paths.evmWallet)?.encrypted);
  }

  // ─── EVM wallet (Robinhood Chain) ───────────────────────────────

  /**
   * Creates evm-wallet.json next to the Solana wallet (or imports `importKey`). Encrypted with the same passphrase
   * when the home is encrypted. Refuses to overwrite unless `force`. Returns the address only.
   */
  async createEvmWallet(opts: { importKey?: string; force?: boolean; passphrase?: string } = {}): Promise<{ address: string }> {
    ensurePrivateDir(this.dir);
    const file = this.paths.evmWallet;
    if (!opts.force && existsSync(file)) {
      throw new ClaudiaConfigError("already_initialized", `An EVM wallet already exists in ${this.dir} (use --force to replace it — the old one is lost unless you backed it up)`);
    }
    const key = opts.importKey ? normalizeEvmKey(opts.importKey) : generateEvmWallet().privateKey;
    if (opts.passphrase) this.passphrase = opts.passphrase;
    const passphrase = this.isEncrypted() || opts.passphrase ? await this.getPassphrase("EVM wallet") : undefined;
    const address = evmAddressOf(key);
    const f: KeyFile = { type: "claudia-evm-wallet", version: 1, publicKey: address, createdAt: new Date().toISOString() };
    if (passphrase) f.encrypted = seal(key, passphrase, `claudia-evm-wallet:${address}`);
    else f.secretKey = key;
    writePrivateJson(file, f);
    return { address };
  }

  /** The EVM wallet's address (env CLAUDIA_EVM_KEY wins), or undefined. Never needs the passphrase. */
  evmAddress(): string | undefined {
    const e = this.env.CLAUDIA_EVM_KEY?.trim();
    return e ? evmAddressOf(e) : readJson<KeyFile>(this.paths.evmWallet)?.publicKey;
  }

  /** The EVM private key (0x hex). May ask for the passphrase. Keep it in memory only. */
  async evmPrivateKey(): Promise<`0x${string}` | undefined> {
    const e = this.env.CLAUDIA_EVM_KEY?.trim();
    if (e) return normalizeEvmKey(e);
    const f = readJson<KeyFile>(this.paths.evmWallet);
    if (!f) return undefined;
    let secret = f.secretKey;
    if (!secret && f.encrypted) secret = open(f.encrypted, await this.getPassphrase("EVM wallet"), `${f.type}:${f.publicKey}`);
    if (!secret) throw new ClaudiaConfigError("bad_file", `${this.paths.evmWallet} has no key`);
    const key = normalizeEvmKey(secret);
    if (evmAddressOf(key) !== f.publicKey) throw new ClaudiaConfigError("bad_file", `${this.paths.evmWallet}: the key doesn't match its address`);
    return key;
  }

  /** Creates device.json and wallet.json (refuses to overwrite unless `force`). */
  createKeys(opts: { passphrase?: string; force?: boolean; importWallet?: SecretInput; importDevice?: SecretInput } = {}): { devicePublicKey: string; walletAddress: string } {
    ensurePrivateDir(this.dir);
    const p = this.paths;
    if (!opts.force && (existsSync(p.device) || existsSync(p.wallet))) {
      throw new ClaudiaConfigError("already_initialized", `Keys already exist in ${this.dir} (use --force to replace them — the old wallet is lost unless you backed it up)`);
    }
    const device = opts.importDevice ? toBase58(toKeypair(opts.importDevice).secretKey) : generateDeviceKey().secretKey;
    const wallet = opts.importWallet ? toBase58(toKeypair(opts.importWallet).secretKey) : generateWallet().secretKey;
    if (opts.passphrase) this.passphrase = opts.passphrase;
    const devicePublicKey = this.writeKey(p.device, "claudia-device-key", device, opts.passphrase);
    const walletAddress = this.writeKey(p.wallet, "claudia-wallet", wallet, opts.passphrase);
    return { devicePublicKey, walletAddress };
  }

  devicePublicKey(): string | undefined {
    const e = this.env.CLAUDIA_DEVICE_KEY?.trim();
    return e ? publicKeyOf(e) : this.keyPublic(this.paths.device);
  }

  walletAddress(): string | undefined {
    const e = this.env.CLAUDIA_WALLET_KEY?.trim();
    return e ? publicKeyOf(e) : this.keyPublic(this.paths.wallet);
  }

  async deviceSecret(): Promise<string | undefined> {
    return this.env.CLAUDIA_DEVICE_KEY?.trim() || (await this.keySecret(this.paths.device, "device key"));
  }

  async walletKeypair(): Promise<Keypair | undefined> {
    const s = this.env.CLAUDIA_WALLET_KEY?.trim() || (await this.keySecret(this.paths.wallet, "wallet"));
    return s ? toKeypair(s) : undefined;
  }

  // ─── credentials ────────────────────────────────────────────────

  private async credentials(): Promise<{ apiKey?: string; openrouterKey?: string }> {
    const f = readJson<CredentialsFile>(this.paths.credentials);
    if (!f) return {};
    if (f.encrypted) return JSON.parse(open(f.encrypted, await this.getPassphrase("API key"), "claudia-credentials")) as { apiKey?: string; openrouterKey?: string };
    return { apiKey: f.apiKey, openrouterKey: f.openrouterKey };
  }

  hasApiKey(): boolean {
    if (this.env.CLAUDIA_API_KEY?.trim()) return true;
    const f = readJson<CredentialsFile>(this.paths.credentials);
    return !!(f?.apiKey || f?.encrypted);
  }

  async apiKey(): Promise<string | undefined> {
    return this.env.CLAUDIA_API_KEY?.trim() || (await this.credentials()).apiKey;
  }

  async openrouterKey(): Promise<string | undefined> {
    return this.env.OPENROUTER_API_KEY?.trim() || (await this.credentials()).openrouterKey;
  }

  /** Writes credentials, encrypting them when the keys are encrypted (same passphrase). */
  async saveCredentials(patch: { apiKey?: string | null; openrouterKey?: string | null }): Promise<void> {
    const cur = existsSync(this.paths.credentials) ? await this.credentials() : {};
    const next: { apiKey?: string; openrouterKey?: string } = { ...cur };
    for (const k of ["apiKey", "openrouterKey"] as const) {
      if (patch[k] === null) delete next[k];
      else if (patch[k] !== undefined) next[k] = patch[k] as string;
    }
    if (!next.apiKey && !next.openrouterKey) {
      rmSync(this.paths.credentials, { force: true });
      return;
    }
    const f: CredentialsFile = { type: "claudia-credentials", version: 1 };
    if (this.isEncrypted()) f.encrypted = seal(JSON.stringify(next), await this.getPassphrase("API key"), "claudia-credentials");
    else Object.assign(f, next);
    writePrivateJson(this.paths.credentials, f);
  }

  // ─── client ─────────────────────────────────────────────────────

  /** A ClaudiaClient with this home's base URL, API key and device key (whatever is available). */
  async client(extra: ClaudiaClientOptions = {}): Promise<ClaudiaClient> {
    const c = this.config();
    const [apiKey, deviceKey] = await Promise.all([this.apiKey(), this.deviceSecret()]);
    return new ClaudiaClient({ baseUrl: c.baseUrl, rpcUrl: c.rpcUrl, apiKey, deviceKey, ...extra });
  }

  // ─── spend ledger + caps ────────────────────────────────────────

  /** Spent today (UTC) on a chain, in its native coin: SOL on Solana (default), ETH on Robinhood. */
  spentToday(chain: ChainId = "sol"): number {
    const day = readJson<SpendFile>(this.paths.spend)?.days?.[today()];
    return Number((chain === "sol" ? day?.sol : chain === "hood" ? day?.eth : 0) ?? 0);
  }

  /** Adds to today's ledger. Solana: `sol`. Robinhood: `chain: "hood"` + `native` (ETH). */
  recordSpend(entry: { kind: string; sol?: number; chain?: ChainId; native?: number; token?: string; signatures?: string[] }): void {
    const f = readJson<SpendFile>(this.paths.spend) ?? { days: {} };
    const d = today();
    const day = f.days[d] ?? { sol: 0, entries: [] };
    const chain = entry.chain ?? "sol";
    const amount = Math.max(0, Number(chain === "sol" ? entry.sol ?? entry.native ?? 0 : entry.native ?? 0));
    if (chain === "sol") day.sol = Math.round((day.sol + amount) * 1e9) / 1e9;
    else if (chain === "hood") day.eth = Math.round(((day.eth ?? 0) + amount) * 1e12) / 1e12;
    day.entries.push({ at: new Date().toISOString(), ...entry, sol: chain === "sol" ? amount : 0, ...(chain !== "sol" ? { chain, native: amount } : {}) });
    f.days[d] = day;
    for (const k of Object.keys(f.days).sort().slice(0, -14)) delete f.days[k];
    writePrivateJson(this.paths.spend, f);
  }

  /** Throws `ClaudiaConfigError("cap_exceeded")` when spending `sol` now would break a cap. */
  checkCaps(amount: number, caps: Caps = this.config().caps, chain: ChainId = "sol"): { spentToday: number; leftToday: number } {
    return checkCaps(amount, caps, this.spentToday(chain), chain);
  }

  /** Removes the API key (keys + wallet stay). */
  async logout(): Promise<void> {
    if (existsSync(this.paths.credentials)) await this.saveCredentials({ apiKey: null });
    const c = this.readConfig();
    if (c) {
      delete c.agent;
      writePrivateJson(this.paths.config, c);
    }
  }
}

/** Pure cap check (shared by CLI and MCP). Solana caps in SOL; Robinhood (`chain: "hood"`) caps in ETH. */
export function checkCaps(amount: number, caps: Caps, spentToday: number, chain: ChainId = "sol"): { spentToday: number; leftToday: number } {
  if (chain === "bsc") throw new ClaudiaConfigError("chain_coming_soon", "BNB Chain is coming soon on Claudia.");
  const unit = chain === "hood" ? "ETH" : "SOL";
  const perTrade = chain === "hood" ? caps.maxEthPerTrade ?? DEFAULT_CAPS.maxEthPerTrade : caps.maxSolPerTrade;
  const perDay = chain === "hood" ? caps.maxEthPerDay ?? DEFAULT_CAPS.maxEthPerDay : caps.maxSolPerDay;
  if (!Number.isFinite(amount) || amount < 0) throw new ClaudiaConfigError("bad_amount", `Amount must be a positive number of ${unit}`);
  if (amount > perTrade + 1e-12) {
    throw new ClaudiaConfigError("cap_exceeded", `${amount} ${unit} is over your per-trade cap of ${perTrade} ${unit}`);
  }
  const left = Math.max(0, perDay - spentToday);
  if (amount > left + 1e-12) {
    throw new ClaudiaConfigError("cap_exceeded", `${amount} ${unit} would go over your daily cap of ${perDay} ${unit} (spent today: ${round(spentToday)} ${unit}, left: ${round(left)} ${unit})`);
  }
  return { spentToday, leftToday: left };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Unix mode bits of a path (or undefined). */
export function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
