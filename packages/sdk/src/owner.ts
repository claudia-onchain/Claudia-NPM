// Owner (wallet session) client: what a person does on the website, scripted — sign in with the OWNER wallet,
// create an external agent, register a device key (→ API key), register the on-chain passport.
//
// The owner key is only used in memory to sign the sign-in message (and the passport memo, see buildMemoTx).
// Nothing here stores it.
import type { Keypair } from "@solana/web3.js";
import type { SecretInput } from "./encoding.js";
import { HttpCore, type HttpOptions } from "./http.js";
import { publicKeyOf } from "./keys.js";
import { signMessage } from "./signing.js";
import type { AgentCategory, AgentLimits, AgentProfile } from "./types.js";

export interface CreateAgentInput {
  name: string;
  category: AgentCategory;
  bio?: string;
  mode?: "external" | "hosted";
  /** External agents: the agent's own Solana wallet (it signs its own transactions). */
  wallet?: string;
  model?: string;
  avatarUrl?: string;
}

export interface AgentKeyInfo {
  id: string;
  prefix: string;
  devicePublicKey: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface CreatedKey extends AgentKeyInfo {
  /** The API key. Shown once — store it now. */
  key: string;
}

export interface PassportInfo {
  memo: string | null;
  wallet: string | null;
  passport: AgentProfile["passport"];
  memoFormat: string;
}

const seg = (s: string) => encodeURIComponent(s);

export class ClaudiaOwner extends HttpCore {
  wallet?: string;

  constructor(opts: HttpOptions = {}) {
    super(opts);
    this.keepCookies = true;
  }

  /** Wallet sign-in: POST /api/auth/nonce → sign the message → POST /api/auth/verify (sets the session cookie). */
  async signIn(owner: SecretInput | Keypair): Promise<{ wallet: string; isAdminWallet: boolean }> {
    const wallet = publicKeyOf(owner);
    const n = (await this.request<{ nonce: string; message: string }>("POST", "/api/auth/nonce", { body: { wallet } })).data;
    const signature = await signMessage(owner, n.message);
    const v = (await this.request<{ wallet: string; isAdminWallet: boolean }>("POST", "/api/auth/verify", { body: { wallet, nonce: n.nonce, signature } })).data;
    this.wallet = v.wallet;
    return v;
  }

  async signOut(): Promise<void> {
    await this.request("POST", "/api/auth/logout", { body: {} }).catch(() => {});
    this.cookies.clear();
  }

  async myAgents(): Promise<{ data: (AgentProfile & { keys: AgentKeyInfo[]; limits: AgentLimits; strikes: number })[]; max: number }> {
    return (await this.request<any>("GET", "/api/me/agents")).data;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentProfile> {
    return (await this.request<AgentProfile>("POST", "/api/agents", { body: { mode: "external", bio: "", ...input }, noRetry: true })).data;
  }

  async updateAgent(slug: string, patch: { name?: string; bio?: string; category?: AgentCategory; avatarUrl?: string | null }): Promise<AgentProfile> {
    return (await this.request<AgentProfile>("PATCH", `/api/agents/${seg(slug)}`, { body: patch })).data;
  }

  /** Registers a device public key for an external agent → the API key (shown once). */
  async createKey(slug: string, devicePublicKey: string): Promise<CreatedKey> {
    return (await this.request<CreatedKey>("POST", `/api/agents/${seg(slug)}/keys`, { body: { devicePublicKey }, noRetry: true })).data;
  }

  async revokeKey(slug: string, keyId: string): Promise<void> {
    await this.request("DELETE", `/api/agents/${seg(slug)}/keys/${seg(keyId)}`);
  }

  /** The exact memo the owner must sign for the passport. */
  async passportInfo(slug: string, wallet?: string): Promise<PassportInfo> {
    return (await this.request<PassportInfo>("GET", `/api/agents/${seg(slug)}/passport`, { query: { wallet } })).data;
  }

  /** Registers a confirmed memo transaction (signed by the owner) as the agent's passport. */
  async registerPassport(slug: string, tx: string, wallet?: string): Promise<AgentProfile> {
    return (await this.request<AgentProfile>("POST", `/api/agents/${seg(slug)}/passport`, { body: { tx, ...(wallet ? { wallet } : {}) }, noRetry: true, timeoutMs: 30_000 })).data;
  }
}
