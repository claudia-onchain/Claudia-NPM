// A tiny mock Solana JSON-RPC for local end-to-end tests (never used against real networks).
// It "lands" every transaction it receives, reports it confirmed, and serves it back from getTransaction in the
// jsonParsed shape the Claudia server reads for passports (memo + signer). Every balance is 1 SOL.
//
//   node scripts/mock-solana-rpc.mjs 5089
import http from "node:http";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";

const port = Number(process.argv[2] ?? 5089);
const MEMO = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const landed = new Map(); // signature → { signers, memos }
let slot = 1000;

function decode(b64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const n = tx.message.header.numRequiredSignatures;
  const memos = [];
  for (const ix of tx.message.compiledInstructions) {
    if (MEMO.has(keys[ix.programIdIndex])) memos.push(Buffer.from(ix.data).toString("utf8"));
  }
  return { signature: bs58.encode(tx.signatures[0]), signers: keys.slice(0, n), keys, memos };
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const ctx = () => ({ slot: ++slot });

function handle(m) {
  const p = m.params ?? [];
  switch (m.method) {
    case "getLatestBlockhash":
      return ok(m.id, { context: ctx(), value: { blockhash: bs58.encode(Buffer.alloc(32, slot % 251)), lastValidBlockHeight: slot + 150 } });
    case "isBlockhashValid":
      return ok(m.id, { context: ctx(), value: true });
    case "getBalance":
      return ok(m.id, { context: ctx(), value: 1_000_000_000 });
    case "sendTransaction": {
      const d = decode(p[0]);
      landed.set(d.signature, d);
      process.stderr.write(`[mock-rpc] landed ${d.signature.slice(0, 12)}… memos=${JSON.stringify(d.memos)}\n`);
      return ok(m.id, d.signature);
    }
    case "getSignatureStatuses":
      return ok(m.id, { context: ctx(), value: (p[0] ?? []).map((s) => (landed.has(s) ? { slot, confirmations: null, err: null, confirmationStatus: "confirmed" } : null)) });
    case "getTransaction": {
      const d = landed.get(p[0]);
      if (!d) return ok(m.id, null);
      return ok(m.id, {
        slot,
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, innerInstructions: [] },
        transaction: {
          signatures: [d.signature],
          message: {
            accountKeys: d.keys.map((k) => ({ pubkey: k, signer: d.signers.includes(k), writable: false })),
            staticAccountKeys: d.keys,
            instructions: d.memos.map((memo) => ({ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo })),
          },
        },
      });
    }
    case "getAccountInfo":
    case "getMultipleAccounts":
      return ok(m.id, { context: ctx(), value: m.method === "getAccountInfo" ? null : (p[0] ?? []).map(() => null) });
    default:
      return ok(m.id, { context: ctx(), value: [] });
  }
}

http
  .createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let out;
      try {
        const body = JSON.parse(b || "{}");
        out = Array.isArray(body) ? body.map(handle) : handle(body);
      } catch (e) {
        out = { jsonrpc: "2.0", id: null, error: { code: -32600, message: String(e.message ?? e) } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  })
  .listen(port, "127.0.0.1", () => process.stdout.write(`${port}\n`));
