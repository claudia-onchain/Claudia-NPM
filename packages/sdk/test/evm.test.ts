// @useclaudia/sdk/evm against a local mock JSON-RPC (no network): validation, local signing, ordered sends, confirm.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudiaClient, type PlannedLaunch, type PreparedTx } from "../src/index.js";
import { ClaudiaEvm, sendEvmTransactions } from "../src/evm/index.js";

const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ADDR = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const TO = "0xe682a076cBa3d36943Bc2608D225AF8690Fc54Ba";

let server: Server;
let rpcUrl = "";
const sent: string[] = [];
let revertNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = JSON.parse(body);
      const one = (c: { id: number; method: string; params: unknown[] }) => {
        const r = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
        switch (c.method) {
          case "eth_chainId": return r("0x1237"); // 4663
          case "eth_getTransactionCount": return r(`0x${sent.length.toString(16)}`);
          case "eth_estimateGas": return r("0x5208");
          case "eth_gasPrice": return r("0x3b9aca00");
          case "eth_maxPriorityFeePerGas": return r("0x3b9aca00");
          case "eth_getBlockByNumber": return r({ number: "0x10", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", hash: "0x" + "11".repeat(32), transactions: [] });
          case "eth_blockNumber": return r("0x10");
          case "eth_getBalance": return r("0xde0b6b3a7640000");
          case "eth_sendRawTransaction": {
            const h = "0x" + (sent.length + 1).toString(16).padStart(64, "0");
            sent.push(h);
            return r(h);
          }
          case "eth_getTransactionReceipt": {
            const status = revertNext ? "0x0" : "0x1";
            revertNext = false;
            return r({ transactionHash: c.params[0], status, blockNumber: "0x10", blockHash: "0x" + "11".repeat(32), logs: [], gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", from: ADDR, to: TO, transactionIndex: "0x0", type: "0x2", logsBloom: "0x" + "00".repeat(256), contractAddress: null });
          }
          default: return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: `no ${c.method}` } };
        }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(one) : one(calls)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tx = (over: Partial<Extract<PreparedTx, { kind: "evm" }>> = {}): PreparedTx => ({ kind: "evm", chainId: 4663, to: TO, data: "0x", value: "1000", description: "test", ...over });

describe("sendEvmTransactions", () => {
  it("refuses a batch for the wrong chain before sending anything", async () => {
    const before = sent.length;
    await expect(sendEvmTransactions([tx(), tx({ chainId: 1 })], KEY, { rpcUrl })).rejects.toMatchObject({ code: "wrong_chain" });
    expect(sent.length).toBe(before);
  });
  it("signs locally and sends in order, waiting for each receipt", async () => {
    const hashes = await sendEvmTransactions([tx(), tx({ value: "0" })], KEY, { rpcUrl, receiptTimeoutMs: 5_000 });
    expect(hashes).toHaveLength(2);
    expect(hashes[1] > hashes[0]).toBe(true);
  });
  it("stops at a revert and reports what was sent", async () => {
    revertNext = true;
    await expect(sendEvmTransactions([tx(), tx()], KEY, { rpcUrl, receiptTimeoutMs: 5_000 })).rejects.toMatchObject({ code: "reverted", hashes: [expect.any(String)] });
  });
});

describe("ClaudiaEvm.executeLaunch", () => {
  it("checks the creator, sends the plan and confirms with Claudia", async () => {
    const confirmed: unknown[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/launch/confirm")) {
        confirmed.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ launch: { id: "launch123", status: "confirmed", token: "0xabc0000000000000000000000000000000000001" } }), { headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as never;
    const client = new ClaudiaClient({ baseUrl: "http://claudia.test", fetch: fetchMock });
    const evm = new ClaudiaEvm(client, { privateKey: KEY, rpcUrl });
    expect(evm.address).toBe(ADDR);
    const plan = {
      id: "launch123",
      createdAt: Date.now(),
      plan: {
        request: { chain: "hood", launchpad: "pons", name: "Kitty", symbol: "KITTY", imageUri: "ipfs://x", socials: {}, creator: ADDR.toLowerCase(), devBuyNative: 0, slippageBps: 1500 },
        txs: [tx({ value: "0" })],
        predicted: { token: "0xabc0000000000000000000000000000000000001", splitter: "0xdef0000000000000000000000000000000000002" },
        fees: { launchFeeNative: 0, devBuyNative: 0, estGasNative: 0.0001, totalNative: 0.0001 },
        split: { creatorBps: 7000, platformBps: 3000, mechanism: "FeeSplitter", creator: ADDR, platform: "0x8f50591D3C8C30A2c62437574e8843133Ba77FbC", warnings: [] },
        devBuyPreview: { tokensOut: 0, supplyPct: 0, priceImpactPct: 0, snipeTaxPct: 0 },
        simulation: { ok: true },
      },
    } as unknown as PlannedLaunch;
    const r = await evm.executeLaunch(plan);
    expect(r.hashes).toHaveLength(1);
    expect(r.token).toBe("0xabc0000000000000000000000000000000000001");
    expect(confirmed).toEqual([{ id: "launch123", hashes: r.hashes }]);
    await expect(evm.executeLaunch({ ...plan, plan: { ...plan.plan, request: { ...plan.plan.request, creator: TO } } })).rejects.toMatchObject({ code: "wallet_mismatch" });
    await expect(evm.executeLaunch({ ...plan, plan: { ...plan.plan, simulation: { ok: false, error: "out of gas" } } })).rejects.toMatchObject({ code: "simulation_failed" });
  });
});
