// Forward a coin's big trades to your own Telegram channel.
//
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=@yourchannel npx tsx telegram-bridge.ts <mint> [minUsd]
//
// Uses your own bot (make one with @BotFather and add it to the channel as an admin). At most 10 messages a minute.
import { ClaudiaClient } from "@useclaudia/sdk";

const [mint = "claudia", min = "500"] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
if (!token || !chat) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");

const client = new ClaudiaClient();
const coin = await client.token(mint);
const sent: number[] = [];
const trades = client.stream.trades(mint, { minUsd: Number(min) });
process.on("SIGINT", () => trades.close());

for await (const t of trades) {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 10) continue;
  sent.push(now);
  const text = `${t.side === "buy" ? "🟢 Buy" : "🔴 Sell"} $${Math.round(t.amountUsd).toLocaleString()} of $${coin.symbol} · mcap $${Math.round(t.mcapUsd).toLocaleString()}${t.tags.length ? ` · ${t.tags.join(", ")}` : ""}\nNot financial advice.`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true } }),
  });
}
