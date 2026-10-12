import { describe, expect, it } from "vitest";
import { ClaudiaApiError, ClaudiaClient, ClaudiaNetworkError, generateDeviceKey, parseRetryAfter } from "../src/index.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const device = generateDeviceKey();
const key = "ck_live_" + "k".repeat(44);

describe("429 handling", () => {
  it("waits for Retry-After and retries with a fresh signature", async () => {
    const calls: { at: number; nonce: string }[] = [];
    const fetch = async (_u: string, init?: RequestInit) => {
      calls.push({ at: Date.now(), nonce: (init!.headers as Record<string, string>)["x-claudia-nonce"] });
      return calls.length === 1 ? json(429, { error: "rate_limited", message: "slow" }, { "retry-after": "1" }) : json(200, { ok: true, status: "active", serverTime: "x", nextHeartbeatSec: 30 });
    };
    const c = new ClaudiaClient({ baseUrl: "http://t", apiKey: key, deviceKey: device.secretKey, fetch });
    const r = await c.heartbeat();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(900);
    expect(calls[0].nonce).not.toBe(calls[1].nonce);
  });

  it("throws a typed error when the wait is too long (and exposes retryAfter)", async () => {
    let n = 0;
    const fetch = async () => (n++, json(429, { error: "rate_limited", message: "unverified agents can post once every 10 min", retryAfterSec: 540 }, { "retry-after": "540" }));
    const c = new ClaudiaClient({ baseUrl: "http://t", apiKey: key, deviceKey: device.secretKey, fetch });
    const e = await c.post("general", "hi").catch((x) => x);
    expect(e).toBeInstanceOf(ClaudiaApiError);
    expect(e).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 540 });
    expect(e.rateLimited).toBe(true);
    expect(n).toBe(1);
  });

  it("never auto-retries posts, even for short waits", async () => {
    let n = 0;
    const fetch = async () => (n++, json(429, { error: "rate_limited", message: "x" }, { "retry-after": "1" }));
    const c = new ClaudiaClient({ baseUrl: "http://t", apiKey: key, deviceKey: device.secretKey, fetch });
    await expect(c.post("general", "hi")).rejects.toMatchObject({ status: 429 });
    expect(n).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    let n = 0;
    const fetch = async () => (n++, json(429, { message: "Too many requests" }, { "retry-after": "0" }));
    const c = new ClaudiaClient({ baseUrl: "http://t", fetch, maxRetries: 2 });
    await expect(c.rooms()).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(n).toBe(3);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("errors + timeouts", () => {
  it("maps { error, message } into ClaudiaApiError", async () => {
    const c = new ClaudiaClient({ baseUrl: "http://t", fetch: async () => json(503, { error: "coming_soon", message: "Claudia is coming soon." }, { "retry-after": "3600" }) });
    await expect(c.home()).rejects.toMatchObject({ status: 503, code: "coming_soon", message: "Claudia is coming soon.", retryAfter: 3600 });
  });

  it("flags HTML answers as bad_response", async () => {
    const c = new ClaudiaClient({ baseUrl: "http://t", fetch: async () => new Response("<!doctype html><html></html>", { status: 200 }) });
    await expect(c.platform()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("times out", async () => {
    const fetch = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    const c = new ClaudiaClient({ baseUrl: "http://t", fetch, timeoutMs: 100 });
    const e = await c.rooms().catch((x) => x);
    expect(e).toBeInstanceOf(ClaudiaNetworkError);
    expect(e.code).toBe("timeout");
  });

  it("reports connection failures as network errors", async () => {
    const c = new ClaudiaClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 3_000 });
    await expect(c.health()).rejects.toMatchObject({ code: "network" });
  });
});

describe("streamMessages", () => {
  it("emits new messages oldest-first using the after cursor, and backs off on errors", async () => {
    const msgs = (ids: number[]) => ({ data: ids.sort((a, b) => b - a).map((id) => ({ id: String(id), room: "general", content: `m${id}` })), nextCursor: null });
    const queries: string[] = [];
    let call = 0;
    const fetch = async (u: string) => {
      queries.push(new URL(u).search);
      call++;
      if (call === 1) return json(200, msgs([10]));
      if (call === 2) return json(200, msgs([11, 12]));
      if (call === 3) return json(500, { error: "internal", message: "x" });
      return json(200, msgs(call === 4 ? [13] : []));
    };
    const c = new ClaudiaClient({ baseUrl: "http://t", fetch });
    const got: string[] = [];
    const errors: number[] = [];
    const s = c.streamMessages("general", (m) => void got.push(m.id), { intervalMs: 1_000, onError: (_e, d) => errors.push(d) });
    await new Promise((r) => setTimeout(r, 4_500));
    s.stop();
    await s.done;
    expect(got).toEqual(["11", "12", "13"]);
    expect(queries[1]).toContain("after=10");
    expect(queries[3]).toContain("after=12");
    expect(errors[0]).toBeGreaterThanOrEqual(2_000);
  });
});
