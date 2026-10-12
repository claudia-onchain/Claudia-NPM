// Where each AI app keeps its MCP servers and what an entry looks like (checked against each app's docs, Oct 2026).
//
//   remote  → the app talks to https://useclaudia.xyz/mcp/<data|trade> over Streamable HTTP (and signs in itself)
//   local   → the app starts `npx -y @useclaudia/mcp --server <data|trade>` over stdio on this machine
//
// Docs: Claude Code code.claude.com/docs/en/mcp · Claude Desktop modelcontextprotocol.io/docs/develop/connect-local-servers
// · Cursor cursor.com/docs/context/mcp · VS Code code.visualstudio.com/docs/copilot/reference/mcp-configuration
// · Windsurf/Devin docs.devin.ai/desktop/cascade/mcp · Zed zed.dev/docs/ai/mcp · Codex developers.openai.com/codex/mcp
// · Gemini CLI geminicli.com/docs/tools/mcp-server · Qwen Code qwenlm.github.io/qwen-code-docs/en/users/features/mcp
// · Grok Build docs.x.ai/build/features/mcp-servers · LM Studio lmstudio.ai/docs/app/mcp · Cline docs.cline.bot/mcp/configuring-mcp-servers
// · Goose goose-docs.ai/docs/guides/config-files
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Server = "data" | "trade";
export type Mode = "remote" | "local";
export type Format = "json" | "jsonc" | "toml" | "yaml";

export interface EntryInput {
  server: Server;
  mode: Mode;
  url: string;
  /** For local mode. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AppSpec {
  id: string;
  name: string;
  aliases: string[];
  format: Format;
  /** Path of keys to the servers object, e.g. ["mcpServers"]. TOML: table prefix ("mcp_servers"). YAML: top key. */
  key: string[];
  /** Files to write (first = main). Extra files are only written when they already exist. */
  files: () => { main: string; extra: string[] };
  entry: (e: EntryInput) => Record<string, unknown>;
  /** Shown after install: how to do it with the app's own CLI, or what to click. */
  notes?: (e: EntryInput, name: string) => string[];
}

let homeOverride: string | undefined;
/**
 * Root for every app config path. `claudia mcp … --home <dir>` (or --apps-home) points it inside that directory so
 * list / install --dry-run never read or touch the real app configs; APPDATA / XDG_CONFIG_HOME are ignored then.
 */
export function setAppsHome(dir: string | undefined): void {
  homeOverride = dir || undefined;
}
const H = () => homeOverride ?? homedir();
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const appData = () => (homeOverride ? undefined : process.env.APPDATA) || join(H(), "AppData", "Roaming");
const xdg = () => (homeOverride ? undefined : process.env.XDG_CONFIG_HOME) || join(H(), ".config");
/** An env override for an app's config location, ignored while sandboxed. */
const envPath = (name: string) => (homeOverride ? undefined : process.env[name]);
const vscodeUser = () => (isMac ? join(H(), "Library", "Application Support", "Code", "User") : isWin ? join(appData(), "Code", "User") : join(xdg(), "Code", "User"));

const stdio = (e: EntryInput) => ({ command: e.command, args: e.args, ...(Object.keys(e.env).length ? { env: e.env } : {}) });
const onlyIfExists = (...paths: string[]) => paths.filter((p) => existsSync(p));

export const APPS: AppSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    aliases: ["claude", "claudecode"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({ main: join(H(), ".claude.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { type: "http", url: e.url } : { type: "stdio", ...stdio(e) }),
    notes: (e, name) => [
      `Same thing with Claude Code's own CLI: ${e.mode === "remote" ? `claude mcp add --transport http --scope user ${name} ${e.url}` : `claude mcp add --scope user ${name} -- ${e.command} ${e.args.join(" ")}`}`,
      "Then run /mcp inside Claude Code to sign in.",
    ],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    aliases: ["claude-app", "desktop"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({
      main: isMac ? join(H(), "Library", "Application Support", "Claude", "claude_desktop_config.json") : isWin ? join(appData(), "Claude", "claude_desktop_config.json") : join(xdg(), "Claude", "claude_desktop_config.json"),
      extra: [],
    }),
    // The config file only takes local (stdio) servers: remote goes through the mcp-remote bridge.
    entry: (e) => (e.mode === "remote" ? { command: "npx", args: ["-y", "mcp-remote", e.url] } : stdio(e)),
    notes: (e) =>
      e.mode === "remote"
        ? ["Claude Desktop's config file only runs local servers, so this uses the mcp-remote bridge.", `Or add it as a connector instead: Settings → Connectors → Add custom connector → ${e.url}`, "Restart Claude Desktop to load it."]
        : ["Restart Claude Desktop to load it."],
  },
  {
    id: "cursor",
    name: "Cursor",
    aliases: [],
    format: "json",
    key: ["mcpServers"],
    files: () => ({ main: join(H(), ".cursor", "mcp.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : stdio(e)),
    notes: () => ["Cursor picks it up in Settings → MCP (toggle it on if it's off)."],
  },
  {
    id: "vscode",
    name: "VS Code (Copilot)",
    aliases: ["code", "copilot", "vs-code"],
    format: "jsonc",
    key: ["servers"],
    files: () => ({ main: join(vscodeUser(), "mcp.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { type: "http", url: e.url } : { type: "stdio", ...stdio(e) }),
    notes: (e, name) => [`Or with VS Code's CLI: code --add-mcp '${JSON.stringify({ name, ...(e.mode === "remote" ? { type: "http", url: e.url } : { type: "stdio", ...stdio(e) }) })}'`, "Open the Chat view in Agent mode to use the tools."],
  },
  {
    id: "windsurf",
    name: "Windsurf (Devin Desktop)",
    aliases: ["devin", "codeium"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({
      main: isWin ? join(appData(), "devin", "mcp_config.json") : join(xdg(), "devin", "mcp_config.json"),
      extra: onlyIfExists(join(H(), ".codeium", "windsurf", "mcp_config.json")),
    }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : stdio(e)),
    notes: () => ["Refresh the MCP list in Cascade (or restart the app) to load it."],
  },
  {
    id: "zed",
    name: "Zed",
    aliases: [],
    format: "jsonc",
    key: ["context_servers"],
    files: () => ({ main: isWin ? join(appData(), "Zed", "settings.json") : join(xdg(), "zed", "settings.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : stdio(e)),
    notes: () => ["Zed reloads settings on save; check the Agent panel's settings for the server's status."],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    aliases: ["openai-codex"],
    format: "toml",
    key: ["mcp_servers"],
    files: () => ({ main: join(envPath("CODEX_HOME") || join(H(), ".codex"), "config.toml"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : stdio(e)),
    notes: (e, name) => [`Same with Codex's CLI: ${e.mode === "remote" ? `codex mcp add ${name} --url ${e.url}` : `codex mcp add ${name} -- ${e.command} ${e.args.join(" ")}`}`, e.mode === "remote" ? `Sign in: codex mcp login ${name}` : ""].filter(Boolean),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    aliases: ["gemini-cli"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({ main: join(H(), ".gemini", "settings.json"), extra: [] }),
    // httpUrl = Streamable HTTP (plain url means SSE in Gemini CLI).
    entry: (e) => (e.mode === "remote" ? { httpUrl: e.url } : stdio(e)),
    notes: (e, name) => [`Same with Gemini's CLI: ${e.mode === "remote" ? `gemini mcp add -s user -t http ${name} ${e.url}` : `gemini mcp add -s user ${name} ${e.command} ${e.args.join(" ")}`}`, "Check it with /mcp inside Gemini CLI."],
  },
  {
    id: "qwen",
    name: "Qwen Code",
    aliases: ["qwen-code"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({ main: join(H(), ".qwen", "settings.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { httpUrl: e.url } : stdio(e)),
    notes: (e, name) => [`Same with Qwen's CLI: ${e.mode === "remote" ? `qwen mcp add -t http ${name} ${e.url}` : `qwen mcp add ${name} ${e.command} ${e.args.join(" ")}`}`],
  },
  {
    id: "grok",
    name: "Grok Build (xAI)",
    aliases: ["grok-build", "xai"],
    format: "toml",
    key: ["mcp_servers"],
    files: () => ({ main: join(H(), ".grok", "config.toml"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : { ...stdio(e), startup_timeout_sec: 30 }),
    notes: (e, name) => [
      `Same with Grok's CLI: ${e.mode === "remote" ? `grok mcp add --transport http ${name} ${e.url}` : `grok mcp add ${name} -- ${e.command} ${e.args.join(" ")}`}`,
      "Grok also reads ~/.claude.json and .cursor/mcp.json — install it in one place to avoid loading it twice.",
    ],
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    aliases: ["lmstudio"],
    format: "json",
    key: ["mcpServers"],
    files: () => ({ main: join(H(), ".lmstudio", "mcp.json"), extra: [] }),
    entry: (e) => (e.mode === "remote" ? { url: e.url } : stdio(e)),
    notes: () => ["LM Studio loads it from the Program tab (Install → Edit mcp.json shows it)."],
  },
  {
    id: "cline",
    name: "Cline",
    aliases: [],
    format: "json",
    key: ["mcpServers"],
    files: () => {
      const main = envPath("CLINE_MCP_SETTINGS_PATH") || join(envPath("CLINE_DATA_DIR") || join(envPath("CLINE_DIR") || join(H(), ".cline"), "data"), "settings", "cline_mcp_settings.json");
      return { main, extra: onlyIfExists(join(vscodeUser(), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")) };
    },
    // Without type, Cline treats a URL as legacy SSE.
    entry: (e) => (e.mode === "remote" ? { type: "streamableHttp", url: e.url, disabled: false, autoApprove: [] } : { ...stdio(e), disabled: false, autoApprove: [] }),
    notes: () => ["Cline 4+ reads ~/.cline/data/settings; older versions read VS Code's globalStorage (updated too when it exists)."],
  },
  {
    id: "goose",
    name: "Goose",
    aliases: ["block-goose"],
    format: "yaml",
    key: ["extensions"],
    files: () => ({ main: isWin ? join(appData(), "Block", "goose", "config", "config.yaml") : join(xdg(), "goose", "config.yaml"), extra: [] }),
    entry: (e) =>
      e.mode === "remote"
        ? { type: "streamable_http", name: e.server === "trade" ? "claudia-trade" : "claudia", enabled: true, uri: e.url, headers: {}, env_keys: [], envs: {}, timeout: 300 }
        : { type: "stdio", name: e.server === "trade" ? "claudia-trade" : "claudia", enabled: true, cmd: e.command, args: e.args, env_keys: [], envs: e.env, timeout: 300 },
    notes: () => ["Restart Goose (or run goose session) to load the extension."],
  },
];

export function findApp(id: string): AppSpec | undefined {
  const k = id.toLowerCase().replace(/[\s_]+/g, "-");
  return APPS.find((a) => a.id === k || a.aliases.includes(k));
}
