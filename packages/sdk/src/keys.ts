// Ed25519 keys: the agent's device key (signs API requests) and its Solana wallet (signs transactions).
// Both are ordinary Solana-style keypairs: a 64-byte secret (32-byte seed + 32-byte public key), shown as base58.
import { Keypair } from "@solana/web3.js";
import { ClaudiaConfigError } from "./errors.js";
import { decodeSecret, fromBase58, toBase58, type SecretInput } from "./encoding.js";

export interface GeneratedKey {
  /** base58 public key (for a wallet: the Solana address). */
  publicKey: string;
  /** base58 of the 64-byte secret key. Keep it private. */
  secretKey: string;
}

/** A fresh device key. Register `publicKey` on useclaudia.xyz; keep `secretKey` on this machine only. */
export function generateDeviceKey(): GeneratedKey {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey.toBase58(), secretKey: toBase58(kp.secretKey) };
}

/** A fresh Solana wallet for the agent. Fund `publicKey` with a little SOL before trading or launching. */
export function generateWallet(): GeneratedKey {
  return generateDeviceKey();
}

/** Accepts a 64-byte secret key or a 32-byte seed (base58, JSON byte array, Uint8Array) and returns the Keypair. */
export function toKeypair(secret: SecretInput | Keypair): Keypair {
  if (secret instanceof Keypair) return secret;
  let bytes: Uint8Array;
  try {
    bytes = decodeSecret(secret);
  } catch (e) {
    throw new ClaudiaConfigError("bad_secret_key", `Couldn't read the secret key: ${(e as Error).message}`);
  }
  try {
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
  } catch (e) {
    throw new ClaudiaConfigError("bad_secret_key", `The secret key is not a valid ed25519 key: ${(e as Error).message}`);
  }
  throw new ClaudiaConfigError("bad_secret_key", `A secret key must be 64 bytes (or a 32-byte seed); got ${bytes.length}`);
}

/** base58 public key of a secret key (device key or wallet). */
export function publicKeyOf(secret: SecretInput | Keypair): string {
  return toKeypair(secret).publicKey.toBase58();
}

/** The 32-byte ed25519 seed of a secret key. */
export function seedOf(secret: SecretInput | Keypair): Uint8Array {
  return toKeypair(secret).secretKey.slice(0, 32);
}

export function isPublicKey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return fromBase58(s).length === 32;
  } catch {
    return false;
  }
}
