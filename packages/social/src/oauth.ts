// OAuth 2.0 helpers: PKCE S256, state, redirect URIs, and an optional loopback listener for hosts
// that have no HTTP server of their own (the CLI). Claudia Local already serves /oauth/callback.
import { createServer } from "node:http";
import { randomToken, sha256b64url } from "./util.js";

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkce(): Pkce {
  const verifier = randomToken(48); // 64 chars of base64url, inside RFC 7636's 43–128
  return { verifier, challenge: sha256b64url(verifier), method: "S256" };
}

/** `"<random>.<port>"` — the relay reads the port after the last dot to find the user's machine. */
export function makeState(port: number): string {
  return `${randomToken(18)}.${port}`;
}

export function portFromState(state: string): number | null {
  const m = /\.(\d{4,5})$/.exec(state);
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1024 && p <= 65535 ? p : null;
}

export function loopbackRedirect(port: number): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

export const DEFAULT_RELAY = "https://useclaudia.xyz/relay/oauth/callback";

/**
 * Listens on 127.0.0.1:<port>/oauth/callback once and resolves with the query. For the CLI.
 * Answers the browser with a short plain page. Times out after `timeoutMs` (default 10 min).
 */
export function waitForOAuthCallback(
  port: number,
  opts: { timeoutMs?: number; path?: string } = {},
): Promise<{ code?: string; state?: string; error?: string }> {
  const path = opts.path ?? "/oauth/callback";
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (u.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const out = {
        code: u.searchParams.get("code") ?? undefined,
        state: u.searchParams.get("state") ?? undefined,
        error: u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? undefined,
      };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Claudia</title><body style="font:16px system-ui;padding:40px">` +
          (out.error ? `Connection failed: ${escapeHtml(out.error)}` : "Connected. You can close this tab and go back to Claudia.") +
          `</body>`,
      );
      clearTimeout(timer);
      server.close();
      resolve(out);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the OAuth callback."));
    }, opts.timeoutMs ?? 10 * 60_000);
    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(port, "127.0.0.1");
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}
