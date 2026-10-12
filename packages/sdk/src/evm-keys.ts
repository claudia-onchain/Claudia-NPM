// EVM key helpers without viem (secp256k1 + keccak from @noble, which @solana/web3.js already ships). Used by the
// key store to create and check Robinhood Chain wallets; signing and sending live in @useclaudia/sdk/evm.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ClaudiaConfigError } from "./errors.js";

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

export const isEvmAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** EIP-55 checksummed address. */
export function checksumAddress(address: string): string {
  if (!isEvmAddress(address)) throw new ClaudiaConfigError("bad_address", "Not a 0x address");
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** Normalises a private key to 0x-prefixed lowercase hex (throws `bad_key` without echoing the input). */
export function normalizeEvmKey(privateKey: string): `0x${string}` {
  const s = String(privateKey ?? "").trim();
  if (!HEX_KEY.test(s)) throw new ClaudiaConfigError("bad_key", "An EVM private key is 32 bytes of hex (64 characters, optional 0x)");
  const hex = (s.startsWith("0x") ? s.slice(2) : s).toLowerCase();
  const n = BigInt("0x" + hex);
  if (n === 0n || n >= secp256k1.CURVE.n) throw new ClaudiaConfigError("bad_key", "That EVM private key is out of range");
  return `0x${hex}`;
}

/** Checksummed address of an EVM private key. */
export function evmAddressOf(privateKey: string): string {
  const hex = normalizeEvmKey(privateKey).slice(2);
  const pub = secp256k1.getPublicKey(hexToBytes(hex), false).slice(1);
  return checksumAddress("0x" + toHex(keccak_256(pub).slice(-20)));
}

/** A new random EVM wallet (Robinhood Chain, BNB Chain). Keep `privateKey` secret. */
export function generateEvmWallet(): { address: string; privateKey: `0x${string}` } {
  const sk = secp256k1.utils.randomPrivateKey();
  const privateKey = `0x${toHex(sk)}` as const;
  return { address: evmAddressOf(privateKey), privateKey };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
