// --notify telegram|discord|webhook for `claudia watch`, using the user's OWN bot token / webhook (claudia keys set …).
// Every request can be built without sending it (dry run) and secrets are redacted when shown.
import { CliError, EXIT } from "./context.js";
import type { KeyStore } from "./keystore.js";

export type NotifyKind = "telegram" | "discord" | "webhook";

export interface Notifier {
  kind: NotifyKind;
  /** Where it goes, safe to print. */
  target: string;
  send(text: string, data?: unknown): Promise<void>;
  /** The exact request it would make (secrets → "***"). */
  preview(text: string, data?: unknown): { method: string; url: string; headers: Record<string, string>; body: unknown };
}

const redactUrl = (u: string) => u.replace(/(bot)[^/]+/, "$1***").replace(/(webhooks\/\d+\/)[^/?]+/, "$1***");

/** Builds a notifier from keys (or flags: --chat, --webhook). Throws a SETUP error naming the missing key. */
export async function makeNotifier(kind: string, keys: KeyStore, flags: { chat?: string; url?: string }): Promise<Notifier> {
  if (kind === "telegram") {
    const token = await keys.get("telegram");
    const chat = flags.chat ?? (await keys.get("telegram-chat"));
    if (!token) throw new CliError(EXIT.SETUP, "no_key", "No Telegram bot token.", "Make a bot with @BotFather, then: claudia keys set telegram");
    if (!chat) throw new CliError(EXIT.SETUP, "no_key", "No Telegram chat id.", "claudia keys set telegram-chat <id>   (or --chat <id>)");
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const req = (text: string) => ({ method: "POST", url, headers: { "content-type": "application/json" }, body: { chat_id: chat, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } } });
    return {
      kind,
      target: `Telegram chat ${chat}`,
      preview: (text) => ({ ...req(text), url: redactUrl(url) }),
      send: async (text) => post(req(text)),
    };
  }
  if (kind === "discord") {
    const url = flags.url ?? (await keys.get("discord-webhook"));
    if (!url) throw new CliError(EXIT.SETUP, "no_key", "No Discord webhook URL.", "Channel settings → Integrations → Webhooks, then: claudia keys set discord-webhook <url>");
    if (!/^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(url)) throw new CliError(EXIT.USAGE, "bad_webhook", "That isn't a Discord webhook URL.");
    const req = (text: string) => ({ method: "POST", url, headers: { "content-type": "application/json" }, body: { content: text.slice(0, 1900), username: "Claudia watch", allowed_mentions: { parse: [] } } });
    return { kind, target: "Discord webhook", preview: (text) => ({ ...req(text), url: redactUrl(url) }), send: async (text) => post(req(text)) };
  }
  if (kind === "webhook") {
    const url = flags.url ?? (await keys.get("webhook"));
    if (!url) throw new CliError(EXIT.SETUP, "no_key", "No webhook URL.", "claudia keys set webhook <https://…>   (or --webhook <url>)");
    if (!/^https?:\/\//.test(url)) throw new CliError(EXIT.USAGE, "bad_webhook", "The webhook URL must start with https://");
    const req = (text: string, data?: unknown) => ({ method: "POST", url, headers: { "content-type": "application/json", "user-agent": "claudia-cli" }, body: { source: "claudia", text, data, at: new Date().toISOString() } });
    return { kind, target: new URL(url).host, preview: (text, data) => ({ ...req(text, data), url: url.replace(/\?.*/, "?***") }), send: async (text, data) => post(req(text, data)) };
  }
  throw new CliError(EXIT.USAGE, "bad_notify", `--notify is telegram, discord or webhook (got "${kind}")`);
}

async function post(r: { method: string; url: string; headers: Record<string, string>; body: unknown }): Promise<void> {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`notify failed: HTTP ${res.status}`);
}

/** At most `perMinute` notifications a minute; the rest are counted and summarised. */
export function throttled(n: Notifier, perMinute = 10): { push(text: string, data?: unknown): Promise<void>; dropped(): number } {
  const sent: number[] = [];
  let dropped = 0;
  return {
    async push(text, data) {
      const now = Date.now();
      while (sent.length && now - sent[0] > 60_000) sent.shift();
      if (sent.length >= perMinute) {
        dropped++;
        return;
      }
      sent.push(now);
      const prefix = dropped ? `(+${dropped} more since the last alert) ` : "";
      dropped = 0;
      await n.send(prefix + text, data);
    },
    dropped: () => dropped,
  };
}
