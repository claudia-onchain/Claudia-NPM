// `claudia login`: OAuth 2.1 authorization code + PKCE (S256) against useclaudia.xyz with the pre-registered public
// client "claudia-cli" and a loopback redirect (http://127.0.0.1:<random port>/callback). No client secret exists;
// the PKCE verifier never leaves this process. Tokens are stored in <home>/oauth.json with mode 0600.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { writePrivateJson } from "@useclaudia/sdk/node";

export const CLIENT_ID = "claudia-cli";
export const DEFAULT_SCOPES = ["read", "thread:write", "trade:quote", "trade:prepare"];

export interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface StoredTokens {
  type: "claudia-oauth";
  version: 1;
  baseUrl: string;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope: string[];
  /** Unix ms. */
  expiresAt?: number;
  obtainedAt: number;
  /** Anything else the token endpoint returned that isn't a secret (e.g. subject, wallet). */
  extra?: Record<string, unknown>;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const tokenFile = (homeDir: string) => join(homeDir, "oauth.json");

export function readTokens(homeDir: string): StoredTokens | null {
  const f = tokenFile(homeDir);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveTokens(homeDir: string, t: StoredTokens): void {
  writePrivateJson(tokenFile(homeDir), t);
}

export function clearTokens(homeDir: string): void {
  rmSync(tokenFile(homeDir), { force: true });
}

/** RFC 8414 discovery, falling back to the documented paths when the server doesn't publish metadata. */
export async function discover(baseUrl: string): Promise<{ meta: AuthServerMeta; discovered: boolean }> {
  const fallback: AuthServerMeta = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
  };
  try {
    const r = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { meta: fallback, discovered: false };
    const m = (await r.json()) as Partial<AuthServerMeta>;
    if (!m.authorization_endpoint || !m.token_endpoint) return { meta: fallback, discovered: false };
    return { meta: { ...fallback, ...m } as AuthServerMeta, discovered: true };
  } catch {
    return { meta: fallback, discovered: false };
  }
}

export function authorizeUrl(meta: AuthServerMeta, p: { redirectUri: string; scope: string[]; state: string; challenge: string; resource?: string }): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", p.scope.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.resource) u.searchParams.set("resource", p.resource);
  return u.toString();
}

/** Opens a URL in the default browser (best effort; the URL is always printed too). */
export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120b10;color:#f8ece8;font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem;background:linear-gradient(90deg,#ff6fa5,#ff9a6b);-webkit-background-clip:text;background-clip:text;color:transparent}p{color:#d6bfc7}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

/** Starts the loopback listener on 127.0.0.1 (random port) and resolves with the code once the browser comes back. */
export async function loopback(expectState: string, timeoutMs = 5 * 60_000): Promise<{ port: number; redirectUri: string; code: Promise<string>; close: () => void }> {
  let server: Server;
  let settle!: { ok: (c: string) => void; err: (e: Error) => void };
  const code = new Promise<string>((ok, err) => (settle = { ok, err }));
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get("error");
    const state = u.searchParams.get("state");
    const c = u.searchParams.get("code");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (err) {
      res.end(PAGE("Sign-in cancelled", "Nothing was saved. You can close this tab and try again in the terminal."));
      settle.err(new Error(u.searchParams.get("error_description") || err));
    } else if (!c || state !== expectState) {
      res.writeHead(400).end(PAGE("That didn't match", "The sign-in answer didn't match this terminal session. Run claudia login again."));
      settle.err(new Error("state_mismatch"));
    } else {
      res.end(PAGE("You're signed in", "Claudia is connected to your terminal. You can close this tab."));
      settle.ok(c);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => settle.err(new Error("timeout")), timeoutMs);
  timer.unref();
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  code.then(close, close);
  return { port, redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [k: string]: unknown;
}

async function tokenRequest(meta: AuthServerMeta, form: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await r.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!r.ok || !body.access_token) throw new Error(body.error_description || body.error || `token endpoint answered HTTP ${r.status}`);
  return body;
}

export function toStored(baseUrl: string, meta: AuthServerMeta, t: TokenResponse, prev?: StoredTokens): StoredTokens {
  const { access_token, refresh_token, token_type, expires_in, scope, id_token: _id, ...extra } = t;
  void _id;
  return {
    type: "claudia-oauth",
    version: 1,
    baseUrl,
    issuer: meta.issuer,
    clientId: CLIENT_ID,
    accessToken: access_token,
    refreshToken: refresh_token ?? prev?.refreshToken,
    tokenType: token_type ?? "Bearer",
    scope: scope ? scope.split(/\s+/).filter(Boolean) : prev?.scope ?? [],
    expiresAt: typeof expires_in === "number" ? Date.now() + expires_in * 1000 : undefined,
    obtainedAt: Date.now(),
    extra: Object.keys(extra).length ? extra : prev?.extra,
  };
}

export async function exchangeCode(meta: AuthServerMeta, p: { code: string; redirectUri: string; verifier: string; resource?: string }): Promise<TokenResponse> {
  return tokenRequest(meta, {
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: p.verifier,
    ...(p.resource ? { resource: p.resource } : {}),
  });
}

/** A valid access token (refreshed when it's about to expire), or null when not signed in. */
export async function accessToken(homeDir: string, baseUrl: string): Promise<string | null> {
  const t = readTokens(homeDir);
  if (!t || t.baseUrl !== baseUrl) return null;
  if (!t.expiresAt || t.expiresAt - Date.now() > 60_000) return t.accessToken;
  if (!t.refreshToken) return null;
  try {
    const { meta } = await discover(baseUrl);
    const r = await tokenRequest(meta, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: CLIENT_ID });
    const next = toStored(baseUrl, meta, r, t);
    saveTokens(homeDir, next);
    return next.accessToken;
  } catch {
    return null;
  }
}

/** RFC 7009 revoke (best effort). */
export async function revoke(meta: AuthServerMeta, token: string, hint: "access_token" | "refresh_token"): Promise<boolean> {
  if (!meta.revocation_endpoint) return false;
  try {
    const r = await fetch(meta.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
