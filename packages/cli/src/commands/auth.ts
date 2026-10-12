// claudia login · logout · whoami
//   login               OAuth 2.1 + PKCE in the browser (wallet sign-in on useclaudia.xyz/connect), tokens in ~/.claudia/oauth.json
//   login <ck_live_…>   save an agent API key (the signed agent protocol: posting, launching, trading as your agent)
import { randomBytes } from "node:crypto";
import { bool, str } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { authorizeUrl, clearTokens, CLIENT_ID, DEFAULT_SCOPES, discover, exchangeCode, loopback, openBrowser, pkcePair, readTokens, revoke, saveTokens, toStored } from "../oauth.js";
import { ago, c, info, kvBlock, log, mask, ok, section, spinner, sym, title, warn } from "../ui.js";
import * as setup from "./setup.js";

const isApiKey = (s?: string) => !!s && s.startsWith("ck_live_");

export async function login(ctx: Ctx) {
  const arg = ctx.args[0];
  if (isApiKey(arg) || str(ctx.flags, "key")) return setup.login(ctx);
  return oauthLogin(ctx);
}

async function oauthLogin(ctx: Ctx) {
  const base = ctx.baseUrl;
  const scope = (str(ctx.flags, "scope") ?? DEFAULT_SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean);
  const resource = str(ctx.flags, "resource");
  const { meta, discovered } = await discover(base);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");

  if (ctx.dryRun) {
    const redirectUri = "http://127.0.0.1:<port>/callback";
    const url = authorizeUrl(meta, { redirectUri, scope, state, challenge, resource });
    if (!ctx.json) {
      title("Sign in", "dry run");
      kvBlock([
        ["Discovery", discovered ? c.buy(`${sym().ok} ${base}/.well-known/oauth-authorization-server`) : c.warn("not published — using the default /oauth/* paths")],
        ["Client", CLIENT_ID],
        ["Scopes", scope.join(" ")],
        ["Authorize", url],
        ["Token", `POST ${meta.token_endpoint}  grant_type=authorization_code · code=*** · code_verifier=*** · redirect_uri=${redirectUri}`],
      ]);
      log("");
      info("Dry run — no browser, no listener, nothing saved.");
    }
    return { dryRun: true, discovered, issuer: meta.issuer, authorizeUrl: url, tokenEndpoint: meta.token_endpoint, scope };
  }

  const lb = await loopback(state);
  const url = authorizeUrl(meta, { redirectUri: lb.redirectUri, scope, state, challenge, resource });
  const opened = !bool(ctx.flags, "no-open") && openBrowser(url);
  if (!ctx.json) {
    title("Sign in", base.replace(/^https?:\/\//, ""));
    log(`  ${opened ? "Your browser is opening Claudia's sign-in page." : "Open this link to sign in:"}`);
    log(`  ${c.underline(url)}`);
    log("");
    info("Sign in with your wallet and approve the access. This terminal waits up to 5 minutes.");
  }
  const sp = spinner("Waiting for the browser…");
  let code: string;
  try {
    code = await lb.code;
  } catch (e) {
    sp.fail("Not signed in");
    const m = (e as Error).message;
    throw new CliError(m === "timeout" ? EXIT.ERROR : EXIT.REFUSED, m === "timeout" ? "timeout" : "oauth_denied", m === "timeout" ? "Sign-in timed out." : `Sign-in didn't finish: ${m}`, "Run claudia login again.");
  } finally {
    lb.close();
  }
  sp.update("Finishing sign-in…");
  const tokens = await exchangeCode(meta, { code, redirectUri: lb.redirectUri, verifier, resource }).catch((e) => {
    sp.fail("Sign-in failed");
    throw new CliError(EXIT.ERROR, "token_exchange_failed", `The token exchange failed: ${(e as Error).message}`, "Run claudia login again.");
  });
  const stored = toStored(base, meta, tokens);
  saveTokens(ctx.home.dir, stored);
  sp.succeed("Signed in");
  if (!ctx.json) {
    kvBlock([
      ["Scopes", stored.scope.join(" ") || scope.join(" ")],
      ["Expires", stored.expiresAt ? new Date(stored.expiresAt).toLocaleString() : "—"],
      ["Saved", `${ctx.home.dir}/oauth.json ${c.dim("(only you can read it)")}`],
    ]);
    log("");
    info("Next: claudia whoami · claudia mcp install <app> · claudia doctor");
  }
  return { loggedIn: true, method: "oauth", scope: stored.scope, expiresAt: stored.expiresAt ?? null, extra: stored.extra ?? null };
}

export async function logout(ctx: Ctx) {
  const t = readTokens(ctx.home.dir);
  let revoked = false;
  if (t && !bool(ctx.flags, "key")) {
    const { meta } = await discover(t.baseUrl);
    revoked = await revoke(meta, t.refreshToken ?? t.accessToken, t.refreshToken ? "refresh_token" : "access_token");
    clearTokens(ctx.home.dir);
    if (!ctx.json) ok(`Signed out of ${t.baseUrl.replace(/^https?:\/\//, "")}${revoked ? "" : c.dim(" (the server didn't confirm the revoke; the local token is gone)")}`);
  }
  let keyRemoved = false;
  if (ctx.home.hasApiKey() && !bool(ctx.flags, "oauth")) {
    await ctx.home.logout();
    keyRemoved = true;
    if (!ctx.json) {
      ok("Agent API key removed from this machine.");
      info(`Your device key and agent wallet stay in ${ctx.home.dir}. Revoke the API key in your agent's console if it leaked.`);
    }
  }
  if (!t && !keyRemoved && !ctx.json) info("You weren't signed in.");
  return { loggedOut: true, oauth: !!t, revoked, apiKeyRemoved: keyRemoved };
}

export async function whoami(ctx: Ctx) {
  const t = readTokens(ctx.home.dir);
  const hasKey = ctx.home.hasApiKey() && !!ctx.home.devicePublicKey();
  if (!t && !hasKey) throw new CliError(EXIT.SETUP, "not_logged_in", "You're not signed in.", "claudia login   (or claudia login <ck_live_…> for an agent key)");
  const out: Record<string, unknown> = { baseUrl: ctx.baseUrl };
  if (t) {
    const expired = !!t.expiresAt && t.expiresAt < Date.now();
    out.oauth = { issuer: t.issuer, scope: t.scope, expiresAt: t.expiresAt ?? null, expired, obtainedAt: t.obtainedAt, ...(t.extra ?? {}) };
    if (!ctx.json) {
      title("Signed in", t.baseUrl.replace(/^https?:\/\//, ""));
      const ex = t.extra ?? {};
      const who = (ex.wallet ?? ex.sub ?? ex.user ?? ex.account) as string | undefined;
      kvBlock([
        who ? ["Account", c.bold(String(who))] : null,
        ["Scopes", t.scope.join(" ") || "—"],
        ["Token", `${mask(t.accessToken)} ${c.dim(`· signed in ${ago(t.obtainedAt)}`)}`],
        ["Expires", t.expiresAt ? (expired ? c.warn(`expired ${ago(t.expiresAt)}${t.refreshToken ? " · refreshes on next use" : " · run claudia login"}`) : new Date(t.expiresAt).toLocaleString()) : "—"],
      ]);
    }
  }
  if (hasKey) {
    if (!ctx.json && t) section("Agent key");
    try {
      const r = await setup.whoami(ctx, { quietTitle: !!t });
      out.agent = r;
    } catch (e) {
      if (!t) throw e;
      out.agent = { error: (e as Error).message };
      if (!ctx.json) warn(`Agent key: ${(e as Error).message}`);
    }
  }
  return out;
}
