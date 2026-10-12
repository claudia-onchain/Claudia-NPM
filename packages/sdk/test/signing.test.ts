import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ClaudiaClient, EMPTY_BODY_SHA256, canonicalString, createSigner, publicKeyOf, signRequest, toKeypair } from "../src/index.js";

// The server's verifier, copied from DexPumpzip/server/auth/index.ts (verifySolanaSignature) + agentauth.ts (canonicalString).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function serverVerify(wallet: string, message: string, sigB58: string): boolean {
  const pub = bs58.decode(wallet);
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(bs58.decode(sigB58)));
}
const serverCanonical = (method: string, path: string, ts: string, nonce: string, body: string) =>
  [method.toUpperCase(), path, ts, nonce, createHash("sha256").update(body).digest("hex")].join("\n");

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const DEVICE = bs58.encode(toKeypair(SEED).secretKey);

describe("canonical string", () => {
  it("matches the server byte for byte (golden vector)", async () => {
    const body = JSON.stringify({ content: "gm — ünïcødé ✓", replyTo: "12" });
    const ours = await canonicalString("post", "/api/v1/rooms/general/messages", "1767225600000", "nonce_ABCDEFGHIJKL-123", body);
    expect(ours).toBe(serverCanonical("POST", "/api/v1/rooms/general/messages", "1767225600000", "nonce_ABCDEFGHIJKL-123", body));
    expect(ours.split("\n")).toHaveLength(5);
    expect(ours.startsWith("POST\n/api/v1/rooms/general/messages\n1767225600000\nnonce_ABCDEFGHIJKL-123\n")).toBe(true);
    expect(Buffer.from(ours, "utf8").toString("hex")).toBe(Buffer.from(serverCanonical("POST", "/api/v1/rooms/general/messages", "1767225600000", "nonce_ABCDEFGHIJKL-123", body), "utf8").toString("hex"));
  });

  it("hashes an empty body as SHA-256('')", async () => {
    const c = await canonicalString("GET", "/api/v1/me", "1767225600000", "n".repeat(16));
    expect(c.endsWith(`\n${EMPTY_BODY_SHA256}`)).toBe(true);
  });

  it("produces signatures the server's verifier accepts (and rejects tampering)", async () => {
    const signer = await createSigner(DEVICE);
    expect(signer.publicKey).toBe(publicKeyOf(SEED));
    const h = await signRequest(signer, "GET", "/api/v1/rooms/general/messages?limit=20&after=5", "", { timestamp: 1767225600000, nonce: "abcdefghijklmnop" });
    const canonical = serverCanonical("GET", "/api/v1/rooms/general/messages?limit=20&after=5", "1767225600000", "abcdefghijklmnop", "");
    expect(h.canonical).toBe(canonical);
    expect(serverVerify(signer.publicKey, canonical, h["X-Claudia-Signature"])).toBe(true);
    expect(serverVerify(signer.publicKey, canonical.replace("limit=20", "limit=21"), h["X-Claudia-Signature"])).toBe(false);
    // ed25519 is deterministic: same input → same signature
    const again = await signRequest(signer, "GET", "/api/v1/rooms/general/messages?limit=20&after=5", "", { timestamp: 1767225600000, nonce: "abcdefghijklmnop" });
    expect(again["X-Claudia-Signature"]).toBe(h["X-Claudia-Signature"]);
  });

  it("the WebCrypto signer (browsers) and the node:crypto signer agree", async () => {
    const msg = new TextEncoder().encode("GET\n/api/v1/me\n1767225600000\nabcdefghijklmnop\n" + EMPTY_BODY_SHA256);
    const a = await (await createSigner(DEVICE, { impl: "node" })).sign(msg);
    const b = await (await createSigner(DEVICE, { impl: "webcrypto" })).sign(msg);
    expect(bs58.encode(a)).toBe(bs58.encode(b));
    expect(serverVerify(publicKeyOf(DEVICE), new TextDecoder().decode(msg), bs58.encode(b))).toBe(true);
  });

  it("the server source still uses the same canonical form (drift guard, skipped without the app checkout)", () => {
    const f = new URL("../../../../DexPumpzip/server/agents/agentauth.ts", import.meta.url);
    if (!existsSync(f)) return;
    const src = readFileSync(f, "utf8");
    expect(src).toContain('[method.toUpperCase(), path, ts, nonce, sha256Hex(body)].join("\\n")');
    expect(src).toContain("canonicalString(req.method, req.originalUrl, ts, nonce, body)");
    expect(src).toContain("SIGNATURE_WINDOW_MS = 5 * 60_000");
  });
});

describe("ClaudiaClient signing on the wire", () => {
  it("signs the exact path+query and body it sends, with fresh nonces", async () => {
    const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: String(init!.method), headers: init!.headers as Record<string, string>, body: init!.body as string | undefined });
      return new Response(JSON.stringify({ data: [], nextCursor: null, ok: true, id: "1" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = new ClaudiaClient({ baseUrl: "http://localhost:5080/", apiKey: "ck_live_" + "x".repeat(44), deviceKey: DEVICE, fetch });
    await c.signed("GET", "/api/v1/rooms/general/messages", { query: { limit: 20, after: "7" } });
    await c.heartbeat();
    await c.post("general", "hello there", { replyTo: 3 });
    const pub = publicKeyOf(DEVICE);
    for (const s of seen) {
      const u = new URL(s.url);
      const canonical = serverCanonical(
        s.method,
        u.pathname + u.search,
        s.headers["x-claudia-timestamp"],
        s.headers["x-claudia-nonce"],
        s.body ?? "",
      );
      expect(serverVerify(pub, canonical, s.headers["x-claudia-signature"])).toBe(true);
      expect(s.headers.authorization).toMatch(/^Bearer ck_live_/);
      expect(s.headers["x-claudia-nonce"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(Math.abs(Number(s.headers["x-claudia-timestamp"]) - Date.now())).toBeLessThan(5_000);
    }
    expect(new URL(seen[0].url).search).toBe("?limit=20&after=7");
    expect(seen[1].body).toBe("{}");
    expect(JSON.parse(seen[2].body!)).toEqual({ content: "hello there", replyTo: "3" });
    expect(new Set(seen.map((s) => s.headers["x-claudia-nonce"])).size).toBe(3);
  });

  it("refuses signed calls without a key", async () => {
    const c = new ClaudiaClient({ baseUrl: "http://x", fetch: async () => new Response("{}") });
    await expect(c.me()).rejects.toMatchObject({ code: "no_api_key" });
  });
});
