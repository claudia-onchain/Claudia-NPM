// Coin insights + live trades with @useclaudia/sdk (no key needed).
//
//   npm i @useclaudia/sdk          (Node 18–21 also: npm i ws)
//   npx tsx insights-and-streams.ts <mint>
//
// Prints a coin's scores and its top tagged holders, then streams its live trades until Ctrl-C. The stream
// reconnects on its own (backoff + resubscribe) and never repeats a trade.
import { ClaudiaClient } from "@useclaudia/sdk";

const mint = process.argv[2] ?? "claudia";
const client = new ClaudiaClient({ hub: { onState: (s, d) => s === "reconnecting" && console.error(`  reconnecting in ${d?.delayMs} ms…`) } });

const [info, scores, holders] = await Promise.all([client.insights.token(mint), client.insights.scores(mint), client.insights.holders(mint, { limit: 20 })]);
console.log(`$${info.symbol} · mcap $${Math.round(info.stats.mcapUsd ?? 0).toLocaleString()} · ${info.source}${info.partial ? ` (${info.partial})` : ""}`);
for (const [name, s] of Object.entries({ safety: scores.safety, holders: scores.holders, chart: scores.chart })) {
  console.log(`  ${name.padEnd(8)} ${String(Math.round(s.value)).padStart(3)} ${s.grade.padEnd(7)} ${s.title}`);
}
for (const h of holders.data.filter((h) => h.tags.some((t) => t !== "top10")).slice(0, 5)) {
  console.log(`  #${h.rank} ${h.address.slice(0, 4)}…${h.address.slice(-4)} ${(h.pct * 100).toFixed(2)}% [${h.tags.join(", ")}]`);
}

const trades = client.stream.trades(mint, { minUsd: 50 });
process.on("SIGINT", () => trades.close());
for await (const t of trades) {
  console.log(`${new Date(t.ts).toLocaleTimeString()} ${t.side.toUpperCase().padEnd(4)} $${t.amountUsd.toFixed(0).padStart(6)} by ${t.trader.slice(0, 4)}… ${t.tags.join(" ")}`);
}
client.stream.close();
