// Media for connectors. Networks that take bytes get bytes (load). Networks that pull from a public URL
// (Instagram, Threads, Facebook URLs, TikTok photos, Farcaster embeds, Buffer, Pinterest) get a short-lived
// link from the Claudia media relay (POST https://useclaudia.xyz/relay/media), deleted after publish.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ClaudiaSocialError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { MediaInput, MediaRelayOptions } from "./types.js";
import { extOf, isUrl, mimeOf, randomToken } from "./util.js";

/** Builds a multipart/form-data body by hand so a request signature can cover the exact bytes sent. */
export function multipartBody(field: string, file: { bytes: Uint8Array; mime: string; filename: string }): { body: Uint8Array; contentType: string } {
  const boundary = `----claudia${randomToken(18).replace(/[^A-Za-z0-9]/g, "")}`;
  const safeName = file.filename.replace(/["\r\n]/g, "_");
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safeName}"\r\nContent-Type: ${file.mime}\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: new Uint8Array(Buffer.concat([head, Buffer.from(file.bytes), tail])), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface LoadedMedia {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  size: number;
  alt?: string;
  kind: "image" | "video" | "other";
}

export interface MediaHelper {
  load(m: MediaInput): Promise<LoadedMedia>;
  /** A public https URL for this file (the URL itself, or a relay link). */
  publicUrl(m: MediaInput, opts?: { ttlMin?: number }): Promise<string>;
  /** Size without reading the whole file. */
  size(m: MediaInput): number | undefined;
  kind(m: MediaInput): "image" | "video" | "other";
  /** Deletes relay links made during this publish. */
  cleanup(): Promise<void>;
}

export const DEFAULT_MEDIA_RELAY = "https://useclaudia.xyz/relay/media";

export function kindOf(mime: string): "image" | "video" | "other" {
  return mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "other";
}

export function createMediaHelper(http: Transport, relay: MediaRelayOptions | undefined, network: string): MediaHelper {
  const made: { url: string; token: string }[] = [];
  const cache = new Map<string, LoadedMedia>();
  return {
    kind(m) {
      return kindOf(mimeOf(m.path, m.mime));
    },
    size(m) {
      if (isUrl(m.path)) return undefined;
      try {
        return statSync(m.path).size;
      } catch {
        return undefined;
      }
    },
    async load(m) {
      const hit = cache.get(m.path);
      if (hit) return hit;
      const mime = mimeOf(m.path, m.mime);
      let bytes: Uint8Array;
      if (isUrl(m.path)) {
        if (http.dryRun) bytes = new Uint8Array(1024);
        else {
          const res = await fetch(m.path, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new ClaudiaSocialError("invalid", `Could not download ${m.path} (${res.status}).`, { network });
          bytes = new Uint8Array(await res.arrayBuffer());
        }
      } else if (existsSync(m.path)) {
        bytes = new Uint8Array(readFileSync(m.path));
      } else if (http.dryRun) {
        bytes = new Uint8Array(1024);
      } else {
        throw new ClaudiaSocialError("invalid", `Media file not found: ${m.path}`, { hint: "Use an absolute path to a file on this machine, or an https URL." });
      }
      const filename = isUrl(m.path) ? basename(new URL(m.path).pathname) || `media.${extOf(mime)}` : basename(m.path);
      const out: LoadedMedia = { bytes, mime, filename, size: bytes.byteLength, alt: m.alt, kind: kindOf(mime) };
      cache.set(m.path, out);
      return out;
    },
    async publicUrl(m, opts = {}) {
      if (isUrl(m.path)) return m.path;
      if (!relay) {
        throw new ClaudiaSocialError("unsupported", `${network} pulls media from a public URL, and no media relay is set up.`, {
          network,
          hint: "Pass mediaRelay: { url: 'https://useclaudia.xyz/relay/media', token } to createSocial (it needs a Claudia token), or give the media as an https URL.",
        });
      }
      const token = await relay.token();
      if (!token && !relay.sign) {
        throw new ClaudiaSocialError("no_key", "The media relay needs a Claudia token.", {
          network,
          hint: "Sign in with `claudia login` (or give Local an agent key) so the relay accepts uploads.",
        });
      }
      const f = await this.load(m);
      const ttl = Math.min(60, Math.max(1, opts.ttlMin ?? relay.ttlMin ?? (f.kind === "video" ? 60 : 15)));
      const url = `${relay.url.replace(/\/$/, "")}?ttl=${ttl}`;
      const mp = multipartBody("file", { bytes: f.bytes, mime: f.mime, filename: f.filename });
      const headers: Record<string, string> = { "Content-Type": mp.contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      if (relay.sign) Object.assign(headers, await relay.sign({ method: "POST", path: pathWithQuery(url), body: mp.body }));
      const res = await http.request({
        method: "POST",
        url,
        headers,
        raw: { bytes: mp.body, mime: mp.contentType },
        secrets: [token],
        display: { multipart: [{ name: "file", file: { filename: f.filename, mime: f.mime, bytes: f.size } }], signed: !!relay.sign },
        label: `media relay upload (${network})`,
        network,
        timeoutMs: 10 * 60_000,
        mock: { url: `https://useclaudia.xyz/relay/media/dryrun${made.length}.${extOf(f.mime)}`, expiresAt: Date.now() + ttl * 60_000, bytes: f.size, mime: f.mime },
      });
      if (!res.json?.url) throw new ClaudiaSocialError("provider_error", "The media relay did not return a URL.", { network });
      made.push({ url: res.json.url, token: token ?? "" });
      return res.json.url as string;
    },
    async cleanup() {
      for (const { url, token } of made.splice(0)) {
        try {
          const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
          if (relay?.sign) Object.assign(headers, await relay.sign({ method: "DELETE", path: pathWithQuery(url), body: new Uint8Array(0) }));
          await http.request({
            method: "DELETE",
            url,
            headers,
            secrets: [token],
            label: "media relay delete",
            network,
            mockStatus: 204,
          });
        } catch {
          /* it expires on its own within the TTL */
        }
      }
    },
  };
}

function pathWithQuery(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
