// claudia post <network> "text" [--media file] · claudia connect <network> · claudia accounts — via @useclaudia/social
// with the user's own developer apps / tokens. Every post: preview (labels, cost, warnings) → confirm → publish once.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bool, camelName, numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { openBrowser } from "../oauth.js";
import { loadSocial, NETWORK_IDS, type Account, type NetworkId, type Post, type Preview, type Social } from "../optional.js";
import { ago, c, info, kvBlock, log, ok, section, spinner, sym, table, title, usd, warn, wrap } from "../ui.js";

export const isNetwork = (s: string | undefined): s is NetworkId => !!s && (NETWORK_IDS as readonly string[]).includes(s.toLowerCase());

/** The loopback port for OAuth callbacks: fixed (3939) because X wants the exact registered callback URL. */
export const DEFAULT_OAUTH_PORT = 3939;

async function openSocial(ctx: Ctx, extra: { loopbackPort?: number } = {}): Promise<Social> {
  const { createSocial } = await loadSocial();
  // Connected accounts' tokens are sealed with this key; make one the first time (it never leaves this machine).
  if (!(await ctx.keys.get("social-vault")) && !ctx.dryRun) await ctx.keys.set("social-vault", randomBytes(32).toString("base64url"));
  const social = createSocial({
    keys: ctx.keys,
    dataDir: ctx.home.dir,
    dryRun: ctx.dryRun,
    relayUrl: `${ctx.baseUrl}/relay/oauth/callback`,
    mediaRelay: { url: `${ctx.baseUrl}/relay/media`, token: () => ctx.oauthToken() },
    loopbackPort: extra.loopbackPort ?? DEFAULT_OAUTH_PORT,
  });
  await social.ready?.();
  return social;
}

const GLOBAL_FLAGS = new Set(["json", "yes", "dry-run", "base-url", "rpc-url", "home", "no-color", "ascii", "width", "account", "media", "alt", "no-ai-label", "no-open", "link", "quiet", "port"]);

// ─── post ─────────────────────────────────────────────────────────────

export async function socialPost(ctx: Ctx) {
  const network = ctx.args[0].toLowerCase() as NetworkId;
  const text = ctx.args.slice(1).join(" ").trim() || str(ctx.flags, "text") || "";
  if (!text) throw new UsageError(`Usage: claudia post ${network} "<text>" [--media <file>] [--account <id>]`);
  const mediaPaths = (str(ctx.flags, "media") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((p) => resolve(p));
  for (const p of mediaPaths) if (!existsSync(p)) throw new UsageError(`No such file: ${p}`);
  const social = await openSocial(ctx);
  try {
    const info0 = social.networks().find((n) => n.id === network);
    const accounts = social.accounts().filter((a) => a.network === network || a.via === network);
    const wanted = str(ctx.flags, "account");
    const account = wanted ? accounts.find((a) => a.id === wanted || a.handle.replace(/^@/, "") === wanted.replace(/^@/, "")) : accounts.length === 1 ? accounts[0] : undefined;
    if (!accounts.length) throw new CliError(EXIT.SETUP, "not_connected", `No ${info0?.name ?? network} account connected.`, `claudia connect ${network}`);
    if (!account) throw new CliError(EXIT.USAGE, "pick_account", `You have ${accounts.length} ${network} accounts — pick one.`, `--account ${accounts.map((a) => a.id).join(" | ")}`);

    const post: Post = social.draft({
      text,
      media: mediaPaths.length ? mediaPaths.map((path) => ({ path, alt: str(ctx.flags, "alt") })) : undefined,
      link: str(ctx.flags, "link"),
      targets: [{ account: account.id }],
      labels: { ai: !bool(ctx.flags, "no-ai-label") },
    });
    const previews = social.preview(post.id);
    if (!ctx.json) {
      title(`Post to ${info0?.name ?? network}`, `${account.handle}${account.via ? ` via ${account.via}` : ""}`);
      for (const p of previews) printPreview(p, info0?.limits.maxChars);
    }
    const blocked = previews.find((p) => p.blocked);
    if (blocked) {
      social.reject(post.id, blocked.blocked);
      throw new CliError(EXIT.REFUSED, "blocked", `Not posted. ${blocked.blocked}`, "Change the text and try again.");
    }
    if (ctx.dryRun) {
      const d = await social.publish(post.id, { dryRun: true });
      if (!ctx.json && "dryRun" in d) {
        section("Request it would send");
        for (const r of d.requests) {
          kvBlock([["Request", `${r.method} ${r.url}`], ["Headers", Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n")], r.body !== undefined ? ["Body", JSON.stringify(r.body, null, 2).slice(0, 1500)] : null]);
        }
        log("");
        info("Dry run — nothing was posted.");
      }
      return { dryRun: true, post: post.id, previews, requests: "dryRun" in d ? d.requests : [] };
    }
    const cost = previews.reduce((a, p) => a + (p.costUsd ?? 0), 0);
    await ctx.confirmOrRefuse(`Publish this${cost ? ` (costs about ${usd(cost, { exact: true })} on your account)` : ""}?`, "this posts publicly on your account");
    social.submit(post.id);
    social.approve(post.id);
    const sp = spinner("Publishing…");
    const r = (await social.publish(post.id)) as Post;
    sp.stop();
    const S = sym();
    if (!ctx.json) {
      for (const res of r.results) {
        if (res.status === "published") ok(`Published ${S.dot} ${res.url ?? res.remoteId ?? ""}`);
        else warn(`${res.network}: ${res.status}${res.error ? ` — ${res.error}` : ""}`);
      }
    }
    if (r.status === "failed") throw new CliError(EXIT.ERROR, "publish_failed", r.results.map((x) => x.error).filter(Boolean).join("; ") || "Publishing failed.");
    return { post: r };
  } finally {
    await social.close();
  }
}

function printPreview(p: Preview, maxChars?: number) {
  const S = sym();
  log("");
  log(wrap(p.text, undefined, "    "));
  log("");
  kvBlock([
    ["Length", `${p.chars}${maxChars ? ` / ${maxChars}` : ""} characters${maxChars && p.chars > maxChars ? c.sell(" — too long") : ""}`],
    p.media ? ["Media", `${p.media} file(s)`] : null,
    p.labelsAdded.length ? ["Labels added", c.info(p.labelsAdded.join(` ${S.dot} `))] : null,
    ["Cost", p.costUsd ? usd(p.costUsd, { exact: true }) : c.dim("none on this network")],
  ]);
  for (const w of p.warnings) warn(w);
  if (p.blocked) log(`  ${c.sell(`${S.fail} ${p.blocked.replace(/^Blocked:\s*/i, "Blocked: ")}`)}`);
}

// ─── connect / accounts / disconnect ──────────────────────────────────

export async function connect(ctx: Ctx) {
  const network = ctx.args[0]?.toLowerCase();
  if (!isNetwork(network)) throw new UsageError(`Usage: claudia connect <${NETWORK_IDS.slice(0, 8).join("|")}|…> [--port 3939]`);
  const params: Record<string, string> = {};
  // Flags arrive kebab-case (--webhook-url, or --webhookUrl folded by the parser); connectors read camelCase params.
  for (const [k, v] of Object.entries(ctx.flags)) if (typeof v === "string" && !GLOBAL_FLAGS.has(k)) params[camelName(k)] = v;
  const port = numFlag(ctx.flags, "port") ?? DEFAULT_OAUTH_PORT;
  params.port = String(port);
  const mod = await loadSocial();
  const social = await openSocial(ctx, { loopbackPort: port });
  try {
    const n = social.networks().find((x) => x.id === network);
    if (!ctx.json) {
      title(`Connect ${n?.name ?? network}`, n ? `${n.auth} ${sym().dot} ${n.tier}` : undefined);
      if (n?.setup) log(wrap(n.setup, undefined, "  "));
      if (n?.costHint) info(n.costHint);
      log("");
    }
    if (ctx.dryRun) {
      const d = await social.connect(network, params, { dryRun: true });
      if (!ctx.json) {
        if ("authorizeUrl" in d) kvBlock([["Authorize", d.authorizeUrl], ["Callback", d.redirectUri ?? `http://127.0.0.1:${port}/oauth/callback`]]);
        else if ("requests" in d) for (const r of d.requests) kvBlock([["Request", `${r.method} ${r.url}`], ["Headers", Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n")]]);
        log("");
        info("Dry run — nothing was opened, sent or saved.");
      }
      return { dryRun: true, network, result: d };
    }
    const r = await social.connect(network, params);
    let account: Account;
    if ("authorizeUrl" in r) {
      if (!mod.waitForOAuthCallback) throw new CliError(EXIT.SETUP, "old_package", "This @useclaudia/social can't take OAuth callbacks.", "npm i -g @useclaudia/social@^0.2.0");
      const waiting = mod.waitForOAuthCallback(port, { timeoutMs: 5 * 60_000 });
      const opened = !bool(ctx.flags, "no-open") && openBrowser(r.authorizeUrl);
      if (!ctx.json) {
        log(`  ${opened ? "Your browser is opening the sign-in page." : "Open this link to connect:"}`);
        log(`  ${c.underline(r.authorizeUrl)}`);
        info(`Waiting on ${r.redirectUri ?? `http://127.0.0.1:${port}/oauth/callback`} (register exactly this URL in your developer app).`);
      }
      const sp = spinner("Waiting for the browser…");
      const cb = await waiting.catch((e) => ({ error: (e as Error).message }) as { code?: string; state?: string; error?: string });
      sp.stop();
      if (cb.error || !cb.code || !cb.state) throw new CliError(EXIT.ERROR, "oauth_failed", `Not connected: ${cb.error ?? "no code came back"}`, "claudia connect " + network);
      account = await social.completeOAuth(cb.state, cb.code);
    } else if ("dryRun" in r) {
      return { dryRun: true, network, result: r };
    } else account = r;
    if (!ctx.json) ok(`Connected ${c.bold(account.handle)} on ${n?.name ?? network} ${c.dim(`(${account.id})`)}`);
    return { account };
  } finally {
    await social.close();
  }
}

export async function accounts(ctx: Ctx) {
  const social = await openSocial(ctx);
  try {
    const list = social.accounts();
    const nets = new Map(social.networks().map((n) => [n.id, n]));
    if (!ctx.json) {
      title("Accounts", `${list.length} connected`);
      table(
        [
          { header: "Network", get: (a) => c.bold(nets.get(a.network)?.name ?? a.network), headline: true },
          { header: "Account", get: (a) => a.handle, headline: true },
          { header: "Id", get: (a) => c.dim(a.id) },
          { header: "Connected", get: (a) => c.dim(ago(a.connectedAt)), priority: 2 },
          { header: "Expires", get: (a) => (a.expiresAt ? (a.expiresAt < Date.now() ? c.warn("expired") : c.dim(new Date(a.expiresAt).toLocaleDateString())) : c.dim("—")), priority: 1 },
          { header: "Via", get: (a) => c.dim(a.via ?? "direct"), priority: 3 },
        ],
        list,
        { empty: "No accounts yet. Connect one: claudia connect <network>" },
      );
      if (bool(ctx.flags, "all")) {
        section("Networks");
        table(
          [
            { header: "Id", get: (n) => c.bold(n.id), headline: true },
            { header: "Name", get: (n) => n.name, headline: true },
            { header: "Sign-in", get: (n) => n.auth },
            { header: "Status", get: (n) => n.tier },
            { header: "Cost", get: (n) => c.dim(n.costHint ?? "—"), priority: 1 },
          ],
          [...nets.values()],
        );
      } else info("All networks: claudia accounts --all · disconnect: claudia disconnect <id>");
    }
    return { accounts: list };
  } finally {
    await social.close();
  }
}

export async function disconnect(ctx: Ctx) {
  const id = ctx.args[0];
  if (!id) throw new UsageError("Usage: claudia disconnect <account id> (see claudia accounts)");
  const social = await openSocial(ctx);
  try {
    if (ctx.dryRun) return { dryRun: true, account: id };
    await ctx.confirmOrRefuse(`Disconnect ${id}?`, "this removes the account's tokens from this machine");
    await social.disconnect(id);
    if (!ctx.json) ok(`Disconnected ${id}`);
    return { disconnected: id };
  } finally {
    await social.close();
  }
}
