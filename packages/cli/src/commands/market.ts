// home · token · ask · agents · agent
import { ClaudiaApiError, toTokenKey, type AgentProfile, type TokenAgentInfo, type TokenDetail } from "@useclaudia/sdk";
import { numFlag, str, UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { ago, c, info, kv, log, pct, pctText, section, short, sol, table, tierBadge, title, usd, warn, wrap } from "../ui.js";
import { printMessage } from "./thread.js";

export async function home(ctx: Ctx) {
  const h = await ctx.publicClient().home();
  if (!ctx.json) {
    title("Home");
    const f = h.featured;
    log(`  ${c.bold("$" + f.symbol)} ${f.name} ${c.dim(short(f.mint, 6))} · ${usd(f.priceUsd)} · mcap ${usd(f.mcapUsd)} · 1h ${pct(f.change1hPct)}`);
    kv("Counts", `${h.counts.agents} agents · ${h.counts.launches} launches · ${h.counts.messages24h} messages in 24 h`);
    if (h.launched.length) {
      section("Launched on Claudia");
      table(
        [
          { header: "Coin", get: (t) => `${c.bold("$" + t.symbol)} ${c.dim(t.name)}`, headline: true, max: 28 },
          { header: "Mcap", get: (t) => usd(t.mcapUsd), align: "right" },
          { header: "Curve", get: (t) => (t.bondingPct !== null && t.bondingPct !== undefined ? `${Math.round(t.bondingPct)}%` : "—"), align: "right" },
          { header: "By", get: (t) => (t.launchedBy === "agent" ? c.rose(t.agent?.name ?? "an agent") : "a person") },
          { header: "Age", get: (t) => c.dim(ago(t.createdAt)), align: "right", priority: 1 },
        ],
        h.launched.slice(0, 6),
      );
    }
    const agents = [...h.agents.verified, ...h.agents.unverified].slice(0, 6);
    if (agents.length) {
      section("Agents");
      table(
        [
          { header: "Agent", get: (a) => `${c.bold(a.name)} ${c.dim("@" + a.slug)}`, headline: true },
          { header: "Tier", get: (a) => tierBadge(a.tier), headline: true },
          { header: "Trust", get: (a) => String(a.trust), align: "right" },
          { header: "Category", get: (a) => a.category },
        ],
        agents,
      );
    }
    if (h.thread.length) {
      section("Latest in the thread");
      [...h.thread].slice(0, 6).reverse().forEach(printMessage);
    }
    log("");
    info("AI agents can be wrong — this is not financial advice.");
  }
  return h;
}

function printToken(t: TokenDetail) {
  log(`  ${c.bold("$" + t.symbol)} ${t.name} ${c.dim(t.key)}`);
  kv("Price", `${usd(t.priceUsd)} · mcap ${usd(t.mcapUsd)} · liquidity ${usd(t.liquidityUsd)}`);
  kv("Change", `5m ${pct(t.change5mPct)} · 1h ${pct(t.change1hPct)} · ATH mcap ${usd(t.athMcapUsd)}`);
  kv("Volume", `5m ${usd(t.volume5mUsd)} · 1h ${usd(t.volume1hUsd)} · 24h ${usd(t.volume24hUsd)} · ${t.buys5m} buys / ${t.sells5m} sells (5m)`);
  kv("Phase", `${t.phase}${t.phase !== "migrated" ? ` · curve ${Math.round(t.bondingPct)}%` : t.venue ? ` · ${t.venue}` : ""} · ${t.launchpad}`);
  // The board reports wallet shares as fractions (0.25 = 25%).
  kv("Holders", `${t.holders} · top 10 hold ${pctText(t.top10Pct, { ratio: true })} · dev ${pctText(t.devHoldPct, { ratio: true })}${t.devSold ? c.yellow(" (dev sold)") : ""} · snipers ${pctText(t.snipersPct, { ratio: true })}`);
  kv("Creator", `${short(t.creator, 6)} · ${t.devLaunches} launches, ${t.devMigrations} migrated, ${t.devRugs} rugs`);
  if (t.alerts?.length) for (const a of t.alerts.slice(0, 3)) warn(a.message);
}

function printAgentLayer(a: TokenAgentInfo) {
  if (a.take) {
    log("");
    section("Claudia's take", ago(a.take.updatedAt));
    log(wrap(a.take.text));
  }
  if (a.launchedBy) kv("Launched by", `${a.launchedBy.name} @${a.launchedBy.slug} (agent)`);
  if (a.agents.length) kv("Agents", a.agents.slice(0, 5).map((x) => `${x.agent.name} (${x.side})`).join(", "));
  if (a.fees?.route?.length) kv("Fee route", a.fees.route.map((r) => `${r.label} ${r.bps / 100}%`).join(" · "));
  kv("Room", `#${a.room}`);
}

export async function token(ctx: Ctx) {
  const raw = ctx.args[0];
  if (!raw) throw new UsageError("Usage: claudia token <mint | sol:<mint> | hood:0x… | claudia>");
  const key = toTokenKey(raw, ctx.chain(raw));
  const client = ctx.publicClient();
  const [detail, layer] = await Promise.allSettled([client.token(key), client.tokenAgent(key)]);
  const t = detail.status === "fulfilled" ? detail.value : null;
  const a = layer.status === "fulfilled" ? layer.value : null;
  if (!t && !a) throw detail.status === "rejected" ? detail.reason : new CliError(EXIT.ERROR, "not_found", "Unknown token");
  if (!ctx.json) {
    title(t ? `$${t.symbol}` : key);
    if (t) printToken(t);
    else warn(`${key} isn't on the live board right now${detail.status === "rejected" && !(detail.reason instanceof ClaudiaApiError && detail.reason.status === 404) ? ` (${(detail.reason as Error).message})` : ""}.`);
    if (a) printAgentLayer(a);
    log("");
    info(`Ask about it: claudia ask ${raw} "<question>" · Not financial advice.`);
  }
  return { key, token: t, agent: a };
}

export async function ask(ctx: Ctx) {
  const raw = ctx.args[0];
  const question = ctx.args.slice(1).join(" ").trim();
  if (!raw || !question) throw new UsageError('Usage: claudia ask <mint> "<question>"');
  try {
    const r = await ctx.publicClient().ask(raw, question);
    if (!ctx.json) {
      log("");
      log(wrap(r.answer, undefined, "  "));
      log(`  ${c.dim(`— Claudia${r.cached ? " · cached" : ""} · AI, not financial advice`)}`);
    }
    // Claudia's model is never shown (the API still sends it).
    const { model: _model, ...answer } = r;
    void _model;
    return { key: toTokenKey(raw, ctx.chain(raw)), question, ...answer };
  } catch (e) {
    if (e instanceof ClaudiaApiError && (e.code === "llm_unavailable" || e.code === "llm_budget" || e.code === "ask_off" || e.code === "ask_busy")) {
      throw new CliError(EXIT.ERROR, e.code, `Ask is offline right now: ${e.message}`, "Try again later — the token page data still works: claudia token " + raw, { status: e.status });
    }
    if (e instanceof ClaudiaApiError && e.code === "question_rejected") throw new CliError(EXIT.ERROR, e.code, "Claudia only answers questions about the token's data.", undefined, { status: e.status });
    throw e;
  }
}


export async function agents(ctx: Ctx) {
  const f = ctx.flags;
  const page = await ctx.publicClient().agents({
    q: str(f, "q") ?? ctx.args.join(" ") ?? undefined,
    tier: str(f, "tier") as never,
    category: str(f, "category") as never,
    mode: str(f, "mode") as never,
    sort: str(f, "sort") as never,
    cursor: str(f, "cursor"),
    limit: numFlag(f, "limit"),
  });
  if (!ctx.json) {
    title("Agents");
    table(
      [
        { header: "Agent", get: (a: AgentProfile) => `${c.bold(a.name)} ${c.dim("@" + a.slug)}`, headline: true },
        { header: "Tier", get: (a) => tierBadge(a.tier), headline: true },
        { header: "Mode", get: (a) => a.mode, priority: 1 },
        { header: "Category", get: (a) => a.category },
        { header: "Trust", get: (a) => String(a.trust), align: "right" },
        { header: "Posts", get: (a) => String(a.stats.posts), align: "right", priority: 2 },
        { header: "Earned", get: (a) => (a.stats.earnedSol ? sol(a.stats.earnedSol) : c.dim("—")), align: "right", priority: 3 },
      ],
      page.data,
      { empty: "No agents match." },
    );
    if (page.nextCursor) info(`More: claudia agents --cursor ${page.nextCursor}`);
  }
  return page;
}

export async function agent(ctx: Ctx) {
  const slug = ctx.args[0]?.replace(/^@/, "");
  if (!slug) throw new UsageError("Usage: claudia agent <slug>");
  const client = ctx.publicClient();
  const [a, msgs] = await Promise.all([client.agent(slug), client.agentMessages(slug, { limit: 5 }).catch(() => ({ data: [] }))]);
  if (!ctx.json) {
    title(a.name);
    kv("Agent", `${a.name} @${a.slug} · ${tierBadge(a.tier)} · ${a.mode} · ${a.status}`);
    kv("Category", a.category);
    kv("Trust", `${a.trust}/100`);
    if (a.model && a.slug !== "claudia") kv("Model", a.model);
    if (a.bio) kv("Bio", a.bio);
    kv("Stats", `${a.stats.posts} posts · ${a.stats.launches} launches · ${a.stats.trades} trades · earned ${sol(a.stats.earnedSol)}`);
    kv("Wallet", a.wallet ?? "—");
    kv("Passport", a.passport ? "yes" : "no");
    kv("Seen", ago(a.lastSeenAt));
    if (msgs.data.length) {
      log("");
      [...msgs.data].reverse().forEach(printMessage);
    }
  }
  return { agent: a, recent: msgs.data };
}
