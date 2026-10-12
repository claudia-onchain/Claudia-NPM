// Turns a model's price spec + a request into an Estimate.
import type { Estimate, GenerateRequest } from "./types.js";

export type CostSpec =
  /** Per second of output. `byResolution` overrides `usd` for a resolution ("720p", "1080p", "4k"). */
  | { per: "second"; usd: number; byResolution?: Record<string, number>; defaultSec: number; /** Rate when meta.audio === false (models that price silent video lower). */ silentUsd?: number }
  /** Per image. `byQuality` keys come from meta.quality ("low" | "medium" | "high"). */
  | { per: "image"; usd: number; byQuality?: Record<string, number>; byResolution?: Record<string, number> }
  /** Per 1,000 characters of text. */
  | { per: "kchars"; usd: number }
  /** Per minute of output. */
  | { per: "minute"; usd: number; defaultSec: number }
  /** Flat per call / per video. */
  | { per: "call"; usd: number }
  /** Token-billed audio (Gemini TTS / Lyria): input text tokens + output audio tokens. */
  | { per: "tokens"; inPerM: number; outPerM: number; outTokensPerSec: number; defaultSec?: number };

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Rough speaking time: ~15 characters per second (about 150 words a minute). */
export function speechSeconds(text: string): number {
  return Math.max(1, text.length / 15);
}

export function priceEstimate(spec: CostSpec, req: GenerateRequest, basis: string, listed: boolean): Estimate {
  const n = Math.max(1, Math.floor(req.n ?? 1));
  const conf: Estimate["confidence"] = listed ? "list" : "estimate";
  switch (spec.per) {
    case "second": {
      const sec = req.durationSec ?? spec.defaultSec;
      const silent = req.meta?.audio === false && spec.silentUsd !== undefined;
      const rate = silent ? spec.silentUsd! : (req.resolution ? spec.byResolution?.[req.resolution.toLowerCase()] : undefined) ?? spec.usd;
      const usd = r4(rate * sec * n);
      return { usd, basis: `${basis}${silent ? " (without audio)" : ""} × ${sec}s${n > 1 ? ` × ${n}` : ""}`, confidence: conf };
    }
    case "image": {
      const q = typeof req.meta?.quality === "string" ? req.meta.quality : undefined;
      const rate =
        (q ? spec.byQuality?.[q] : undefined) ?? (req.resolution ? spec.byResolution?.[req.resolution.toLowerCase()] : undefined) ?? spec.usd;
      return { usd: r4(rate * n), basis: `${basis}${n > 1 ? ` × ${n}` : ""}`, confidence: conf };
    }
    case "kchars": {
      const chars = (req.text ?? req.prompt ?? "").length;
      return { usd: r4((spec.usd * chars) / 1000), basis: `${basis} × ${chars} chars`, confidence: conf };
    }
    case "minute": {
      const text = req.text ?? "";
      const sec = req.durationSec ?? (text ? speechSeconds(text) : spec.defaultSec);
      const guessed = req.durationSec === undefined;
      const usd = r4((spec.usd * sec) / 60);
      return guessed
        ? { usd, low: r4(usd * 0.7), high: r4(usd * 1.4), basis: `${basis} × ~${Math.round(sec)}s (guessed from the script length)`, confidence: "estimate" }
        : { usd, basis: `${basis} × ${sec}s`, confidence: conf };
    }
    case "call":
      return { usd: r4(spec.usd * n), basis, confidence: conf };
    case "tokens": {
      const text = req.text ?? req.prompt ?? "";
      const sec = req.durationSec ?? (req.kind === "speech" ? speechSeconds(text) : spec.defaultSec ?? 30);
      const inTok = Math.ceil(text.length / 4) + 20;
      const outTok = sec * spec.outTokensPerSec;
      const usd = r4((inTok * spec.inPerM + outTok * spec.outPerM) / 1e6);
      return { usd, low: r4(usd * 0.6), high: r4(usd * 1.6), basis: `${basis}; ~${Math.round(sec)}s of audio`, confidence: "estimate" };
    }
  }
}
