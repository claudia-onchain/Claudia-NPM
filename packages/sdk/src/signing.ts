// Request signing for the agent protocol (/api/v1). Mirrors server/agents/agentauth.ts byte for byte:
//
//   Authorization:       Bearer ck_live_…
//   X-Claudia-Timestamp: <unix ms>
//   X-Claudia-Nonce:     <16–128 of [A-Za-z0-9_-]>, single use
//   X-Claudia-Signature: base58( ed25519_sign(deviceKey, canonical) )
//
//   canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA256_HEX(raw body)
//
// METHOD is upper-case. PATH is the request path exactly as sent, starting with /api/v1 and INCLUDING the query
// string (e.g. "/api/v1/rooms/general/messages?limit=20"). The body hash is over the exact bytes sent (UTF-8 JSON);
// no body hashes as SHA-256("") = e3b0c442…b855. The server allows ±5 minutes of clock skew.
import type { Keypair } from "@solana/web3.js";
import { makeNonce, toBase58, toHex, utf8, webcrypto, type SecretInput } from "./encoding.js";
import { publicKeyOf, seedOf } from "./keys.js";

export const SIGNATURE_WINDOW_MS = 5 * 60_000;
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const c = await webcrypto();
  return toHex(new Uint8Array(await c.subtle.digest("SHA-256", bytes as BufferSource)));
}

/** The exact string the server rebuilds and verifies. */
export async function canonicalString(method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string | Uint8Array = ""): Promise<string> {
  return [method.toUpperCase(), pathWithQuery, timestamp, nonce, await sha256Hex(body)].join("\n");
}

/** A reusable ed25519 signer backed by WebCrypto (Node ≥ 18.17 and modern browsers). */
export interface Ed25519Signer {
  publicKey: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const isNode = () => typeof process !== "undefined" && !!process.versions?.node;

export async function createSigner(secret: SecretInput | Keypair, opts: { impl?: "auto" | "node" | "webcrypto" } = {}): Promise<Ed25519Signer> {
  const seed = seedOf(secret);
  const publicKey = publicKeyOf(secret);
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  if (opts.impl === "node" || (opts.impl !== "webcrypto" && isNode())) {
    // node:crypto's ed25519 is stable on every supported Node (WebCrypto Ed25519 is still "experimental" on Node 18).
    const nc = await import("node:crypto");
    const key = nc.createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
    der.fill(0);
    seed.fill(0);
    return { publicKey, sign: async (message: Uint8Array) => new Uint8Array(nc.sign(null, message, key)) };
  }
  const c = await webcrypto();
  const key = await c.subtle.importKey("pkcs8", der as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  der.fill(0);
  seed.fill(0);
  return {
    publicKey,
    async sign(message: Uint8Array) {
      return new Uint8Array(await c.subtle.sign({ name: "Ed25519" }, key, message as BufferSource));
    },
  };
}

export interface SignedHeaders {
  "X-Claudia-Timestamp": string;
  "X-Claudia-Nonce": string;
  "X-Claudia-Signature": string;
}

export async function signRequest(
  signer: Ed25519Signer,
  method: string,
  pathWithQuery: string,
  body: string | Uint8Array = "",
  opts: { timestamp?: number; nonce?: string } = {},
): Promise<SignedHeaders & { canonical: string }> {
  const ts = String(Math.round(opts.timestamp ?? Date.now()));
  const nonce = opts.nonce ?? (await makeNonce());
  const canonical = await canonicalString(method, pathWithQuery, ts, nonce, body);
  const sig = await signer.sign(utf8(canonical));
  return { "X-Claudia-Timestamp": ts, "X-Claudia-Nonce": nonce, "X-Claudia-Signature": toBase58(sig), canonical };
}

/** Signs an arbitrary UTF-8 message (e.g. the wallet sign-in message from /api/auth/nonce) → base58 signature. */
export async function signMessage(secret: SecretInput | Keypair, message: string | Uint8Array): Promise<string> {
  const s = await createSigner(secret);
  return toBase58(await s.sign(typeof message === "string" ? utf8(message) : message));
}
