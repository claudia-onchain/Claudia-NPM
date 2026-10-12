// Token storage. The default store keeps every account's credentials in ONE file,
// <dataDir>/social/accounts.json, sealed with AES-256-GCM. The key comes from the host's KeyProvider
// under the name "social-vault" (any long random string; HKDF-SHA256 turns it into the AES key).
// Without that key, nothing is written: tokens never touch disk in plain text.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ClaudiaSocialError } from "./errors.js";
import type { KeyProvider, StoredAccount, TokenStore } from "./types.js";
import { writeJsonAtomic } from "./util.js";

interface SealedFile {
  type: "claudia-social-accounts";
  v: 1;
  alg: "aes-256-gcm";
  kdf: "hkdf-sha256";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const INFO = Buffer.from("claudia-social-accounts-v1");

function deriveKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, INFO, 32));
}

export function sealJson(secret: string, value: unknown): SealedFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return {
    type: "claudia-social-accounts",
    v: 1,
    alg: "aes-256-gcm",
    kdf: "hkdf-sha256",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function openJson<T>(secret: string, f: SealedFile): T {
  const d = createDecipheriv("aes-256-gcm", deriveKey(secret, Buffer.from(f.salt, "base64")), Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  const out = Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]);
  return JSON.parse(out.toString("utf8")) as T;
}

const NO_VAULT_HINT =
  'Add a key named "social-vault" to your key store (any long random string, e.g. `openssl rand -base64 32`; env: CLAUDIA_KEY_SOCIAL_VAULT), or pass your own `tokens` store to createSocial().';

/** The default encrypted file store. */
export function fileTokenStore(file: string, keys: KeyProvider): TokenStore {
  const secret = async () => {
    const s = await keys.get("social-vault");
    return s && s.trim().length >= 16 ? s.trim() : null;
  };
  return {
    async load() {
      if (!existsSync(file)) return [];
      const s = await secret();
      if (!s) {
        throw new ClaudiaSocialError("no_key", "Saved social accounts are encrypted and the \"social-vault\" key is missing.", { hint: NO_VAULT_HINT });
      }
      let parsed: SealedFile;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as SealedFile;
      } catch {
        throw new ClaudiaSocialError("invalid", `${file} is not readable JSON.`, { hint: "Restore it from a backup or delete it and reconnect the accounts." });
      }
      try {
        return openJson<StoredAccount[]>(s, parsed);
      } catch {
        throw new ClaudiaSocialError("invalid", "Could not decrypt saved social accounts: the \"social-vault\" key changed.", {
          hint: "Put the old key back, or delete accounts.json and reconnect.",
        });
      }
    },
    async save(accounts) {
      const s = await secret();
      if (!s) {
        throw new ClaudiaSocialError("no_key", "Claudia will not save social tokens unencrypted, and there is no \"social-vault\" key (16+ characters).", {
          hint: NO_VAULT_HINT,
        });
      }
      writeJsonAtomic(file, sealJson(s, accounts));
    },
  };
}

/** Keeps tokens in memory only (dry runs, tests, short scripts). Lost when the process exits. */
export function memoryTokenStore(initial: StoredAccount[] = []): TokenStore {
  let list = structuredClone(initial);
  return {
    async load() {
      return structuredClone(list);
    },
    async save(a) {
      list = structuredClone(a);
    },
  };
}
