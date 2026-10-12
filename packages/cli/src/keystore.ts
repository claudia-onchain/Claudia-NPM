// The user's own provider keys (model providers, media, socials, notifications), kept on this machine only:
// <home>/keys.json, mode 0600, sealed with the same passphrase as the Claudia keys when the home is encrypted.
// This is the KeyProvider the CLI hands to @useclaudia/media and @useclaudia/social. Env vars win over the file:
// CLAUDIA_KEY_<NAME> (e.g. CLAUDIA_KEY_OPENAI), then each provider's usual variable (OPENAI_API_KEY, …).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openSealed, seal, writePrivateJson, type ClaudiaHome, type SealedBox } from "@useclaudia/sdk/node";

export interface KeyProvider {
  get(name: string): Promise<string | null> | string | null;
}

/** Known key names → what they're for and the usual env var. Any other name is allowed too. */
export const KNOWN_KEYS: Record<string, { what: string; env?: string[]; group: "models" | "media" | "social" | "notify" }> = {
  openrouter: { what: "OpenRouter (any model, one key)", env: ["OPENROUTER_API_KEY"], group: "models" },
  openai: { what: "OpenAI", env: ["OPENAI_API_KEY"], group: "models" },
  anthropic: { what: "Anthropic", env: ["ANTHROPIC_API_KEY"], group: "models" },
  xai: { what: "xAI (Grok)", env: ["XAI_API_KEY"], group: "models" },
  qwen: { what: "Alibaba Model Studio (Qwen)", env: ["DASHSCOPE_API_KEY"], group: "models" },
  deepseek: { what: "DeepSeek", env: ["DEEPSEEK_API_KEY"], group: "models" },
  kimi: { what: "Moonshot (Kimi)", env: ["MOONSHOT_API_KEY"], group: "models" },
  google: { what: "Google AI (Gemini, Veo, Imagen)", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], group: "media" },
  fal: { what: "fal.ai", env: ["FAL_KEY"], group: "media" },
  elevenlabs: { what: "ElevenLabs (voice, music, sound)", env: ["ELEVENLABS_API_KEY"], group: "media" },
  heygen: { what: "HeyGen (avatars)", env: ["HEYGEN_API_KEY"], group: "media" },
  runway: { what: "Runway", env: ["RUNWAYML_API_SECRET"], group: "media" },
  byteplus: { what: "BytePlus (Seedance, Seedream)", env: ["ARK_API_KEY"], group: "media" },
  x: { what: "X developer app", group: "social" },
  telegram: { what: "Telegram bot token (posting + --notify telegram)", env: ["TELEGRAM_BOT_TOKEN"], group: "social" },
  "telegram-chat": { what: "Telegram chat id for --notify telegram", env: ["TELEGRAM_CHAT_ID"], group: "notify" },
  discord: { what: "Discord bot token", env: ["DISCORD_BOT_TOKEN"], group: "social" },
  "discord-webhook": { what: "Discord webhook URL for --notify discord", env: ["DISCORD_WEBHOOK_URL"], group: "notify" },
  webhook: { what: "Your webhook URL for --notify webhook", group: "notify" },
  bluesky: { what: "Bluesky app password", group: "social" },
  mastodon: { what: "Mastodon access token", group: "social" },
  neynar: { what: "Neynar (Farcaster)", env: ["NEYNAR_API_KEY"], group: "social" },
  linkedin: { what: "LinkedIn developer app", group: "social" },
  youtube: { what: "YouTube / Google developer app", group: "social" },
  buffer: { what: "Buffer", group: "social" },
  zernio: { what: "Zernio", group: "social" },
  "upload-post": { what: "Upload-Post", group: "social" },
};

export const normalizeKeyName = (n: string) => n.trim().toLowerCase().replace(/[_\s]+/g, "-");
export const envNameOf = (n: string) => `CLAUDIA_KEY_${normalizeKeyName(n).replace(/-/g, "_").toUpperCase()}`;

interface KeysFile {
  type: "claudia-keys";
  version: 1;
  keys?: Record<string, { value: string; addedAt: string }>;
  encrypted?: SealedBox;
}

export class KeyStore implements KeyProvider {
  readonly file: string;
  private cache?: Record<string, { value: string; addedAt: string }>;

  constructor(
    private readonly home: ClaudiaHome,
    private readonly passphrase: () => Promise<string>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(home.dir, "keys.json");
  }

  private raw(): KeysFile | undefined {
    if (!existsSync(this.file)) return undefined;
    return JSON.parse(readFileSync(this.file, "utf8")) as KeysFile;
  }

  /** True when the file is sealed (reading it needs the passphrase). */
  isSealed(): boolean {
    return !!this.raw()?.encrypted;
  }

  private async load(): Promise<Record<string, { value: string; addedAt: string }>> {
    if (this.cache) return this.cache;
    const f = this.raw();
    if (!f) return (this.cache = {});
    if (f.encrypted) this.cache = JSON.parse(openSealed(f.encrypted, await this.passphrase(), "claudia-keys")) as Record<string, { value: string; addedAt: string }>;
    else this.cache = f.keys ?? {};
    return this.cache;
  }

  private async save(keys: Record<string, { value: string; addedAt: string }>): Promise<void> {
    this.cache = keys;
    if (!Object.keys(keys).length) {
      rmSync(this.file, { force: true });
      return;
    }
    const f: KeysFile = { type: "claudia-keys", version: 1 };
    if (this.home.isEncrypted()) f.encrypted = seal(JSON.stringify(keys), await this.passphrase(), "claudia-keys");
    else f.keys = keys;
    writePrivateJson(this.file, f);
  }

  /** Where a key comes from right now (env wins over the file). */
  async source(name: string): Promise<{ value: string; from: string } | null> {
    const n = normalizeKeyName(name);
    const own = this.env[envNameOf(n)]?.trim();
    if (own) return { value: own, from: envNameOf(n) };
    for (const e of KNOWN_KEYS[n]?.env ?? []) {
      const v = this.env[e]?.trim();
      if (v) return { value: v, from: e };
    }
    const keys = await this.load();
    if (keys[n]?.value) return { value: keys[n].value, from: "keys.json" };
    if (n === "openrouter") {
      const legacy = await this.home.openrouterKey().catch(() => undefined);
      if (legacy) return { value: legacy, from: "credentials.json" };
    }
    return null;
  }

  async get(name: string): Promise<string | null> {
    return (await this.source(name))?.value ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    const keys = { ...(await this.load()) };
    keys[normalizeKeyName(name)] = { value: value.trim(), addedAt: new Date().toISOString() };
    await this.save(keys);
  }

  async remove(name: string): Promise<boolean> {
    const keys = { ...(await this.load()) };
    const n = normalizeKeyName(name);
    if (!keys[n]) return false;
    delete keys[n];
    await this.save(keys);
    return true;
  }

  /** Every key known from the file or the environment (values included — mask before printing). */
  async list(): Promise<{ name: string; value: string; from: string; addedAt?: string }[]> {
    const keys = await this.load();
    const names = new Set<string>([...Object.keys(keys), ...Object.keys(KNOWN_KEYS)]);
    for (const k of Object.keys(this.env)) if (k.startsWith("CLAUDIA_KEY_") && this.env[k]) names.add(k.slice(12).toLowerCase().replace(/_/g, "-"));
    const out: { name: string; value: string; from: string; addedAt?: string }[] = [];
    for (const name of [...names].sort()) {
      const s = await this.source(name);
      if (s) out.push({ name, value: s.value, from: s.from, addedAt: s.from === "keys.json" ? keys[name]?.addedAt : undefined });
    }
    return out;
  }
}
