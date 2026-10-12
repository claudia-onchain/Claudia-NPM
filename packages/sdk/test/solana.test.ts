import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { signTransactions, type PreparedTx } from "../src/index.js";

const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 7));

function v0Tx(payer: Keypair, mint: Keypair, preSignMint: boolean): PreparedTx {
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint.publicKey, lamports: 1 });
  // make the mint a required signer too (like pump.fun create_v2)
  ix.keys.push({ pubkey: mint.publicKey, isSigner: true, isWritable: true });
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (preSignMint) tx.sign([mint]);
  return { kind: "svm", base64: Buffer.from(tx.serialize()).toString("base64"), signers: [payer.publicKey.toBase58()], partiallySigned: preSignMint, description: "create" };
}

function legacyTx(payer: Keypair): PreparedTx {
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey("11111111111111111111111111111112"), lamports: 5 }));
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { kind: "svm", base64: Buffer.from(bytes).toString("base64"), signers: [payer.publicKey.toBase58()], partiallySigned: false, description: "buy" };
}

const verifies = (tx: VersionedTransaction, idx: number, pub: PublicKey) =>
  edVerify(null, Buffer.from(tx.message.serialize()), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.toBuffer()]), format: "der", type: "spki" }), Buffer.from(tx.signatures[idx]));

describe("signTransactions", () => {
  it("adds the wallet signature to a partially signed v0 tx and keeps the mint signature intact", () => {
    const wallet = Keypair.generate();
    const mint = Keypair.generate();
    const prepared = v0Tx(wallet, mint, true);
    const before = VersionedTransaction.deserialize(Buffer.from(prepared.base64, "base64"));
    const mintSigBefore = Buffer.from(before.signatures[1]).toString("hex");
    const [signed] = signTransactions({ plan: { txs: [prepared] } }, bs58.encode(wallet.secretKey));
    const after = VersionedTransaction.deserialize(Buffer.from(signed.base64, "base64"));
    expect(Buffer.from(after.signatures[1]).toString("hex")).toBe(mintSigBefore);
    expect(verifies(after, 0, wallet.publicKey)).toBe(true);
    expect(verifies(after, 1, mint.publicKey)).toBe(true);
    // the message is untouched (the server only accepts signatures over its planned bytes)
    expect(Buffer.from(after.message.serialize()).equals(Buffer.from(before.message.serialize()))).toBe(true);
    expect(signed.signature).toBe(bs58.encode(after.signatures[0]));
    expect(signed.version).toBe(0);
  });

  it("signs legacy transactions (trade quotes)", () => {
    const wallet = Keypair.generate();
    const [signed] = signTransactions({ txs: [legacyTx(wallet)] }, wallet.secretKey);
    const after = VersionedTransaction.deserialize(Buffer.from(signed.base64, "base64"));
    expect(after.version).toBe("legacy");
    expect(verifies(after, 0, wallet.publicKey)).toBe(true);
  });

  it("refuses a transaction this wallet isn't a signer of", () => {
    const other = Keypair.generate();
    expect(() => signTransactions([legacyTx(other)], Keypair.generate())).toThrowError(/must be signed by/);
  });

  it("refuses when another required signature is still missing (unless supplied)", () => {
    const wallet = Keypair.generate();
    const mint = Keypair.generate();
    const p = v0Tx(wallet, mint, false);
    expect(() => signTransactions([p], wallet)).toThrowError(/still needs a signature/);
    const [ok] = signTransactions([p], wallet, { extraSigners: [mint] });
    const t = VersionedTransaction.deserialize(Buffer.from(ok.base64, "base64"));
    expect(verifies(t, 1, mint.publicKey)).toBe(true);
  });

  it("rejects EVM transactions", () => {
    expect(() => signTransactions([{ kind: "evm", chainId: 1, to: "0x", data: "0x", value: "0", description: "x" }], Keypair.generate())).toThrowError(/EVM/);
  });
});
