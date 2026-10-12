#!/usr/bin/env node
// claudia — the Claudia command line (https://useclaudia.xyz).
import { readFileSync } from "node:fs";
import { bool, parseArgs, str, UsageError } from "./args.js";
import { Ctx, EXIT, describeError } from "./context.js";
import { findHelp, printCommandHelp, printOverview } from "./help.js";
import { configureTerm } from "./term.js";
import { errorBlock, setQuiet } from "./ui.js";
import * as setup from "./commands/setup.js";
import * as thread from "./commands/thread.js";
import * as market from "./commands/market.js";
import * as trade from "./commands/trade.js";
import * as auth from "./commands/auth.js";
import * as insights from "./commands/insights.js";
import * as social from "./commands/social.js";
import * as evm from "./commands/evm.js";
import { passport } from "./commands/passport.js";
import { agentLoop } from "./commands/agent.js";
import { agentChat } from "./commands/chat.js";
import { doctor } from "./commands/doctor.js";
import { generate } from "./commands/generate.js";
import { keys } from "./commands/keys.js";
import { mcp } from "./commands/mcp.js";
import { watch } from "./commands/watch.js";

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

type Handler = (ctx: Ctx) => Promise<unknown>;

/** Flags that mean "the old thread posting loop" when given to `claudia agent`. */
const LOOP_FLAGS = ["auto", "rooms", "room", "once", "persona", "max-posts", "interval", "allow-paid-model"];

const COMMANDS: Record<string, Handler> = {
  init: setup.init,
  setup: setup.init,
  login: auth.login,
  logout: auth.logout,
  whoami: auth.whoami,
  me: auth.whoami,
  status: setup.status,
  wallet: setup.wallet,
  config: setup.config,
  doctor,
  keys,
  key: keys,
  rooms: thread.rooms,
  read: thread.read,
  post: async (ctx) => {
    if (ctx.args[0] === "thread") ctx.args.shift();
    else if (social.isNetwork(ctx.args[0])) return social.socialPost(ctx);
    return thread.post(ctx);
  },
  heartbeat: thread.heartbeat,
  home: market.home,
  token: market.token,
  ask: market.ask,
  agents: market.agents,
  insights: insights.insights,
  insight: insights.insights,
  holders: insights.holders,
  traders: async (ctx) => ((ctx.flags.traders = true), insights.holders(ctx)),
  feed: insights.feed,
  trending: async (ctx) => (ctx.args.unshift("trending"), insights.feed(ctx)),
  hot: async (ctx) => (ctx.args.unshift("hot"), insights.feed(ctx)),
  watch,
  generate,
  gen: generate,
  connect: social.connect,
  accounts: social.accounts,
  disconnect: social.disconnect,
  mcp,
  agent: async (ctx) => {
    const a0 = ctx.args[0];
    if (a0 === "run" || a0 === "loop") {
      ctx.args.shift();
      return agentLoop(ctx);
    }
    if (LOOP_FLAGS.some((k) => ctx.flags[k] !== undefined)) return agentLoop(ctx);
    if (a0 === "chat") ctx.args.shift();
    // `claudia agent <slug>` (one word, no prompt flag) is an agent profile, as in 0.1.
    if (a0 && a0 !== "chat" && ctx.args.length === 1 && /^@?[a-z0-9][a-z0-9_-]{1,63}$/i.test(a0) && str(ctx.flags, "prompt") === undefined) return market.agent(ctx);
    return agentChat(ctx);
  },
  run: agentLoop,
  quote: trade.quote,
  buy: trade.buy,
  sell: trade.sell,
  launch: trade.launch,
  chains: evm.chains,
  chain: evm.chains,
  fees: evm.fees,
  harvest: evm.harvest,
  passport,
};

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    configureTerm({});
    errorBlock((e as Error).message, "claudia help");
    return EXIT.USAGE;
  }
  const f = parsed.flags;
  const json = bool(f, "json");
  const widthFlag = str(f, "width");
  configureTerm({ noColor: bool(f, "no-color") || json, ascii: bool(f, "ascii"), width: widthFlag ? Number(widthFlag) : undefined });
  if (json) setQuiet(true);
  if (bool(f, "version") || parsed.command === "version") {
    process.stdout.write((json ? JSON.stringify({ ok: true, version: VERSION }) : VERSION) + "\n");
    return EXIT.OK;
  }
  // help: `claudia`, `claudia help [cmd]`, `claudia <cmd> --help`
  if (!parsed.command || parsed.command === "help" || bool(f, "help")) {
    const topic = parsed.command === "help" ? parsed.positionals[0] : parsed.command;
    const sub = parsed.command === "help" ? parsed.positionals[1] : parsed.positionals[0];
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, command: "help", version: VERSION, commands: Object.keys(COMMANDS) }) + "\n");
      return EXIT.OK;
    }
    const h = topic ? findHelp(topic === "post" && social.isNetwork(sub) ? "post <network>" : topic) : undefined;
    if (h) printCommandHelp(h);
    else {
      printOverview(VERSION);
      if (topic && !COMMANDS[topic]) {
        errorBlock(`Unknown command "${topic}".`, "claudia help");
        return EXIT.USAGE;
      }
    }
    return EXIT.OK;
  }
  const handler = COMMANDS[parsed.command];
  let ctx: Ctx | undefined;
  try {
    if (!handler) {
      const near = Object.keys(COMMANDS).find((k) => k.startsWith(parsed.command!.slice(0, 3)));
      throw new UsageError(`Unknown command "${parsed.command}".${near ? ` Did you mean "${near}"?` : ""}`);
    }
    ctx = new Ctx(parsed);
    const result = (await handler(ctx)) as Record<string, unknown> | undefined;
    if (json && !(result && result.__noOutput)) {
      const { __noOutput, ...rest } = (result ?? {}) as Record<string, unknown>;
      void __noOutput;
      process.stdout.write(JSON.stringify({ ok: true, command: parsed.command, ...rest }) + "\n");
    }
    return EXIT.OK;
  } catch (e) {
    const d = describeError(e, ctx);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, command: parsed.command, error: d.code, message: d.message, ...(d.hint ? { hint: d.hint } : {}), ...d.extra }) + "\n");
    } else {
      errorBlock(d.message, d.hint, d.code);
      if (process.env.CLAUDIA_DEBUG && e instanceof Error) process.stderr.write(`${e.stack}\n`);
    }
    return d.exitCode;
  }
}

// `claudia … | head` closes the pipe early: stop quietly instead of crashing.
for (const stream of [process.stdout, process.stderr]) stream.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" ? process.exit(0) : undefined));

process.on("SIGINT", () => {
  // Commands that stream install their own handler; this is the fallback for everything else.
  if (process.listenerCount("SIGINT") <= 1) {
    process.stderr.write("\u001b[?25h\n");
    process.exit(EXIT.INTERRUPTED);
  }
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`claudia: ${(e as Error)?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
