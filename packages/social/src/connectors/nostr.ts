// Nostr: kind-1 notes signed with the user's nsec (BIP-340 Schnorr via @noble/curves), sent to relays the user picks.
// Specs: https://github.com/nostr-protocol/nips (01 events/relays, 10 replies, 19 bech32, 27 mentions, 92 imeta)
//        Blossom media: https://github.com/hzrd149/blossom (BUD-02 upload, BUD-11 auth). NIP-96 is deprecated in favour of Blossom.
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { ClaudiaSocialError } from "../errors.js";
import { isUrl } from "../util.js";
import type { WsConn } from "../ws.js";
import { need, type ConnCtx, type Connector, type PublishJob } from "./base.js";
import { caps, info } from "./common.js";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

// ---------- bech32 (NIP-19 uses bech32, not bech32m) ----------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]!;
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convert(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) throw new Error("bad padding");
  return out;
}
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convert(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}
export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } {
  const str = s.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length) throw new Error("not bech32");
  const hrp = str.slice(0, pos);
  const data = [...str.slice(pos + 1)].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new Error("bad bech32 character");
    return d;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  return { hrp, bytes: Uint8Array.from(convert(data.slice(0, -6), 5, 8, false)) };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export function secretFromNsec(nsec: string): Uint8Array {
  const s = nsec.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return unhex(s);
  const d = bech32Decode(s);
  if (d.hrp !== "nsec" || d.bytes.length !== 32) throw new Error("not an nsec key");
  return d.bytes;
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-01: id = sha256 of [0, pubkey, created_at, kind, tags, content]; sig = BIP-340 over the id. */
export function signEvent(sk: Uint8Array, e: { created_at: number; kind: number; tags: string[][]; content: string }): NostrEvent {
  const pubkey = hex(schnorr.getPublicKey(sk));
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content])).digest("hex");
  const sig = hex(schnorr.sign(unhex(id), sk));
  return { id, pubkey, ...e, sig };
}

/** A fresh key for an agent: { nsec, npub, pubkey (hex) }. Keep the nsec in your key store. */
export function nostrKeygen(): { nsec: string; npub: string; pubkey: string } {
  const sk = schnorr.utils.randomPrivateKey();
  const pub = schnorr.getPublicKey(sk);
  return { nsec: bech32Encode("nsec", sk), npub: bech32Encode("npub", pub), pubkey: hex(pub) };
}

function noteLink(id: string): string {
  return `https://njump.me/${bech32Encode("note", unhex(id))}`;
}

/** Sends one event to every relay; success when at least one relay says OK (or "duplicate:"). */
async function broadcast(ctx: ConnCtx, ev: NostrEvent, label: string): Promise<{ ok: string[]; failed: string[] }> {
  const relays: string[] = ctx.creds.relays ?? DEFAULT_RELAYS;
  if (ctx.dryRun) {
    for (const r of relays) ctx.http.note({ method: "WS", url: r, headers: {}, body: ["EVENT", ev], label });
    return { ok: relays, failed: [] };
  }
  const ok: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    relays.map(async (url) => {
      let ws: WsConn | undefined;
      try {
        ws = await ctx.ws(url, 8000);
        const res = await new Promise<string | true>((resolve) => {
          const t = setTimeout(() => resolve("no answer"), 8000);
          ws!.onMessage((raw) => {
            try {
              const m = JSON.parse(raw);
              if (m[0] === "OK" && m[1] === ev.id) {
                clearTimeout(t);
                resolve(m[2] === true || String(m[3] ?? "").startsWith("duplicate:") ? true : String(m[3] ?? "rejected"));
              }
            } catch {
              /* not for us */
            }
          });
          ws!.send(JSON.stringify(["EVENT", ev]));
        });
        if (res === true) ok.push(url);
        else failed.push(`${url}: ${res}`);
      } catch (e) {
        failed.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        ws?.close();
      }
    }),
  );
  if (!ok.length) {
    throw new ClaudiaSocialError("provider_error", `No Nostr relay accepted the note (${failed.join("; ")}).`, {
      network: "nostr",
      // a relay may have stored it before the connection dropped
      uncertain: failed.some((f) => /no answer/.test(f)),
    });
  }
  return { ok, failed };
}

async function query(ctx: ConnCtx, filter: Record<string, unknown>, label: string): Promise<NostrEvent[]> {
  const relays: string[] = ctx.creds.relays ?? DEFAULT_RELAYS;
  const sub = `c${Math.random().toString(36).slice(2, 10)}`;
  if (ctx.dryRun) {
    ctx.http.note({ method: "WS", url: relays[0]!, headers: {}, body: ["REQ", sub, filter], label });
    return [];
  }
  const seen = new Map<string, NostrEvent>();
  for (const url of relays.slice(0, 2)) {
    let ws: WsConn | undefined;
    try {
      ws = await ctx.ws(url, 8000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 8000);
        ws!.onMessage((raw) => {
          try {
            const m = JSON.parse(raw);
            if (m[0] === "EVENT" && m[1] === sub && m[2]?.id) seen.set(m[2].id, m[2]);
            if ((m[0] === "EOSE" || m[0] === "CLOSED") && m[1] === sub) {
              clearTimeout(t);
              resolve();
            }
          } catch {
            /* ignore */
          }
        });
        ws!.send(JSON.stringify(["REQ", sub, filter]));
      });
      ws.send(JSON.stringify(["CLOSE", sub]));
    } catch {
      /* try the next relay */
    } finally {
      ws?.close();
    }
  }
  return [...seen.values()];
}

/** BUD-02 upload with a BUD-11 auth event (kind 24242), base64url without padding. */
async function blossomUpload(ctx: ConnCtx, sk: Uint8Array, m: { path: string; mime?: string; alt?: string }) {
  const server = String(ctx.creds.blossom).replace(/\/$/, "");
  const f = await ctx.media.load(m);
  const sha = createHash("sha256").update(f.bytes).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const auth = signEvent(sk, {
    kind: 24242,
    created_at: now,
    content: "Upload Blob",
    tags: [
      ["t", "upload"],
      ["x", sha],
      ["expiration", String(now + 600)],
      ["server", new URL(server).host],
    ],
  });
  const res = await ctx.http.request({
    method: "PUT",
    url: `${server}/upload`,
    headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64url")}`, "X-SHA-256": sha },
    raw: { bytes: f.bytes, mime: f.mime },
    network: "nostr",
    label: "Blossom upload",
    timeoutMs: 10 * 60_000,
    mock: { url: `${server}/${sha}.${f.mime.split("/")[1]}`, sha256: sha, size: f.size, type: f.mime },
  });
  return { url: res.json.url as string, sha, mime: f.mime, alt: m.alt };
}

function hashtags(text: string): string[][] {
  return [...new Set([...text.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,64})/gu)].map((m) => m[2]!.toLowerCase()))].map((t) => ["t", t]);
}

function mentionTags(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/nostr:(npub1[02-9ac-hj-np-z]{58})/g)) {
    try {
      out.push(["p", hex(bech32Decode(m[1]!).bytes)]);
    } catch {
      /* not a valid npub */
    }
  }
  return out;
}

async function replyTags(ctx: ConnCtx, parentId: string): Promise<string[][]> {
  const [parent] = await query(ctx, { ids: [parentId], limit: 1 }, "fetch parent note");
  const relay = (ctx.creds.relays ?? DEFAULT_RELAYS)[0];
  if (!parent) return [["e", parentId, relay, "root"]];
  const root = parent.tags.find((t) => t[0] === "e" && t[3] === "root");
  const ps = parent.tags.filter((t) => t[0] === "p").map((t) => ["p", t[1]!]);
  const tags = root ? [["e", root[1]!, root[2] ?? "", "root"], ["e", parentId, relay!, "reply", parent.pubkey]] : [["e", parentId, relay!, "root", parent.pubkey]];
  return [...tags, ...ps, ["p", parent.pubkey]];
}

export const nostrConnector: Connector = {
  id: "nostr",
  counter: "codepoints",
  // the event id is a hash of the content + created_at (kept stable across retries): relays answer "duplicate:" to a resend
  idempotent: true,
  labels: { ai: "text" },
  info: info({
    id: "nostr",
    name: "Nostr",
    tier: "direct",
    auth: "key",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, inbox: true }),
    limits: { maxChars: 4000, maxImages: 4, perDay: 30 },
    setup:
      "Use the nsec of a key made for the agent (never your personal key). Connect with params { nsec, relays: \"wss://relay.damus.io,wss://nos.lol\" } (key name \"nostr\" can hold the nsec). For local images add params.blossom = a Blossom server you use (e.g. https://blossom.primal.net); otherwise give media as https URLs.",
    docs: "https://github.com/nostr-protocol/nips/blob/master/01.md",
    keyNames: ["nostr"],
  }),
  check(account, job) {
    if (job.media.some((m) => !isUrl(m.path)) && !account?.notes?.some((n) => n.startsWith("blossom "))) {
      return "Nostr notes link to media. Give media as https URLs, or connect with params.blossom (a Blossom server) to upload local files.";
    }
    return undefined;
  },
  async connectKey(_ctx, params, keys) {
    const nsec = need(params.nsec ?? (await keys.get("nostr")), "Nostr nsec", "Pass params.nsec or store it under the key \"nostr\".");
    let sk: Uint8Array;
    try {
      sk = secretFromNsec(nsec);
    } catch {
      throw new ClaudiaSocialError("invalid", "That is not a valid nsec key.", { network: "nostr" });
    }
    const pub = schnorr.getPublicKey(sk);
    const npub = bech32Encode("npub", pub);
    const relays = (params.relays ? params.relays.split(/[\s,]+/) : DEFAULT_RELAYS).filter((r) => /^wss?:\/\//.test(r));
    if (!relays.length) throw new ClaudiaSocialError("invalid", "Pick at least one relay (wss://…).", { network: "nostr" });
    return [
      {
        account: {
          id: `nostr:${npub}`,
          network: "nostr",
          handle: `${npub.slice(0, 12)}…${npub.slice(-6)}`,
          name: params.name,
          notes: [`${relays.length} relays`, ...(params.blossom ? [`blossom ${params.blossom}`] : [])],
        },
        credentials: { nsec, pubkey: hex(pub), relays, blossom: params.blossom },
      },
    ];
  },
  async publish(ctx, job: PublishJob) {
    const sk = secretFromNsec(ctx.creds.nsec);
    const created = Math.floor(job.stableAt / 1000);
    const imeta: string[][] = [];
    let mediaText = "";
    if (!job.done.length) {
      for (const m of job.media) {
        const up = isUrl(m.path) ? { url: m.path, mime: m.mime, alt: m.alt, sha: undefined } : await blossomUpload(ctx, sk, m);
        mediaText += `\n${up.url}`;
        imeta.push(["imeta", `url ${up.url}`, ...(up.mime ? [`m ${up.mime}`] : []), ...(up.sha ? [`x ${up.sha}`] : []), ...(up.alt ? [`alt ${up.alt}`] : [])]);
      }
    }
    const parts = [job.text, ...job.thread];
    const ids = [...job.done];
    let rootId = ids[0];
    for (let i = ids.length; i < parts.length; i++) {
      const content = i === 0 ? `${parts[i]}${mediaText}` : parts[i]!;
      const tags = [...hashtags(content), ...mentionTags(content), ...(i === 0 ? imeta : [])];
      const parent = i === 0 ? job.replyTo : ids[i - 1];
      if (parent) {
        if (i === 0) tags.push(...(await replyTags(ctx, parent)));
        else {
          const relay = (ctx.creds.relays ?? DEFAULT_RELAYS)[0]!;
          tags.push(["e", rootId!, relay, "root"]);
          if (parent !== rootId) tags.push(["e", parent, relay, "reply"]);
          tags.push(["p", ctx.creds.pubkey]);
        }
      }
      const ev = signEvent(sk, { kind: 1, created_at: created + i, tags, content });
      await broadcast(ctx, ev, i === 0 ? "publish note" : `thread part ${i + 1}`);
      ids.push(ev.id);
      rootId ??= ev.id;
      await job.progress(ev.id);
    }
    return { remoteId: ids[0]!, remoteIds: ids, url: noteLink(ids[0]!) };
  },
  async reply(ctx, to, text) {
    const sk = secretFromNsec(ctx.creds.nsec);
    const tags = [...hashtags(text), ...mentionTags(text), ...(await replyTags(ctx, to))];
    const ev = signEvent(sk, { kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: text });
    await broadcast(ctx, ev, "reply");
    return { remoteId: ev.id, url: noteLink(ev.id) };
  },
  async inbox(ctx, cursor) {
    const since = cursor?.since ?? Math.floor(Date.now() / 1000) - 86400;
    const events = await query(ctx, { kinds: [1], "#p": [ctx.creds.pubkey], since, limit: 50 }, "mentions (REQ)");
    let newest = since;
    const items = events
      .filter((e) => e.pubkey !== ctx.creds.pubkey)
      .map((e) => {
        newest = Math.max(newest, e.created_at + 1);
        const isReply = e.tags.some((t) => t[0] === "e");
        return {
          kind: isReply ? ("reply" as const) : ("mention" as const),
          id: e.id,
          from: bech32Encode("npub", unhex(e.pubkey)).slice(0, 16) + "…",
          text: e.content,
          at: e.created_at * 1000,
          url: noteLink(e.id),
        };
      });
    return { items, cursor: { since: newest }, reads: 1 };
  },
};
