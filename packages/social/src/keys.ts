import type { KeyProvider } from "./types.js";

/**
 * Key names this package asks the KeyProvider for. Values for OAuth apps may be JSON
 * (`{"clientId":"…","clientSecret":"…"}`) or `clientId:clientSecret`.
 */
export const KEY_NAMES = {
  vault: "social-vault",
  x: "x",
  telegram: "telegram",
  discord: "discord",
  bluesky: "bluesky",
  mastodon: "mastodon",
  farcaster: "neynar",
  nostr: "nostr",
  linkedin: "linkedin",
  youtube: "youtube",
  buffer: "buffer",
  zernio: "zernio",
  "upload-post": "upload-post",
  instagram: "instagram",
  facebook: "facebook",
  threads: "threads",
  tiktok: "tiktok",
  pinterest: "pinterest",
} as const;

/** Reads `CLAUDIA_KEY_<NAME>` (upper case, dashes → underscores), e.g. CLAUDIA_KEY_SOCIAL_VAULT. */
export function envKeys(env: Record<string, string | undefined> = process.env): KeyProvider {
  return {
    get(name: string) {
      const v = env[`CLAUDIA_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
      return v && v.trim() ? v.trim() : null;
    },
  };
}

/** Tries each provider in order; the first non-empty answer wins. */
export function chainKeys(...providers: (KeyProvider | null | undefined)[]): KeyProvider {
  const list = providers.filter(Boolean) as KeyProvider[];
  return {
    async get(name: string) {
      for (const p of list) {
        try {
          const v = await p.get(name);
          if (v) return v;
        } catch {
          // a broken store should not hide the env fallback
        }
      }
      return null;
    },
  };
}

/** A fixed map, handy for scripts: `staticKeys({ "social-vault": "…" })`. */
export function staticKeys(map: Record<string, string | undefined>): KeyProvider {
  return { get: (name) => map[name] ?? null };
}

/** Parses an OAuth app credential: JSON `{clientId, clientSecret}` or `id:secret` or a bare client id. */
export function parseClientCreds(v: string | null | undefined): { clientId?: string; clientSecret?: string } {
  if (!v) return {};
  const s = v.trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s) as Record<string, string>;
      return { clientId: j.clientId ?? j.client_id ?? j.clientKey ?? j.client_key, clientSecret: j.clientSecret ?? j.client_secret };
    } catch {
      return {};
    }
  }
  const i = s.indexOf(":");
  if (i > 0) return { clientId: s.slice(0, i), clientSecret: s.slice(i + 1) };
  return { clientId: s };
}
