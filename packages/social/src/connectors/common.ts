// Small helpers shared by connectors.
import { ClaudiaSocialError } from "../errors.js";
import type { NetworkCaps, NetworkInfo } from "../types.js";
import { sleep } from "../util.js";
import type { ConnCtx, PublishJob } from "./base.js";

export const VERSION = "0.3.0";
export const UA = `claudia-social/${VERSION} (+https://useclaudia.xyz)`;

export function caps(on: Partial<NetworkCaps>): NetworkCaps {
  return { text: false, image: false, video: false, thread: false, reply: false, dm: false, schedule: true, inbox: false, ...on };
}

export function info(i: NetworkInfo): NetworkInfo {
  return i;
}

/** First line of the text, cut to `max` characters, with `< >` removed (YouTube/Pinterest titles). */
export function titleOf(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "Untitled";
  const clean = line.replace(/[<>]/g, "");
  return Array.from(clean).length <= max ? clean : Array.from(clean).slice(0, max - 1).join("") + "…";
}

export function cutBytes(s: string, maxBytes: number): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > maxBytes) break;
    out += ch;
    n += b;
  }
  return out;
}

/** Reads `exp` from a JWT without checking it (only to know when to refresh). */
export function jwtExpMs(jwt: string | undefined): number | undefined {
  if (!jwt) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Polls until `done` returns a value, or gives up after `tries`. In dry runs it runs once. */
export async function poll<T>(ctx: ConnCtx, fn: () => Promise<T | undefined>, opts: { tries?: number; everyMs?: number; what: string }): Promise<T> {
  const tries = ctx.dryRun ? 1 : (opts.tries ?? 60);
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    if (i < tries - 1) await sleep(opts.everyMs ?? 2000);
  }
  throw new ClaudiaSocialError("provider_error", `${opts.what} is still processing after waiting.`, {
    network: ctx.network,
    hint: "The network may still finish it; check the account before trying again.",
    uncertain: true,
  });
}

/** Sends `job.text` then each thread part, replying to the previous one, skipping parts already live. */
export async function chain(
  job: PublishJob,
  send: (text: string, replyTo: string | undefined, index: number) => Promise<string>,
): Promise<string[]> {
  const parts = [job.text, ...job.thread];
  const ids = [...job.done];
  for (let i = ids.length; i < parts.length; i++) {
    const prev = i === 0 ? job.replyTo : ids[i - 1];
    const id = await send(parts[i]!, prev, i);
    ids.push(id);
    await job.progress(id);
  }
  return ids;
}

export function bearer(t: string): Record<string, string> {
  return { Authorization: `Bearer ${t}` };
}

export function invalid(network: string, msg: string, hint?: string): ClaudiaSocialError {
  return new ClaudiaSocialError("invalid", msg, { network, hint });
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const isVideo = (mime: string) => mime.startsWith("video/");
