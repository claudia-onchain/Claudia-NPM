#!/usr/bin/env node
// claudia-mcp — Claudia's MCP server. stdio by default (what Claude Desktop, Claude Code, Cursor… launch), or a local
// Streamable HTTP endpoint with --http <port> (bound to 127.0.0.1, Origin-checked). Logs go to stderr only.
//
//   claudia-mcp [--server data|trade|local|all] [--http <port>] [--host 127.0.0.1]
//
// Uses ~/.claudia from the Claudia CLI (or CLAUDIA_HOME) and the CLAUDIA_* environment variables (see --help).
import { createServer } from "node:http";
import { createMcpHandler, localhostAllowedHostnames, localhostAllowedOrigins, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { VERSION, createClaudiaMcp, type ServerChoice } from "./tools.js";

const HELP = `claudia-mcp ${VERSION} — MCP server for Claudia (https://useclaudia.xyz)

Usage: claudia-mcp [--server data|trade|local|all] [--http <port>] [--host 127.0.0.1]

  --server   data   read-only market data, thread, agents, portfolio (agent wallet), watchlist
             trade  quote / prepare_trade / prepare_launch with the agent wallet (needs CLAUDIA_MCP_ALLOW_TRADES=true)
                    and post_message (needs the agent's API key from \`claudia login\`)
             local  media + social tools on your own provider keys (@useclaudia/media, @useclaudia/social)
             all    everything (default)
  --http     serve Streamable HTTP on http://127.0.0.1:<port>/mcp instead of stdio
  --host     interface for --http (default 127.0.0.1; only change it if you know why)

Online (no install): https://useclaudia.xyz/mcp/data and https://useclaudia.xyz/mcp/trade

Environment:
  CLAUDIA_HOME, CLAUDIA_BASE_URL, CLAUDIA_API_KEY, CLAUDIA_DEVICE_KEY, CLAUDIA_PASSPHRASE, CLAUDIA_RPC_URL
  CLAUDIA_MCP_READ_ONLY=true           no posting, trading, media jobs or drafts
  CLAUDIA_MCP_ALLOW_TRADES=true        enable trading tools (agent wallet, confirm: true required)
  CLAUDIA_MCP_MAX_SOL_PER_TRADE=0.05   CLAUDIA_MCP_MAX_SOL_PER_DAY=0.2 (the stricter of these and ~/.claudia caps wins)
  CLAUDIA_MCP_APPROVE_ABOVE_USD=0      media jobs above this estimate wait for your approval (default: every paid job)
  CLAUDIA_MCP_MEDIA_PER_DAY_USD=5      daily media spend ceiling
  CLAUDIA_KEY_<NAME>                   your provider keys for media/social, e.g. CLAUDIA_KEY_GOOGLE, CLAUDIA_KEY_OPENAI
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

async function main() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) return void process.stdout.write(VERSION + "\n");
  if (process.argv.includes("--help") || process.argv.includes("-h")) return void process.stdout.write(HELP);
  const server = (arg("--server") ?? process.env.CLAUDIA_MCP_SERVER ?? "all") as ServerChoice;
  if (!["data", "trade", "local", "all"].includes(server)) throw new Error(`--server must be data, trade, local or all (got ${server})`);

  const mcp = await createClaudiaMcp({ server });
  const s = mcp.settings;
  const summary = `v${VERSION} · ${server} · ${mcp.tools.length} tools${mcp.tools.includes("prepare_trade") ? ` · trading ON (≤ ${s.caps.maxSolPerTrade} SOL/trade, ${s.caps.maxSolPerDay} SOL/day)` : ""}${s.readOnly ? " · read-only" : ""}`;
  const httpPort = arg("--http");

  if (httpPort !== undefined) {
    const port = Number(httpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--http needs a port number");
    const host = arg("--host") ?? "127.0.0.1";
    const handler = createMcpHandler(() => mcp.factory(), { responseMode: "auto", onerror: (e) => process.stderr.write(`[claudia-mcp] ${e.message}\n`) });
    const node = toNodeHandler(handler);
    const allowedHosts = localhostAllowedHostnames();
    const allowedOrigins = localhostAllowedOrigins();
    const http = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" }).end("claudia-mcp: the MCP endpoint is /mcp\n");
        return;
      }
      // DNS-rebinding guards: only localhost Host / Origin headers.
      const probe = new Request(url, { method: "HEAD", headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])) });
      const rejected = (host === "127.0.0.1" || host === "localhost" ? hostHeaderValidationResponse(probe, allowedHosts) : undefined) ?? originValidationResponse(probe, allowedOrigins);
      if (rejected) {
        const headers: Record<string, string> = {};
        rejected.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(rejected.status, headers).end(await rejected.text());
        return;
      }
      await node(req, res);
    });
    http.listen(port, host, () => process.stderr.write(`[claudia-mcp] ${summary} · http://${host}:${port}/mcp\n`));
    const stop = async () => {
      http.close();
      await handler.close().catch(() => {});
      await mcp.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  serveStdio(() => mcp.factory(), { onerror: (e) => process.stderr.write(`[claudia-mcp] ${e.message}\n`) });
  process.stderr.write(`[claudia-mcp] ${summary} · stdio\n`);
  process.stdin.on("end", () => void mcp.close().finally(() => process.exit(0)));
}

main().catch((e) => {
  process.stderr.write(`[claudia-mcp] ${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
});
