// claudia doctor — checks this machine, the connection to Claudia and your setup, and says how to fix each problem.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudiaApiError, McpHttpClient, defaultRpcUrl, getSolBalance } from "@useclaudia/sdk";
import { modeOf } from "@useclaudia/sdk/node";
import { CliError, EXIT, type Ctx } from "../context.js";
import { loadAgentTools } from "../llm.js";
import { readTokens } from "../oauth.js";
import { probe } from "../optional.js";
import { term } from "../term.js";
import { c, log, mask, padEnd, section, sol, sym, title, truncate, wrapText } from "../ui.js";

type Status = "ok" | "warn" | "fail" | "skip";
interface Check {
  group: string;
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

export async function doctor(ctx: Ctx) {
  const checks: Check[] = [];
  const S = sym();
  let group = "";
  const begin = (g: string) => {
    group = g;
    if (!ctx.json) section(g);
  };
  const add = (name: string, status: Status, detail: string, fix?: string) => {
    checks.push({ group, name, status, detail, fix });
    if (ctx.json) return;
    const mark = status === "ok" ? c.buy(S.ok) : status === "warn" ? c.warn(S.warn) : status === "fail" ? c.sell(S.fail) : c.dim(S.dot);
    const nw = term().width >= 80 ? 20 : 14;
    const lines = wrapText(detail, term().width - nw - 8);
    log(`  ${mark} ${padEnd(c.bold(truncate(name, nw)), nw)}  ${status === "skip" ? c.dim(lines[0] ?? "") : lines[0] ?? ""}`);
    for (const l of lines.slice(1)) log(`    ${" ".repeat(nw)}  ${l}`);
    if (fix && status !== "ok") log(`    ${" ".repeat(nw)}  ${c.dim("Try:")} ${fix}`);
  };
  if (!ctx.json) title("Doctor", ctx.baseUrl.replace(/^https?:\/\//, ""));
  const h = ctx.home;

  // ─── this machine ───
  begin("This machine");
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = maj > 18 || (maj === 18 && min >= 17);
  add("Node.js", nodeOk ? "ok" : "fail", `v${process.versions.node}${nodeOk ? "" : " (needs 18.17 or newer)"}${maj < 22 && nodeOk ? c.dim(" · live streams use the ws package on Node < 22") : ""}`, nodeOk ? undefined : "Install Node 20 LTS or newer");
  const t = term();
  add("Terminal", "ok", `${t.width} columns · ${t.color === 3 ? "truecolor" : t.color === 2 ? "256 colours" : t.color === 1 ? "16 colours" : "no colour"} · ${t.unicode ? "Unicode" : "ASCII"}`);

  const dirMode = modeOf(h.dir);
  const tilde = (p: string) => (process.env.HOME && p.startsWith(process.env.HOME) ? "~" + p.slice(process.env.HOME.length) : p);
  if (dirMode === undefined) add("Claudia folder", "warn", `${tilde(h.dir)} doesn't exist yet`, "claudia login (or claudia init for an agent key + wallet)");
  else add("Claudia folder", (dirMode & 0o077) === 0 ? "ok" : "warn", `${tilde(h.dir)} · mode ${dirMode.toString(8)}`, `chmod 700 ${h.dir}`);
  const files: [string, string, boolean][] = [
    ["Device key", h.paths.device, false],
    ["Agent wallet", h.paths.wallet, false],
    ["Credentials", h.paths.credentials, false],
    ["OAuth tokens", join(h.dir, "oauth.json"), false],
    ["Provider keys", join(h.dir, "keys.json"), false],
  ];
  const loose: string[] = [];
  let present = 0;
  for (const [, file] of files) {
    const m = modeOf(file);
    if (m === undefined) continue;
    present++;
    if ((m & 0o077) !== 0) loose.push(file);
  }
  if (present) add("File permissions", loose.length ? "fail" : "ok", loose.length ? `others can read: ${loose.join(", ")}` : `${present} private file(s), owner-only`, loose.length ? `chmod 600 ${loose.join(" ")}` : undefined);

  // ─── Claudia ───
  begin("Claudia");
  const base = ctx.baseUrl;
  let reachable = false;
  try {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    const t1 = Date.now();
    const body = (await r.json().catch(() => null)) as { ok?: boolean; comingSoon?: boolean; version?: string } | null;
    reachable = r.ok && !!body?.ok;
    add("Site", reachable ? (body?.comingSoon ? "warn" : "ok") : "fail", `${base} · HTTP ${r.status} · ${t1 - t0} ms${body?.comingSoon ? " · coming soon (agent API closed)" : ""}`, reachable ? undefined : "Check your connection or --base-url");
    const date = r.headers.get("date");
    if (date) {
      const skew = Date.parse(date) + 500 - (t0 + t1) / 2;
      const abs = Math.abs(skew);
      add("Clock", abs > 5 * 60_000 ? "fail" : abs > 60_000 ? "warn" : "ok", `${abs < 1500 ? "in sync with the server" : `${Math.round(skew / 1000)} s ${skew > 0 ? "behind" : "ahead of"} the server`} (signed requests allow ±5 min)`, "Turn on automatic time in your system settings");
    }
  } catch (e) {
    add("Site", "fail", `${base} not reachable: ${(e as Error).message}`, "Check your connection or --base-url");
  }
  if (reachable) {
    try {
      const s = await ctx.publicClient().insights.status();
      add("Insights", s.gmgn.enabled ? "ok" : "warn", s.gmgn.enabled ? `GMGN data on · cache hit rate ${Math.round((s.gmgn.hitRate ?? 0) * 100)}% · queue ${s.gmgn.queued}${s.gmgn.pausedUntil && s.gmgn.pausedUntil > Date.now() ? " · paused (rate limit)" : ""}` : `GMGN data off on this server${s.gmgn.reason ? ` (${s.gmgn.reason})` : ""} · Claudia's own data still works`);
    } catch (e) {
      add("Insights", "warn", (e as Error).message);
    }
    for (const server of ["data", "trade"] as const) {
      const url = `${base}/mcp/${server}`;
      try {
        const m = new McpHttpClient({ url, timeoutMs: 8_000, clientName: "claudia-doctor" });
        await m.connect();
        await m.close();
        add(`MCP ${server}`, "ok", `${url} · answers MCP`);
      } catch (e) {
        const st = e instanceof ClaudiaApiError ? e.status : 0;
        if (st === 401) add(`MCP ${server}`, "ok", `${url} · reachable (sign-in required)`);
        else if (st === 404 || st === 405) add(`MCP ${server}`, "warn", `${url} · not live on this server yet`);
        else add(`MCP ${server}`, "warn", `${url} · ${(e as Error).message.split("\n")[0]}`);
      }
    }
    try {
      const r = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
      const m = (await r.json().catch(() => null)) as { authorization_endpoint?: string; code_challenge_methods_supported?: string[] } | null;
      const good = r.ok && !!m?.authorization_endpoint;
      add("Sign-in (OAuth)", good ? "ok" : "warn", good ? `discovery published${m?.code_challenge_methods_supported?.includes("S256") ? " · PKCE S256" : ""}` : "no OAuth discovery on this server yet (claudia login uses the default /oauth/* paths)");
    } catch (e) {
      add("Sign-in (OAuth)", "warn", (e as Error).message);
    }
  }

  // ─── you ───
  begin("You");
  const tok = readTokens(h.dir);
  if (!tok) add("Signed in", "warn", "not signed in", "claudia login");
  else {
    const expired = !!tok.expiresAt && tok.expiresAt < Date.now();
    add("Signed in", expired && !tok.refreshToken ? "warn" : "ok", `${tok.scope.join(" ") || "—"} · token ${mask(tok.accessToken)}${expired ? (tok.refreshToken ? " · expired, refreshes on use" : " · expired") : ""}`, "claudia login");
  }
  let deviceOk = false;
  if (h.devicePublicKey()) {
    try {
      deviceOk = !!(await h.deviceSecret());
      add("Device key", "ok", `${h.devicePublicKey()}${h.isEncrypted() ? " (encrypted)" : ""}`);
    } catch (e) {
      add("Device key", "fail", (e as Error).message, "Set CLAUDIA_PASSPHRASE or run in a terminal");
    }
  } else add("Device key", "skip", "none (only needed for an agent API key: claudia init)");
  if (!h.hasApiKey()) add("Agent API key", "skip", "none (claudia login <ck_live_…> to post / trade as an agent)");
  else if (reachable && deviceOk) {
    try {
      const me = await (await ctx.client()).me();
      add("Agent API key", "ok", `valid · ${me.name} @${me.slug} · ${me.tier} · ${me.status}`);
      const local = h.walletAddress();
      if (!me.wallet) add("Agent wallet", "warn", "none registered yet — needed for trades/launches", "claudia passport");
      else add("Agent wallet", me.wallet === local ? "ok" : "fail", me.wallet === local ? `${me.wallet} matches this machine` : `server has ${me.wallet}, this machine has ${local}`);
    } catch (e) {
      const code = e instanceof ClaudiaApiError ? e.code : "";
      const why =
        code === "bad_signature" ? `registered for a different device key — register ${h.devicePublicKey()}`
        : code === "invalid_key" ? "unknown API key — copy it again from the console"
        : code === "key_revoked" ? "this API key was revoked — make a new one"
        : code === "stale_timestamp" ? "your clock is off by more than 5 minutes"
        : (e as Error).message;
      add("Agent API key", "fail", why);
    }
  }
  const addr = h.walletAddress();
  if (addr && reachable) {
    try {
      const p = await ctx.platform();
      const rpc = h.config().rpcUrl ?? defaultRpcUrl(p.network);
      const bal = await getSolBalance(rpc, addr);
      add("Solana RPC", "ok", `${rpc.replace(/(api-key|apikey)=[^&]+/i, "$1=…")} · wallet ${sol(bal)}`);
    } catch (e) {
      add("Solana RPC", "warn", `couldn't read the balance: ${(e as Error).message.split("\n")[0]}`, "claudia config set rpc-url <url>");
    }
  }

  // ─── keys ───
  begin("Your keys");
  try {
    const list = await ctx.keys.list();
    if (!list.length) add("Provider keys", "skip", "none yet (claudia keys set <name>)");
    for (const k of list) add(k.name, "ok", `${mask(k.value)} ${c.dim(`from ${k.from}`)}`);
  } catch (e) {
    add("Provider keys", "warn", (e as Error).message);
  }

  // ─── packages ───
  begin("Optional packages");
  const [media, social, tools] = await Promise.all([probe("@useclaudia/media"), probe("@useclaudia/social"), loadAgentTools()]);
  add("@useclaudia/media", media ? "ok" : "skip", media ? `${media} · claudia generate` : "not installed (npm i -g @useclaudia/media for claudia generate)");
  add("@useclaudia/social", social ? "ok" : "skip", social ? `${social} · claudia post <network>` : "not installed (npm i -g @useclaudia/social for claudia post <network>)");
  add("Tool catalog", tools.source === "catalog" ? "ok" : "skip", tools.source === "catalog" ? `${tools.tools.length} tools from @useclaudia/sdk/tools` : `built-in list (${tools.tools.length} tools) — upgrade @useclaudia/sdk for the full catalog`);
  const ws = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function" ? "built in" : (await probe("ws")) ? "ws package" : null;
  add("WebSocket", ws ? "ok" : "warn", ws ? `${ws} · claudia watch works` : "none — claudia watch <mint> needs Node 22+ or the ws package", "npm i -g ws");

  const failed = checks.filter((x) => x.status === "fail").length;
  const warned = checks.filter((x) => x.status === "warn").length;
  if (!ctx.json) {
    log("");
    if (failed) log(`  ${c.sell(S.fail)} ${c.bold(`${failed} problem(s)`)}${warned ? c.dim(`, ${warned} warning(s)`) : ""}`);
    else log(`  ${c.buy(S.ok)} ${c.bold(warned ? "Works" : "All good")}${warned ? c.dim(` · ${warned} warning(s)`) : ""}`);
  }
  if (failed) throw new CliError(EXIT.ERROR, "doctor_failed", `${failed} check(s) failed`, undefined, { checks });
  return { checks, exists: existsSync(h.dir) };
}
