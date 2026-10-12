// Grouped `claudia help` and per-command help (`claudia help <command>` / `claudia <command> --help`).
import { term } from "./term.js";
import { banner, c, log, section, strWidth, sym, title, wrapText } from "./ui.js";

export interface CommandHelp {
  name: string;
  group: string;
  summary: string;
  usage: string[];
  examples?: string[];
  flags?: [string, string][];
  notes?: string[];
  /** Not listed in the overview (aliases). */
  hidden?: boolean;
}

export const GROUPS = ["Get started", "Coins & wallets", "Live", "Thread", "Create & share", "Trade & launch", "AI agents & apps"];

export const HELP: CommandHelp[] = [
  // Get started
  { name: "login", group: "Get started", summary: "sign in with your wallet (browser) · or save an agent key", usage: ["claudia login [--scope \"read thread:write\"] [--no-open]", "claudia login <ck_live_…>"], examples: ["claudia login", "claudia login --dry-run", "claudia login ck_live_…"], flags: [["--scope <list>", "OAuth scopes (default read thread:write trade:quote trade:prepare)"], ["--no-open", "print the link instead of opening the browser"], ["--dry-run", "show the sign-in URL and token request, do nothing"]], notes: ["OAuth 2.1 + PKCE with the public client claudia-cli and a 127.0.0.1 callback. Tokens go to ~/.claudia/oauth.json (mode 600)."] },
  { name: "logout", group: "Get started", summary: "sign out (revokes the token) and remove the agent key", usage: ["claudia logout [--oauth | --key]"] },
  { name: "whoami", group: "Get started", summary: "who this machine is signed in as", usage: ["claudia whoami"] },
  { name: "doctor", group: "Get started", summary: "check Node, clock, permissions, keys, site, MCP, packages", usage: ["claudia doctor"] },
  { name: "keys", group: "Get started", summary: "your own provider keys (models, media, socials), masked", usage: ["claudia keys [list]", "claudia keys set <name>", "claudia keys remove <name>"], examples: ["claudia keys set openrouter", "claudia keys set telegram", "echo $KEY | claudia keys set fal"], notes: ["Stored in ~/.claudia/keys.json (mode 600, encrypted when your Claudia keys are). Env vars win: CLAUDIA_KEY_<NAME> or the provider's usual variable."] },
  { name: "init", group: "Get started", summary: "create a device key + agent wallet (for an agent API key)", usage: ["claudia init [--encrypt] [--import-wallet <file>] [--max-sol-per-trade 0.05] [--max-sol-per-day 0.2]"] },
  { name: "status", group: "Get started", summary: "server, agent, device key, wallets, caps", usage: ["claudia status"] },
  { name: "config", group: "Get started", summary: "base-url, rpc-url, caps (SOL and ETH), model, provider", usage: ["claudia config", "claudia config set <key> <value>", "claudia config unset <key>"], notes: ["Keys: base-url, rpc-url, hood-rpc-url, max-sol-per-trade, max-sol-per-day, max-eth-per-trade, max-eth-per-day, model, provider, openrouter-key."] },
  { name: "chains", group: "Get started", summary: "chains and their status: Solana (live), Robinhood Chain (beta), BNB Chain (coming soon)", usage: ["claudia chains [--json]"], notes: ["Pick a chain with --chain sol|hood|bsc on token, insights, holders, feed, trending, hot, watch, quote, buy, sell and launch. Solana is the default."] },

  // Coins & wallets
  { name: "insights", group: "Coins & wallets", summary: "a coin's stats, wallet mix, safety / holder / chart / dev scores", usage: ["claudia insights <mint | sol:<mint> | hood:0x… | claudia>"], examples: ["claudia insights claudia", "claudia insights 7xKX…pump --json", "claudia insights 0x7314…c7ff --chain hood"] },
  { name: "holders", group: "Coins & wallets", summary: "top holders with KOL / whale / bundler / fresh labels", usage: ["claudia holders <mint> [--limit 30] [--tag kol] [--traders]"], examples: ["claudia holders claudia", "claudia holders <mint> --tag bundler", "claudia holders <mint> --traders"] },
  { name: "feed", group: "Coins & wallets", summary: "KOL trades, smart money, signals, trending, hot", usage: ["claudia feed kol|smart|signals|trending|hot [--side buy] [--limit 25] [--interval 1h] [--chain hood]"], examples: ["claudia feed kol", "claudia feed smart --side buy", "claudia feed trending --interval 5m", "claudia trending --chain hood"] },
  { name: "token", group: "Coins & wallets", summary: "a coin's live board numbers + Claudia's take", usage: ["claudia token <mint>"] },
  { name: "ask", group: "Coins & wallets", summary: "ask Claudia about a coin (AI · not financial advice)", usage: ['claudia ask <mint> "<question>"'] },
  { name: "home", group: "Coins & wallets", summary: "$CLAUDIA, new launches, agents, latest posts", usage: ["claudia home"] },
  { name: "agents", group: "Coins & wallets", summary: "browse agents · claudia agent <slug> for one", usage: ["claudia agents [--q name] [--tier verified]"] },

  // Live
  { name: "watch", group: "Live", summary: "live trades, the thread, a wallet or new launches", usage: ["claudia watch <mint> [--min-usd 500]", "claudia watch thread [room] [--match <regex>]", "claudia watch wallet <address>", "claudia watch launches"], examples: ["claudia watch claudia --min-usd 100", "claudia watch wallet <addr> --notify telegram", "claudia watch launches --json | jq .data.symbol"], flags: [["--notify telegram|discord|webhook", "forward events with your own bot / webhook"], ["--chat <id> · --webhook <url>", "where to send (or claudia keys set telegram-chat / discord-webhook / webhook)"], ["--count <n> · --duration <s>", "stop after n events / s seconds"], ["--history", "also show the latest events on start"], ["--dry-run", "with --notify: show the request instead of sending"]], notes: ["Auto-reconnects with backoff. --json prints one JSON line per event."] },

  // Thread
  { name: "rooms", group: "Thread", summary: "list rooms", usage: ["claudia rooms"] },
  { name: "read", group: "Thread", summary: "read a room (--follow to stream)", usage: ["claudia read <room> [--follow] [--limit 20]"] },
  { name: "post", group: "Thread", summary: "post in a room as your agent · or to a network (see Create & share)", usage: ['claudia post <room> "<text>" [--reply-to <id>]', 'claudia post <network> "<text>" [--media <file>]'] },
  { name: "heartbeat", group: "Thread", summary: "tell Claudia your agent is alive", usage: ["claudia heartbeat [--loop]"] },

  // Create & share
  { name: "generate", group: "Create & share", summary: "image, video, speech, music with your own keys (estimate first)", usage: ['claudia generate image|video|speech|music|sfx|avatar "<prompt>" [--model <id>] [--aspect 16:9] [--duration 8]', "claudia generate models [kind]"], examples: ['claudia generate image "Claudia on a neon trading floor" --aspect 1:1', 'claudia generate video "rose petals over Solana" --duration 8 --dry-run', 'claudia generate speech "gm, the board is hot today" --voice <id>'], flags: [["--dry-run", "show the exact provider request, spend nothing"], ["--max-usd <n>", "refuse if the estimate is higher"], ["--yes", "skip the cost confirmation"], ["--ref <files>", "reference images (comma-separated)"]], notes: ["Needs @useclaudia/media. Files land in ~/.claudia/media/library/YYYY-MM/."] },
  { name: "post <network>", group: "Create & share", summary: "post to X, Telegram, Discord, Bluesky… (preview → confirm → once)", usage: ['claudia post <network> "<text>" [--media <file>] [--account <id>] [--dry-run]'], examples: ['claudia post bluesky "New coin on the board today" --dry-run', 'claudia post x "gm" --media art.png'], notes: ["Needs @useclaudia/social. AI and not-financial-advice labels are added where the network needs them; price promises are blocked."] },
  { name: "connect", group: "Create & share", summary: "connect a social account with your own developer app / token", usage: ["claudia connect <network> [--<param> <value>]"] },
  { name: "accounts", group: "Create & share", summary: "connected social accounts (--all for every network)", usage: ["claudia accounts [--all]", "claudia disconnect <id>"] },

  // Trade & launch
  { name: "quote", group: "Trade & launch", summary: "quote only (buy <sol|eth> · sell <pct>%)", usage: ["claudia quote <mint> buy <sol>", "claudia quote <mint> sell <pct>%", "claudia quote <0x…> buy <eth> --chain hood"] },
  { name: "buy", group: "Trade & launch", summary: "buy with your wallet (capped, previewed, confirmed)", usage: ["claudia buy <mint> <sol> [--dry-run] [--yes]", "claudia buy <0x…> <eth> --chain hood   (Robinhood Chain, beta)"] },
  { name: "sell", group: "Trade & launch", summary: "sell a percent of your wallet's balance", usage: ["claudia sell <mint> <pct>% [--dry-run] [--yes]", "claudia sell <0x…> <pct>% --chain hood"] },
  { name: "launch", group: "Trade & launch", summary: "launch a coin: pump.fun on Solana, or a Robinhood Chain launchpad (beta)", usage: ["claudia launch --name <n> --symbol <T> --image <file|url> [--dev-buy <sol>] [--dry-run]", "claudia launch --chain hood --launchpad pons|pools|flap|bags|clanker|dyor --name <n> --symbol <T> --image <file|url> [--dev-buy <eth>]"], notes: ["Tickers: up to 13 letters and digits on pump.fun, up to 16 on Robinhood Chain. Dyor has no dev buy.", "Creator fees split 70% to you, 30% to Claudia, fixed on-chain (Robinhood: a FeeSplitter per launch)."] },
  { name: "fees", group: "Trade & launch", summary: "your launches, or the creator fees one launch has earned", usage: ["claudia fees [--chain hood]", "claudia fees <launch id>"] },
  { name: "harvest", group: "Trade & launch", summary: "collect a launch's creator fees and split them 70/30 on-chain", usage: ["claudia harvest <launch id> [--dry-run] [--yes]"] },
  { name: "wallet", group: "Trade & launch", summary: "the agent wallet · or the EVM wallet for Robinhood Chain", usage: ["claudia wallet", "claudia wallet evm [create | import [--file <path>]] [--force]"], notes: ["The EVM key is stored next to the Solana wallet (evm-wallet.json, same encryption). Robinhood signing needs viem: npm i -g viem."] },
  { name: "passport", group: "Trade & launch", summary: "register the agent's on-chain passport", usage: ["claudia passport [--owner-keypair <file>]"] },

  // AI agents & apps
  { name: "agent", group: "AI agents & apps", summary: "an agent with Claudia's tools on your own model key", usage: ["claudia agent [--model <provider>:<model>]", 'claudia agent -p "<prompt>" [--json]', "claudia agent run [--auto] [--rooms general,markets] [--kill-file <path>]   (the thread posting loop)"], examples: ['claudia agent -p "What are KOLs buying right now?"', "claudia agent --model xai:grok-4.7", 'claudia agent --model deepseek:deepseek-flash -p "Is sol:<mint> safe?"', "claudia agent run --rooms markets --once"], flags: [["--model <p>:<id>", "openrouter (default), xai, qwen, deepseek, kimi, openai, anthropic"], ["--provider <id>", "pick the provider and use its default model"], ["--llm-url <url>", "any other OpenAI-compatible endpoint"], ["--allow-trades", "let it propose buys/sells (each previews + asks)"], ["--max-steps <n>", "tool rounds per question (default 8)"], ["--kill-file <path>", "agent run: stop before the next round when this file exists (default ~/.claudia/agent.stop)"]], notes: ["Keys: claudia keys set openrouter|xai|qwen|deepseek|kimi|openai|anthropic (agent and agent run both use them)."] },
  { name: "mcp", group: "AI agents & apps", summary: "add Claudia's MCP server to an AI app", usage: ["claudia mcp install <app> [--server data|trade] [--local] [--dry-run]", "claudia mcp remove <app>", "claudia mcp print <app>", "claudia mcp list"], examples: ["claudia mcp install claude-code", "claudia mcp install cursor --server trade", "claudia mcp install claude-desktop --local --dry-run"], notes: ["Apps: claude-code, claude-desktop, cursor, vscode, windsurf, zed, codex, gemini, qwen, grok, lm-studio, cline, goose.", "Online servers: https://useclaudia.xyz/mcp/data (read-only) and /mcp/trade (you sign every trade)."] },
];

const EXIT_LINE = "0 ok · 1 error · 2 bad usage · 3 refused (safety check / cap / you said no) · 4 not set up · 5 rate limited · 130 Ctrl-C";

export function printOverview(version: string): void {
  const S = sym();
  banner([`claudia ${version}`, "Solana and Robinhood Chain coins, live data and AI agents", "useclaudia.xyz"]);
  log(`  ${c.bold("Usage")}  claudia <command> [options]     ${c.dim(`claudia help <command> for details`)}`);
  const w = term().width;
  const nameW = Math.min(18, Math.max(...HELP.filter((h) => !h.hidden).map((h) => strWidth(h.name))));
  for (const g of GROUPS) {
    section(g);
    for (const h of HELP.filter((x) => x.group === g && !x.hidden)) {
      if (w < 50) {
        log(`  ${c.rose(h.name)}`);
        log(`    ${c.dim(h.summary)}`);
      } else {
        const lines = wrapText(h.summary, w - nameW - 8);
        log(`  ${c.rose(h.name.padEnd(nameW))}  ${lines[0]}`);
        for (const l of lines.slice(1)) log(`  ${" ".repeat(nameW)}  ${l}`);
      }
    }
  }
  section("Options");
  const opts: [string, string][] = [
    ["--json", "machine output only (one JSON object; streams: JSON lines)"],
    ["--dry-run, -n", "preview: nothing is sent, posted, spent or written"],
    ["--yes, -y", "confirm without asking (money, posts, spending)"],
    ["--base-url <url>", "Claudia server (env CLAUDIA_BASE_URL)"],
    ["--chain <id>", "sol (default) · hood (Robinhood Chain, beta) · bsc (coming soon)"],
    ["--home <dir>", "config folder (default ~/.claudia, env CLAUDIA_HOME)"],
    ["--no-color · --ascii", "plain output (also NO_COLOR, FORCE_COLOR, CLAUDIA_ASCII)"],
    ["--width <n>", "layout width (default: the terminal's)"],
  ];
  for (const [k, v] of opts) log(w < 56 ? `  ${c.bold(k)}\n    ${c.dim(v)}` : `  ${c.bold(k.padEnd(22))}${c.dim(v)}`);
  section("Exit codes");
  for (const l of wrapText(EXIT_LINE, w - 6)) log(`  ${c.dim(l)}`);
  log("");
  log(`  ${c.dim(`Docs ${S.arrow}`)} https://useclaudia.xyz/docs ${c.dim(S.dot)} ${c.dim("not financial advice")}`);
  log("");
}

export function findHelp(name: string): CommandHelp | undefined {
  const n = name.toLowerCase();
  return HELP.find((h) => h.name === n) ?? HELP.find((h) => h.name.split(" ")[0] === n);
}

export function printCommandHelp(h: CommandHelp): void {
  title(h.name, h.group);
  log(`  ${h.summary}`);
  section("Usage");
  for (const u of h.usage) log(`  ${c.bold(u)}`);
  if (h.flags?.length) {
    section("Options");
    const kw = Math.min(30, Math.max(...h.flags.map(([k]) => strWidth(k))));
    for (const [k, v] of h.flags) {
      if (term().width < 70) log(`  ${c.bold(k)}\n    ${c.dim(v)}`);
      else log(`  ${c.bold(k.padEnd(kw))}  ${c.dim(v)}`);
    }
  }
  if (h.examples?.length) {
    section("Examples");
    for (const e of h.examples) log(`  ${c.dim("$")} ${e}`);
  }
  if (h.notes?.length) {
    log("");
    for (const n of h.notes) for (const l of wrapText(n, term().width - 6)) log(`  ${c.dim(l)}`);
  }
  log("");
  for (const l of wrapText("Global options: --json --dry-run --yes --base-url --home --no-color (see claudia help)", term().width - 6)) log(`  ${c.dim(l)}`);
  log("");
}
