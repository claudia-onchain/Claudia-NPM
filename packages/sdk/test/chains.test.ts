import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAIN_ORDER,
  ClaudiaClient,
  ClaudiaConfigError,
  chainStatusFrom,
  decodeSecret,
  evmAddressOf,
  generateEvmWallet,
  isEvmAddress,
  parseChain,
  toTokenKey,
  type PlatformConfig,
} from "../src/index.js";
import { ClaudiaHome, checkCaps, DEFAULT_CAPS } from "../src/node/index.js";
import { DATA_HANDLERS, TOOLS, coinKey, coinSummary, toolByName } from "../src/tools/index.js";

const cfg = {
  chains: [
    { chain: "sol", state: "open", note: null },
    { chain: "hood", state: "open", note: "Robinhood Chain launches (Beta)" },
    { chain: "bsc", state: "coming_soon", note: "soon" },
    { chain: "base", state: "coming_soon", note: null },
  ],
  launchpads: [
    { launchpad: "pump", chain: "sol", state: "open", effective: "open", allowAgents: true, note: null },
    { launchpad: "pons", chain: "hood", state: "open", effective: "open", allowAgents: true, note: null },
    { launchpad: "trench", chain: "hood", state: "open", effective: "hidden", allowAgents: false, note: null },
  ],
} as unknown as PlatformConfig;

describe("chains", () => {
  it("lists exactly sol, hood, bsc with Solana first", () => {
    expect(CHAIN_ORDER).toEqual(["sol", "hood", "bsc"]);
  });
  it("parses aliases and refuses retired chains", () => {
    expect(parseChain(undefined)).toBe("sol");
    expect(parseChain("Robinhood")).toBe("hood");
    expect(parseChain("bnb")).toBe("bsc");
    expect(() => parseChain("base")).toThrow(/no longer supported/);
    expect(() => parseChain("eth")).toThrow(ClaudiaConfigError);
  });
  it("folds the platform config into live / beta / coming soon", () => {
    const s = chainStatusFrom(cfg);
    expect(s.map((x) => [x.id, x.status])).toEqual([["sol", "live"], ["hood", "beta"], ["bsc", "coming_soon"]]);
    expect(s[1].launchpads.map((p) => p.launchpad)).toEqual(["pons"]);
  });
  it("client.assertChainOpen refuses coming-soon chains", async () => {
    const client = new ClaudiaClient({ fetch: (async () => new Response(JSON.stringify(cfg), { headers: { "content-type": "application/json" } })) as never });
    await expect(client.assertChainOpen("bsc")).rejects.toMatchObject({ code: "chain_coming_soon" });
    await expect(client.assertChainOpen("hood")).resolves.toMatchObject({ status: "beta" });
  });
});

describe("token keys", () => {
  it("maps bare 0x addresses to Robinhood keys (lower-cased)", () => {
    expect(toTokenKey("0x7314B6880a8ee81622acb70de4b21e087f2cc7ff")).toBe("hood:0x7314b6880a8ee81622acb70de4b21e087f2cc7ff");
    expect(toTokenKey("HOOD:0x7314B6880a8ee81622acb70de4b21e087f2cc7ff")).toBe("hood:0x7314b6880a8ee81622acb70de4b21e087f2cc7ff");
    expect(toTokenKey("2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM")).toBe("sol:2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM");
    expect(() => toTokenKey("2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM", "hood")).toThrow(/Solana mint/);
  });
});

describe("EVM keys", () => {
  it("derives the right address (known vector) and generates valid wallets", () => {
    expect(evmAddressOf("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318")).toBe("0x2c7536E3605D9C16a7a3D7b1898e529396a65c23");
    const w = generateEvmWallet();
    expect(isEvmAddress(w.address)).toBe(true);
    expect(evmAddressOf(w.privateKey)).toBe(w.address);
  });
  it("never echoes a bad key", () => {
    try {
      evmAddressOf("0xnotakeynotakeynotakey");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("notakey");
    }
  });
  it("never echoes a malformed JSON secret", () => {
    expect(() => decodeSecret("[12, 34, secretpart")).toThrow("Secret key JSON is not valid JSON");
  });
});

describe("home: EVM wallet + ETH caps", () => {
  it("stores the EVM key next to the Solana wallet, sealed with the same passphrase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudia-test-"));
    const home = new ClaudiaHome({ dir, env: {} });
    home.createKeys({ passphrase: "correct horse" });
    const { address } = await home.createEvmWallet();
    const file = join(dir, "evm-wallet.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.secretKey).toBeUndefined();
    expect(raw.encrypted).toBeTruthy();
    const fresh = new ClaudiaHome({ dir, env: {} });
    expect(fresh.evmAddress()).toBe(address);
    await expect(fresh.evmPrivateKey()).rejects.toMatchObject({ code: "passphrase_required" });
    fresh.setPassphrase("correct horse");
    expect(evmAddressOf((await fresh.evmPrivateKey())!)).toBe(address);
    await expect(fresh.createEvmWallet()).rejects.toMatchObject({ code: "already_initialized" });
  });
  it("tracks ETH spend separately from SOL", () => {
    const home = new ClaudiaHome({ dir: mkdtempSync(join(tmpdir(), "claudia-test-")), env: {} });
    home.recordSpend({ kind: "buy", chain: "hood", native: 0.003 });
    home.recordSpend({ kind: "buy", sol: 0.01 });
    expect(home.spentToday("hood")).toBeCloseTo(0.003);
    expect(home.spentToday()).toBeCloseTo(0.01);
    expect(() => checkCaps(0.02, DEFAULT_CAPS, 0, "hood")).toThrow(/ETH/);
    expect(() => checkCaps(0.01, DEFAULT_CAPS, 0, "bsc")).toThrow(/coming soon/);
  });
});

describe("catalog", () => {
  it("has chain params, the new tools and the server's ticker limit", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["get_chains", "get_launch_fees", "inbox"]));
    const launch = toolByName("prepare_launch")!;
    expect(launch.input.properties!.symbol.maxLength).toBe(16);
    expect(launch.input.properties!.symbol.description).toMatch(/13/);
    for (const n of ["get_board", "get_trending", "get_feed", "quote", "prepare_trade", "prepare_launch"]) expect(toolByName(n)!.input.properties!.chain).toBeTruthy();
    expect(toolByName("inbox")!.server).toBe("local");
  });
  it("coin keys accept Robinhood tokens and refuse BNB Chain for now", () => {
    expect(coinKey("0x7314B6880a8ee81622acb70de4b21e087f2cc7ff")).toBe("hood:0x7314b6880a8ee81622acb70de4b21e087f2cc7ff");
    expect(coinKey("claudia")).toMatch(/^sol:/);
    expect(() => coinKey("bsc:0x7314B6880a8ee81622acb70de4b21e087f2cc7ff")).toThrow(/coming soon/);
  });
  it("reports wallet shares as percent (the board sends fractions)", () => {
    const c = coinSummary({ key: "hood:0xabc", chain: "hood", address: "0xabc", top10Pct: 0.2467, devHoldPct: 0.05, bondingPct: 31 }, "https://useclaudia.xyz");
    expect(c.top10Pct).toBe(24.7);
    expect(c.devHoldPct).toBe(5);
    expect(c.bondingPct).toBe(31);
    expect(c.url).toBe("https://useclaudia.xyz/t/hood/0xabc");
  });
  it("get_chains reads the platform config", async () => {
    const out = await DATA_HANDLERS.get_chains({}, { baseUrl: "https://useclaudia.xyz", get: async () => ({ ...cfg, split: { creatorBps: 7000, platformBps: 3000 } }) });
    expect((out.structured.chains as { id: string; status: string }[]).map((c) => c.status)).toEqual(["live", "beta", "coming_soon"]);
    expect(out.text).toMatch(/Robinhood Chain \(hood\): beta/);
  });
});
