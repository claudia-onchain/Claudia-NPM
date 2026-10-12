// Passphrase encryption for secrets at rest: scrypt (N=2^15, r=8, p=1) → AES-256-GCM. Node only.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface SealedBox {
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16 bytes
  data: string; // base64 ciphertext
}

const PARAMS = { N: 1 << 15, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
}

export function seal(plaintext: string, passphrase: string, aad = ""): SealedBox {
  if (!passphrase) throw new Error("Empty passphrase");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, PARAMS.N, PARAMS.r, PARAMS.p);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  key.fill(0);
  return { kdf: "scrypt", ...PARAMS, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export class WrongPassphraseError extends Error {
  readonly code = "wrong_passphrase";
  constructor() {
    super("Wrong passphrase (or the file was changed)");
    this.name = "WrongPassphraseError";
  }
}

export function open(box: SealedBox, passphrase: string, aad = ""): string {
  if (box.kdf !== "scrypt") throw new Error(`Unknown kdf ${box.kdf}`);
  const key = deriveKey(passphrase, Buffer.from(box.salt, "base64"), box.N, box.r, box.p);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    if (aad) d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new WrongPassphraseError();
  } finally {
    key.fill(0);
  }
}

export function isSealed(x: unknown): x is SealedBox {
  return !!x && typeof x === "object" && (x as SealedBox).kdf === "scrypt" && typeof (x as SealedBox).data === "string";
}
