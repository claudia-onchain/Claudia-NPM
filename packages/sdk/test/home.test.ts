import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicKeyOf } from "../src/index.js";
import { ClaudiaHome, checkCaps, openSealed, seal } from "../src/node/index.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "claudia-home-")), ".claudia");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("ClaudiaHome key storage", () => {
  it("creates a 0700 dir and 0600 files, plaintext mode", async () => {
    const dir = tmp();
    const h = new ClaudiaHome({ dir, env: {} });
    h.writeConfig({ baseUrl: "http://localhost:5080" });
    const { devicePublicKey, walletAddress } = h.createKeys();
    await h.saveCredentials({ apiKey: "ck_live_abc" });
    expect(mode(dir)).toBe(0o700);
    for (const f of ["config.json", "device.json", "wallet.json", "credentials.json"]) expect(mode(join(dir, f))).toBe(0o600);
    expect(publicKeyOf((await h.deviceSecret())!)).toBe(devicePublicKey);
    expect((await h.walletKeypair())!.publicKey.toBase58()).toBe(walletAddress);
    expect(await h.apiKey()).toBe("ck_live_abc");
    expect(() => h.createKeys()).toThrowError(/already exist/);
  });

  it("encrypts secrets with a passphrase (scrypt + AES-256-GCM)", async () => {
    const dir = tmp();
    const h = new ClaudiaHome({ dir, env: {} });
    const { devicePublicKey } = h.createKeys({ passphrase: "correct horse battery" });
    await h.saveCredentials({ apiKey: "ck_live_secret_value", openrouterKey: "sk-or-xyz" });
    const dev = JSON.parse(readFileSync(join(dir, "device.json"), "utf8"));
    expect(dev.secretKey).toBeUndefined();
    expect(dev.encrypted.kdf).toBe("scrypt");
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).not.toContain("ck_live_secret_value");
    expect(h.isEncrypted()).toBe(true);

    const again = new ClaudiaHome({ dir, env: { CLAUDIA_PASSPHRASE: "correct horse battery" } });
    expect(publicKeyOf((await again.deviceSecret())!)).toBe(devicePublicKey);
    expect(await again.apiKey()).toBe("ck_live_secret_value");
    expect(await again.openrouterKey()).toBe("sk-or-xyz");

    const wrong = new ClaudiaHome({ dir, env: { CLAUDIA_PASSPHRASE: "nope" } });
    await expect(wrong.deviceSecret()).rejects.toMatchObject({ code: "wrong_passphrase" });
    const none = new ClaudiaHome({ dir, env: {} });
    await expect(none.walletKeypair()).rejects.toMatchObject({ code: "passphrase_required" });
    // the public parts stay readable without the passphrase
    expect(none.devicePublicKey()).toBe(devicePublicKey);
  });

  it("detects a tampered key file", async () => {
    const dir = tmp();
    const h = new ClaudiaHome({ dir, env: {} });
    h.createKeys();
    const f = join(dir, "wallet.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.publicKey = "11111111111111111111111111111111";
    writeFileSync(f, JSON.stringify(j));
    await expect(h.walletKeypair()).rejects.toThrow(/doesn't match/);
  });

  it("seal/open round trip, AAD bound", () => {
    const box = seal("hello", "pw", "ctx");
    expect(openSealed(box, "pw", "ctx")).toBe("hello");
    expect(() => openSealed(box, "pw", "other")).toThrow(/Wrong passphrase/);
  });

  it("env overrides win", async () => {
    const dir = tmp();
    const h = new ClaudiaHome({ dir, env: { CLAUDIA_BASE_URL: "http://env:1/", CLAUDIA_API_KEY: "ck_live_env", CLAUDIA_MAX_SOL_PER_TRADE: "0.01" } });
    h.writeConfig({ baseUrl: "http://file" });
    expect(h.config().baseUrl).toBe("http://env:1");
    expect(h.config().caps.maxSolPerTrade).toBe(0.01);
    expect(await h.apiKey()).toBe("ck_live_env");
  });
});

describe("caps", () => {
  it("enforces per-trade and per-day caps with the spend ledger", () => {
    const h = new ClaudiaHome({ dir: tmp(), env: {} });
    h.writeConfig({ caps: { maxSolPerTrade: 0.05, maxSolPerDay: 0.1 } });
    expect(() => h.checkCaps(0.06)).toThrowError(/per-trade cap/);
    expect(h.checkCaps(0.05).leftToday).toBeCloseTo(0.1);
    h.recordSpend({ kind: "buy", sol: 0.05, token: "sol:x" });
    h.recordSpend({ kind: "buy", sol: 0.04 });
    expect(h.spentToday()).toBeCloseTo(0.09);
    expect(() => h.checkCaps(0.02)).toThrowError(/daily cap/);
    expect(() => checkCaps(-1, { maxSolPerTrade: 1, maxSolPerDay: 1 }, 0)).toThrowError(/positive/);
    expect(mode(h.paths.spend)).toBe(0o600);
  });
});
