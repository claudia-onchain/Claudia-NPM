// Solana helpers: sign the server's unsigned transactions with the agent wallet, send them, confirm them.
//
// The server never sees the wallet's secret key. Launch plans and trade quotes come back as base64 transactions
// (legacy or v0). Some arrive partially signed — a pump.fun creation tx already carries the mint key's signature —
// so signing must ADD the wallet's signature without touching any existing one, and must never change the message
// (the server only accepts the creator's signature over exactly the message it planned).
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, type Commitment } from "@solana/web3.js";
import bs58 from "bs58";
import { ClaudiaConfigError, ClaudiaTxError } from "./errors.js";
import { fromBase64, toBase64, utf8, type SecretInput } from "./encoding.js";
import { toKeypair } from "./keys.js";
import type { PreparedTx } from "./types.js";

export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Public RPC for the platform's network (mainnet → mainnet-beta, testnet → devnet). Use your own RPC for anything serious. */
export function defaultRpcUrl(network: "mainnet" | "testnet" = "mainnet"): string {
  return network === "testnet" ? DEVNET_RPC : MAINNET_RPC;
}

export interface SignedTx {
  /** base64 wire transaction, ready for sendRawTransaction. */
  base64: string;
  /** The fee payer's signature = the transaction id (base58). */
  signature: string;
  description: string;
  version: "legacy" | 0;
}

type Signable = PreparedTx[] | { txs: PreparedTx[] } | { plan: { txs: PreparedTx[] } };

function txsOf(x: Signable): PreparedTx[] {
  if (Array.isArray(x)) return x;
  if ("txs" in x && Array.isArray(x.txs)) return x.txs;
  if ("plan" in x && Array.isArray(x.plan?.txs)) return x.plan.txs;
  throw new ClaudiaConfigError("nothing_to_sign", "Expected a launch plan, a trade quote or a list of prepared transactions");
}

function requiredSigners(tx: VersionedTransaction): string[] {
  const n = tx.message.header.numRequiredSignatures;
  return tx.message.staticAccountKeys.slice(0, n).map((k) => k.toBase58());
}

const isEmptySig = (s: Uint8Array) => s.every((b) => b === 0);

/**
 * Adds the wallet's signature (and any `extraSigners`, e.g. a vanity mint key) to each Solana transaction.
 * Existing signatures are preserved. Throws if the wallet isn't a required signer, or if any required signature is
 * still missing afterwards (the transaction would be rejected by the network anyway).
 */
export function signTransactions(input: Signable, wallet: SecretInput | Keypair, opts: { extraSigners?: (SecretInput | Keypair)[] } = {}): SignedTx[] {
  const kp = toKeypair(wallet);
  const extra = (opts.extraSigners ?? []).map(toKeypair);
  const me = kp.publicKey.toBase58();
  return txsOf(input).map((p, i) => {
    if (p.kind !== "svm") throw new ClaudiaConfigError("unsupported_chain", `Transaction ${i + 1} is an EVM transaction; the SDK signs Solana transactions only`);
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(fromBase64(p.base64));
    } catch (e) {
      throw new ClaudiaTxError("bad_transaction", `Transaction ${i + 1} couldn't be decoded: ${(e as Error).message}`);
    }
    const signers = requiredSigners(tx);
    if (!signers.includes(me)) {
      throw new ClaudiaTxError("wrong_signer", `Transaction ${i + 1} (${p.description}) must be signed by ${signers.join(", ")} — not by this wallet (${me})`);
    }
    const mine = [kp, ...extra.filter((k) => signers.includes(k.publicKey.toBase58()))];
    // VersionedTransaction.sign puts each signature at its signer's index and leaves the others alone.
    tx.sign(mine);
    const missing = signers.filter((s, idx) => isEmptySig(tx.signatures[idx]) && s !== me);
    if (missing.length) {
      throw new ClaudiaTxError("missing_signature", `Transaction ${i + 1} still needs a signature from ${missing.join(", ")}`);
    }
    return {
      base64: toBase64(tx.serialize()),
      signature: bs58.encode(tx.signatures[0]),
      description: p.description,
      version: tx.version === "legacy" ? "legacy" : 0,
    };
  });
}

export function connectionFor(rpc: string | Connection, commitment: Commitment = "confirmed"): Connection {
  return typeof rpc === "string" ? new Connection(rpc, commitment) : rpc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendOptions {
  commitment?: "confirmed" | "finalized";
  skipPreflight?: boolean;
  /** Give up waiting after this long (default 90 s). The tx may still land; check the signature later. */
  timeoutMs?: number;
  /** Re-broadcast the same signed bytes this often until it confirms (default 4 s). */
  resendEveryMs?: number;
  onSent?: (tx: SignedTx, index: number) => void;
  onConfirmed?: (tx: SignedTx, index: number) => void;
}

/** Sends one signed transaction and waits until it is confirmed (or failed / expired). Returns the signature. */
export async function sendAndConfirmOne(signed: SignedTx, rpc: string | Connection, opts: SendOptions = {}): Promise<string> {
  const conn = connectionFor(rpc);
  const raw = fromBase64(signed.base64);
  const commitment = opts.commitment ?? "confirmed";
  const timeout = opts.timeoutMs ?? 90_000;
  const every = opts.resendEveryMs ?? 4_000;
  const tx = VersionedTransaction.deserialize(raw);
  const blockhash = tx.message.recentBlockhash;
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(raw, { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (e) {
    const err = e as Error & { logs?: string[]; transactionLogs?: string[] };
    const logs = err.logs ?? err.transactionLogs;
    throw new ClaudiaTxError("send_failed", `The network refused "${signed.description}": ${err.message.split("\n")[0]}`, { signature: signed.signature, logs });
  }
  const start = Date.now();
  let lastSend = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: false }).catch(() => null))?.value?.[0];
    if (st?.err) throw new ClaudiaTxError("tx_failed", `"${signed.description}" failed on-chain: ${JSON.stringify(st.err)}`, { signature: sig });
    if (st && (st.confirmationStatus === commitment || st.confirmationStatus === "finalized")) return sig;
    if (Date.now() - start > timeout) throw new ClaudiaTxError("confirm_timeout", `"${signed.description}" wasn't confirmed within ${Math.round(timeout / 1000)} s (signature ${sig}) — check it on an explorer before retrying`, { signature: sig });
    if (Date.now() - lastSend > every) {
      lastSend = Date.now();
      const valid = await conn.isBlockhashValid(blockhash, { commitment: "processed" }).then((r) => r.value).catch(() => true);
      if (!valid) {
        const again = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
        if (again && !again.err) return sig;
        throw new ClaudiaTxError("blockhash_expired", `"${signed.description}" expired before it landed (signature ${sig}). Ask for a fresh plan/quote and try again.`, { signature: sig });
      }
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    await sleep(1_200);
  }
}

/** Sends signed transactions strictly in order, each confirmed before the next goes out. Returns their signatures. */
export async function sendAndConfirm(signed: SignedTx[] | SignedTx, rpc: string | Connection, opts: SendOptions = {}): Promise<string[]> {
  const list = Array.isArray(signed) ? signed : [signed];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    opts.onSent?.(list[i], i);
    out.push(await sendAndConfirmOne(list[i], rpc, opts));
    opts.onConfirmed?.(list[i], i);
  }
  return out;
}

/** SOL balance of an address. */
export async function getSolBalance(rpc: string | Connection, address: string): Promise<number> {
  const lamports = await connectionFor(rpc).getBalance(new PublicKey(address), "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * A legacy transaction carrying one SPL Memo, signed by `signer` (e.g. the agent passport:
 * `claudia:passport:<agentId>:<agentWallet>`, signed by the OWNER wallet).
 */
export async function buildMemoTx(rpc: string | Connection, signer: SecretInput | Keypair, memo: string): Promise<SignedTx> {
  const kp = toKeypair(signer);
  const conn = connectionFor(rpc);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight });
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(utf8(memo)) }));
  tx.sign(kp);
  return { base64: toBase64(tx.serialize()), signature: bs58.encode(tx.signature!), description: "Passport memo", version: "legacy" };
}
