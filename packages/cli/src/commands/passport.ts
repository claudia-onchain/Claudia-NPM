// passport — bind the agent id to its wallet on-chain with an SPL Memo signed by the OWNER wallet:
//   claudia:passport:<agentId>:<agentWallet>
// Without --owner-keypair this only explains what to do. With it, the owner key is read from the file, used in
// memory to sign in + sign the memo, and never written anywhere.
import { existsSync, readFileSync } from "node:fs";
import { ClaudiaOwner, buildMemoTx, explorerUrl, getSolBalance, publicKeyOf, sendAndConfirmOne, toKeypair } from "@useclaudia/sdk";
import { str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { c, info, kv, log, ok, sol, title, warn } from "../ui.js";

export async function passport(ctx: Ctx) {
  const me = await ctx.me();
  const local = ctx.home.walletAddress();
  const wallet = me.wallet ?? local;
  if (!wallet) throw new CliError(EXIT.SETUP, "no_wallet", "No agent wallet on this machine.", "Run: claudia init");
  const memo = `claudia:passport:${me.id}:${wallet}`;
  const consoleUrl = `${ctx.baseUrl}/a/${me.slug}/console`;

  if (me.passport) {
    if (!ctx.json) {
      ok(`${me.name} already has a passport ${c.dim(me.passport.tx)}`);
      kv("Wallet", me.passport.wallet);
      kv("Owner", me.passport.owner);
    }
    return { already: true, passport: me.passport };
  }

  const file = str(ctx.flags, "owner-keypair");
  if (!file) {
    if (!ctx.json) {
      title("Passport");
      log(`  A passport is a tiny on-chain note signed by ${c.bold("your owner wallet")} (${me.ownerWallet ?? "the wallet you signed in with"}).`);
      log("  It proves this agent and its wallet belong to you. Launching needs it; it also helps reach verified.");
      log("");
      kv("Memo", c.bold(memo));
      kv("Agent wallet", wallet + (me.wallet ? "" : c.dim(" (will be registered with the passport)")));
      log("");
      log(`  ${c.cyan("1.")} Easiest: open ${consoleUrl} → Passport, and sign with your wallet.`);
      log(`  ${c.cyan("2.")} Or from here, with your owner keypair file (solana-keygen JSON):`);
      log(`     ${c.bold("claudia passport --owner-keypair ~/owner.json")}`);
      info("The owner key is only used in memory for this one transaction and is never stored.");
    }
    return { already: false, memo, wallet, consoleUrl, instructionsOnly: true };
  }

  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  const owner = toKeypair(readFileSync(file, "utf8").trim());
  {
    const ownerAddr = publicKeyOf(owner);
    if (me.ownerWallet && ownerAddr !== me.ownerWallet) {
      throw new CliError(EXIT.REFUSED, "not_owner", `That keypair is ${ownerAddr}, but this agent's owner is ${me.ownerWallet}.`);
    }
    if (ctx.home.walletAddress() === ownerAddr) warn("The owner wallet is the same as the agent wallet — keeping them separate is safer.");
    const network = await ctx.network();
    const rpc = await ctx.rpcUrl();
    const bal = await getSolBalance(rpc, ownerAddr).catch(() => null);
    const owners = new ClaudiaOwner({ baseUrl: ctx.baseUrl });
    await owners.signIn(owner);
    const pinfo = await owners.passportInfo(me.slug, wallet);
    if (!pinfo.memo) throw new CliError(EXIT.ERROR, "no_memo", "The server didn't return a passport memo.");
    if (!ctx.json) {
      title("Passport");
      kv("Agent", `${me.name} @${me.slug}`);
      kv("Memo", c.bold(pinfo.memo));
      kv("Signed by", `${ownerAddr} (owner) · ${sol(bal)}`);
      kv("Cost", "one network fee (≈ 0.000005 SOL)");
      kv("Network", network);
      log("");
    }
    if (bal !== null && bal < 0.00001 && !ctx.dryRun) throw new CliError(EXIT.REFUSED, "insufficient_sol", "The owner wallet needs a little SOL for the network fee.", `Send ~0.001 SOL to ${ownerAddr}.`);
    if (ctx.dryRun) {
      if (!ctx.json) info("Dry run — nothing was signed or sent.");
      return { dryRun: true, memo: pinfo.memo, owner: ownerAddr, wallet };
    }
    await ctx.confirmOrRefuse("Sign and send the passport memo with the owner wallet?");
    const tx = await buildMemoTx(rpc, owner, pinfo.memo);
    if (!ctx.json) info("Sending the memo…");
    const sig = await sendAndConfirmOne(tx, rpc);
    if (!ctx.json) info(`Confirmed ${explorerUrl("tx", sig, network)} — registering…`);
    let profile;
    for (let i = 0; ; i++) {
      try {
        profile = await owners.registerPassport(me.slug, sig, me.wallet ? undefined : wallet);
        break;
      } catch (e) {
        if ((e as { code?: string }).code === "tx_not_found" && i < 5) {
          await new Promise((r) => setTimeout(r, 3_000));
          continue;
        }
        throw e;
      }
    }
    await owners.signOut();
    if (!ctx.json) ok(`Passport registered for ${me.name} · wallet ${profile.wallet}`);
    return { registered: true, tx: sig, passport: profile.passport, wallet: profile.wallet };
  }
}
