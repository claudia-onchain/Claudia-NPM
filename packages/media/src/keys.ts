import type { KeyProvider } from "./types.js";

/** Key names this package asks for. */
export const KEY_NAMES = ["google", "openai", "fal", "elevenlabs", "heygen", "runway", "byteplus"] as const;

/** Reads `CLAUDIA_KEY_<NAME>` (upper case, dashes → underscores), e.g. CLAUDIA_KEY_GOOGLE. */
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

/** A fixed map, handy for scripts: `staticKeys({ google: "…" })`. */
export function staticKeys(map: Record<string, string | undefined>): KeyProvider {
  return { get: (name) => map[name] ?? null };
}
