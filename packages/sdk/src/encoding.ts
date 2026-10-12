// Small, dependency-free byte helpers that work in Node and in browsers.
import bs58 from "bs58";

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

export const toBase58 = (b: Uint8Array): string => bs58.encode(b);

export function fromBase58(s: string): Uint8Array {
  return bs58.decode(s.trim());
}

/** Secret keys come as base58, a JSON byte array (solana-keygen files), a Uint8Array or a number[]. */
export type SecretInput = string | Uint8Array | number[];

export function decodeSecret(input: SecretInput): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  const s = String(input).trim();
  if (s.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(s);
    } catch {
      // Never surface JSON.parse's message: on recent Node it quotes part of the input (the secret).
      throw new Error("Secret key JSON is not valid JSON");
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("Secret key JSON must be an array of bytes");
    return Uint8Array.from(arr as number[]);
  }
  return fromBase58(s);
}

let cryptoP: Promise<Crypto> | null = null;

/** WebCrypto: `globalThis.crypto` (browsers, Node ≥ 19) or `node:crypto`'s `webcrypto` (Node 18). */
export function webcrypto(): Promise<Crypto> {
  if (!cryptoP) {
    const g = (globalThis as { crypto?: Crypto }).crypto;
    cryptoP = g?.subtle ? Promise.resolve(g) : import("node:crypto").then((m) => m.webcrypto as unknown as Crypto);
  }
  return cryptoP;
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  (await webcrypto()).getRandomValues(out);
  return out;
}

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** 24 characters of [A-Za-z0-9_-] (the server accepts 16–128). */
export async function makeNonce(length = 24): Promise<string> {
  const b = await randomBytes(length);
  let s = "";
  for (const x of b) s += NONCE_ALPHABET[x & 63];
  return s;
}
