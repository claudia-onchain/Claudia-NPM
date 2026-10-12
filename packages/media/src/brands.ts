// Brand kits: reference images, voice and a short style line applied to requests that name the brand.
import { join } from "node:path";
import { ClaudiaMediaError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./store.js";
import type { Brand } from "./types.js";

export const DEFAULT_BRAND: Brand = {
  id: "claudia",
  name: "Claudia",
  refs: [],
  style:
    "Claudia: a 28-year-old woman (an adult in her late twenties) with a glossy black jaw-length bob, heavy straight bangs and one peach-orange streak through the front bangs, a small peach star-shaped hair clip, a thin headset microphone along her cheek, light freckles, grey-green eyes and glossy coral lips; a cool, direct gaze; futurist glossy wardrobe (white puffed-sleeve vinyl, liquid silver, patent, orange visors); photoreal, editorial flash, rose accent.",
};

/**
 * Image prompt for a launch-announcement card (use with brand "claudia" or your own kit). Solana by default;
 * Robinhood Chain (beta) launches name the chain and the launchpad. Text on the image is kept to the ticker.
 */
export function launchCardPrompt(i: { name: string; symbol: string; chain?: "sol" | "hood"; launchpad?: string; idea?: string }): string {
  const symbol = String(i.symbol ?? "").trim().replace(/^\$+/, "").toUpperCase();
  const pads: Record<string, string> = { pump: "pump.fun", pons: "Pons V2", pools: "Pools", flap: "Flap", bags: "Bags", clanker: "Clanker", dyor: "Dyor" };
  const where = i.chain === "hood" ? `on Robinhood Chain${i.launchpad ? ` (${pads[i.launchpad] ?? i.launchpad})` : ""}` : "on Solana";
  return [
    `Launch announcement card for the coin ${i.name} ($${symbol}) ${where}.`,
    i.idea ? `Theme: ${i.idea}.` : "",
    `Bold, clean composition with the ticker $${symbol} as the only text; no prices, charts going up, or promises.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export class BrandStore {
  private file: string;
  private brands: Map<string, Brand>;
  constructor(mediaDir: string, seedDefault: boolean) {
    this.file = join(mediaDir, "brands.json");
    const saved = readJson<{ brands?: Brand[] }>(this.file, {}).brands ?? [];
    this.brands = new Map(saved.map((b) => [b.id, b]));
    if (seedDefault && !this.brands.has(DEFAULT_BRAND.id)) this.brands.set(DEFAULT_BRAND.id, structuredClone(DEFAULT_BRAND));
  }
  list(): Brand[] {
    return [...this.brands.values()].map((b) => structuredClone(b));
  }
  get(id: string): Brand | null {
    const b = this.brands.get(id);
    return b ? structuredClone(b) : null;
  }
  save(b: Brand): Brand {
    if (!b || typeof b.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(b.id))
      throw new ClaudiaMediaError("invalid", "Brand id must be 1-64 letters, digits, dashes or underscores", { hint: 'Use something like "claudia" or "my-coin".' });
    const clean: Brand = {
      id: b.id,
      name: String(b.name || b.id),
      refs: Array.isArray(b.refs) ? b.refs.filter((r) => typeof r === "string" && r) : [],
      ...(b.voice?.provider && b.voice?.voiceId ? { voice: { provider: b.voice.provider, voiceId: b.voice.voiceId } } : {}),
      ...(b.style ? { style: String(b.style) } : {}),
      ...(b.banned?.length ? { banned: b.banned.map(String).filter(Boolean) } : {}),
    };
    this.brands.set(clean.id, clean);
    writeJsonAtomic(this.file, { version: 1, brands: [...this.brands.values()] });
    return structuredClone(clean);
  }
}
