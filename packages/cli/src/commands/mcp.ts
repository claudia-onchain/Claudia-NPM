// claudia mcp install|remove|print|list <app> — writes Claudia's MCP server into an AI app's own config file.
//   --server data|trade   which server (default data: read-only market data, the thread and agents)
//   --local               run it on this machine over stdio (npx -y @useclaudia/mcp) instead of the online server
//   --dry-run             print the diff, write nothing
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bool, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { APPS, findApp, setAppsHome, type AppSpec, type EntryInput, type Mode, type Server } from "../mcp-apps.js";
import { diffLines, hunks, readEntry, upsert } from "../mcp-config.js";
import { term } from "../term.js";
import { c, info, kvBlock, log, ok, section, sym, table, title, truncate, warn } from "../ui.js";

const nameFor = (server: Server) => (server === "trade" ? "claudia-trade" : "claudia");
const tilde = (p: string) => {
  const h = process.env.HOME || process.env.USERPROFILE || "";
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
};

function entryInput(ctx: Ctx, server: Server, mode: Mode): EntryInput {
  const env: Record<string, string> = {};
  if (mode === "local") {
    if (ctx.baseUrl !== "https://useclaudia.xyz") env.CLAUDIA_BASE_URL = ctx.baseUrl;
    if (str(ctx.flags, "home")) env.CLAUDIA_HOME = str(ctx.flags, "home")!;
    // 0.1 servers switch trading on with this; 0.2 reads --server trade.
    if (server === "trade") env.CLAUDIA_MCP_ALLOW_TRADES = "true";
  }
  return {
    server,
    mode,
    url: `${ctx.baseUrl}/mcp/${server}`,
    command: "npx",
    args: ["-y", "@useclaudia/mcp", "--server", server],
    env,
  };
}

function parseOpts(ctx: Ctx): { app: AppSpec; server: Server; mode: Mode } {
  const id = ctx.args[1];
  if (!id) throw new UsageError(`Which app? ${APPS.map((a) => a.id).join(", ")}`);
  const app = findApp(id);
  if (!app) throw new CliError(EXIT.USAGE, "unknown_app", `Unknown app "${id}".`, `Apps: ${APPS.map((a) => a.id).join(", ")}`);
  const server = (str(ctx.flags, "server") ?? "data").toLowerCase();
  if (server !== "data" && server !== "trade") throw new UsageError("--server is data or trade");
  return { app, server, mode: bool(ctx.flags, "local") ? "local" : "remote" };
}

function printDiff(file: string, before: string, after: string) {
  const S = sym();
  log(`  ${c.bold(tilde(file))}${before ? "" : c.dim("  (new file)")}`);
  const lines = hunks(diffLines(before, after), 2);
  const w = term().width - 8;
  for (const l of lines) {
    if (l === null) {
      log(`    ${c.dim(S.ellipsis)}`);
      continue;
    }
    const t = truncate(l.text, w);
    log(l.op === "+" ? `  ${c.buy("+ " + t)}` : l.op === "-" ? `  ${c.sell("- " + t)}` : `  ${c.dim("  " + t)}`);
  }
}

export async function mcp(ctx: Ctx) {
  const sub = ctx.args[0] ?? "list";
  // With --home (a sandboxed Claudia home) the app configs live under <home>/app-configs, never the real ones.
  const appsHome = str(ctx.flags, "apps-home") ?? (str(ctx.flags, "home") ? join(str(ctx.flags, "home")!, "app-configs") : undefined);
  setAppsHome(appsHome ? resolve(appsHome) : undefined);
  if (sub === "list" || sub === "apps") return list(ctx);
  if (sub === "install" || sub === "add") return install(ctx, false);
  if (sub === "remove" || sub === "uninstall") return install(ctx, true);
  if (sub === "print" || sub === "show") return print(ctx);
  if (sub === "url") {
    const urls = { data: `${ctx.baseUrl}/mcp/data`, trade: `${ctx.baseUrl}/mcp/trade` };
    if (!ctx.json) kvBlock([["Data", urls.data], ["Trade", urls.trade]]);
    return urls;
  }
  throw new UsageError("Usage: claudia mcp install|remove|print <app> [--server data|trade] [--local] [--dry-run] · claudia mcp list");
}

async function install(ctx: Ctx, remove: boolean) {
  const { app, server, mode } = parseOpts(ctx);
  const name = nameFor(server);
  const e = entryInput(ctx, server, mode);
  const entry = app.entry(e);
  const { main, extra } = app.files();
  const files = [main, ...extra.filter((f) => f !== main)];
  const results: { file: string; changed: boolean; created: boolean; backup?: string }[] = [];
  if (!ctx.json) title(`${remove ? "Remove from" : "Install in"} ${app.name}`, `${name} ${sym().dot} ${mode === "remote" ? e.url : "local (stdio)"}`);
  for (const file of files) {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    let after: string;
    try {
      after = upsert(app.format, before, app.key, name, remove ? null : entry);
    } catch (err) {
      throw new CliError(EXIT.ERROR, "bad_config", `Couldn't read ${tilde(file)}: ${(err as Error).message}`, `Fix the file, or paste this by hand: claudia mcp print ${app.id}${server === "trade" ? " --server trade" : ""}${mode === "local" ? " --local" : ""}`);
    }
    const changed = after !== before;
    if (!ctx.json) {
      log("");
      if (changed) printDiff(file, before, after);
      else info(`${tilde(file)} — already ${remove ? "without" : "up to date with"} ${name}`);
    }
    let backup: string | undefined;
    if (changed && !ctx.dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      if (before) {
        backup = `${file}.claudia-backup`;
        copyFileSync(file, backup);
      }
      writeFileSync(file, after, { mode: 0o600 });
    }
    results.push({ file, changed, created: !before && !remove && changed, backup });
  }
  if (!ctx.json) {
    log("");
    if (ctx.dryRun) info("Dry run — nothing was written.");
    else if (results.some((r) => r.changed)) ok(`${remove ? "Removed" : "Installed"} ${c.bold(name)} ${remove ? "from" : "in"} ${app.name}${results.some((r) => r.backup) ? c.dim(` (backup: ${tilde(results.find((r) => r.backup)!.backup!)})`) : ""}`);
    else ok("Nothing to change.");
    if (!remove) {
      for (const n of app.notes?.(e, name) ?? []) info(n);
      if (mode === "remote") info(`The app opens ${ctx.baseUrl}/connect the first time to sign in with your wallet.`);
      if (server === "trade") warn("Trade tools prepare trades and launches; you review and sign each one with your own wallet.");
    }
  }
  return { app: app.id, server, mode, name, dryRun: ctx.dryRun, entry: remove ? null : entry, files: results };
}

async function print(ctx: Ctx) {
  const { app, server, mode } = parseOpts(ctx);
  const name = nameFor(server);
  const entry = app.entry(entryInput(ctx, server, mode));
  const snippet = upsert(app.format, app.format === "toml" || app.format === "yaml" ? "" : "{}", app.key, name, entry);
  if (!ctx.json) {
    title(`${app.name} config`, `${name} ${sym().dot} ${mode}`);
    kvBlock([["File", tilde(app.files().main)], ["Format", app.format.toUpperCase()]]);
    log("");
    for (const l of snippet.replace(/\n$/, "").split("\n")) log(`    ${l}`);
  }
  return { app: app.id, file: app.files().main, format: app.format, name, entry, snippet };
}

async function list(ctx: Ctx) {
  const rows = APPS.map((a) => {
    const { main } = a.files();
    const src = existsSync(main) ? readFileSync(main, "utf8") : null;
    const data = src ? readEntry(a.format, src, a.key, "claudia") : null;
    const trade = src ? readEntry(a.format, src, a.key, "claudia-trade") : null;
    return { id: a.id, name: a.name, file: main, exists: src !== null, data: !!data, trade: !!trade };
  });
  if (!ctx.json) {
    title("MCP apps", `${APPS.length} supported`);
    const S = sym();
    table(
      [
        { header: "App", get: (r) => c.bold(r.id), headline: true },
        { header: "Name", get: (r) => r.name, priority: 2 },
        { header: "Claudia", get: (r) => (r.data || r.trade ? c.buy(`${S.ok} ${[r.data ? "data" : "", r.trade ? "trade" : ""].filter(Boolean).join(" + ")}`) : r.exists ? c.dim("not installed") : c.dim("no config yet")), headline: true },
        { header: "Config file", get: (r) => c.dim(tilde(r.file)), priority: 1, min: 12 },
      ],
      rows,
    );
    section("Install");
    log(`  ${c.bold("claudia mcp install <app>")}                ${c.dim("online data server (read-only)")}`);
    log(`  ${c.bold("claudia mcp install <app> --server trade")} ${c.dim("quotes, trades and launches you sign")}`);
    log(`  ${c.bold("claudia mcp install <app> --local")}        ${c.dim("run it on this machine (npx)")}`);
    log(`  ${c.bold("claudia mcp install <app> --dry-run")}      ${c.dim("show the change first")}`);
    log("");
    info(`Any other MCP app: add ${ctx.baseUrl}/mcp/data as a Streamable HTTP server.`);
  }
  return { apps: rows, urls: { data: `${ctx.baseUrl}/mcp/data`, trade: `${ctx.baseUrl}/mcp/trade` } };
}
