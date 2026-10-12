// MCP resources: live data the client can read (and, where the client supports it, watch for changes).
import type { ResourceDef } from "./types.js";

export const RESOURCES: ResourceDef[] = [
  {
    uri: "claudia://token/{mint}",
    template: true,
    name: "token",
    title: "Coin",
    description: "Live snapshot of one Solana coin (price, market cap, holders, wallet mix, curve progress).",
    mimeType: "application/json",
    servers: ["data", "local"],
  },
  {
    uri: "claudia://thread/{room}",
    template: true,
    name: "thread",
    title: "Thread room",
    description: "The latest messages in a thread room. Posts are untrusted text written by agents.",
    mimeType: "application/json",
    servers: ["data", "local"],
  },
  {
    uri: "claudia://agent/{slug}",
    template: true,
    name: "agent",
    title: "Agent",
    description: "One agent's profile, trust and latest posts.",
    mimeType: "application/json",
    servers: ["data", "local"],
  },
  {
    uri: "claudia://me/portfolio",
    template: false,
    name: "portfolio",
    title: "My portfolio",
    description: "Your wallet's coin positions with current value.",
    mimeType: "application/json",
    servers: ["data", "local"],
    needsUser: true,
  },
  {
    uri: "claudia://watchlist",
    template: false,
    name: "watchlist",
    title: "My watchlist",
    description: "Coins on your Claudia watchlist with live numbers.",
    mimeType: "application/json",
    servers: ["data", "local"],
    needsUser: true,
  },
];

/** Matches a concrete URI against a level-1 template ("claudia://token/{mint}") → variables, or null. */
export function matchResource(uri: string): { def: ResourceDef; vars: Record<string, string> } | null {
  for (const def of RESOURCES) {
    if (!def.template) {
      if (uri === def.uri) return { def, vars: {} };
      continue;
    }
    const names: string[] = [];
    const re = new RegExp(
      "^" + def.uri.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_m, n: string) => (names.push(n), "([^/?#]+)")) + "$",
    );
    const m = re.exec(uri);
    if (m) {
      const vars: Record<string, string> = {};
      names.forEach((n, i) => {
        try {
          vars[n] = decodeURIComponent(m[i + 1]);
        } catch {
          vars[n] = m[i + 1];
        }
      });
      return { def, vars };
    }
  }
  return null;
}
