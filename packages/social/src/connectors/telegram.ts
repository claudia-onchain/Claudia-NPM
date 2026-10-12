// Telegram Bot API: a bot the user creates with @BotFather posts to a channel or group where it is an admin.
// Docs: https://core.telegram.org/bots/api (sendMessage, sendPhoto, sendVideo, sendAnimation, sendMediaGroup, getUpdates)
import { ClaudiaSocialError } from "../errors.js";
import type { MultipartPart } from "../transport.js";
import { need, type ConnCtx, type Connector, type PublishJob } from "./base.js";
import { caps, info } from "./common.js";

const API = "https://api.telegram.org";
const CAPTION_MAX = 1024;

async function call(ctx: ConnCtx, method: string, body: { json?: unknown; multipart?: MultipartPart[] }, mock: unknown, label?: string) {
  const token = ctx.creds.token as string;
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}/bot${token}/${method}`,
    ...body,
    secrets: [token],
    network: "telegram",
    label: label ?? method,
    timeoutMs: body.multipart ? 10 * 60_000 : 60_000,
    // Telegram answers 200 + {ok:false} for some errors and 4xx for others; both handled below
    ok: () => true,
    mock: { ok: true, result: mock },
  });
  const j = res.json;
  if (!j?.ok) {
    if (j?.error_code === 429) {
      throw new ClaudiaSocialError("rate_limited", `Telegram: ${j.description}`, { network: "telegram", retryAfterMs: (j.parameters?.retry_after ?? 30) * 1000 });
    }
    if (j?.error_code === 401) throw new ClaudiaSocialError("expired", "Telegram rejected the bot token.", { network: "telegram", hint: "Check the token from @BotFather." });
    throw new ClaudiaSocialError("provider_error", `Telegram ${method}: ${j?.description ?? `HTTP ${res.status}`}`, {
      network: "telegram",
      status: j?.error_code,
      hint: /not enough rights|chat not found|not a member/i.test(j?.description ?? "") ? "Add the bot to the channel/group as an admin with the Post Messages right." : undefined,
    });
  }
  return j.result;
}

function msgUrl(ctx: ConnCtx, messageId: number | string): string | undefined {
  const chat = String(ctx.creds.chatId);
  if (ctx.creds.chatUsername) return `https://t.me/${ctx.creds.chatUsername}/${messageId}`;
  if (chat.startsWith("-100")) return `https://t.me/c/${chat.slice(4)}/${messageId}`;
  return undefined;
}

function common(ctx: ConnCtx, job: PublishJob): Record<string, unknown> {
  const o: Record<string, unknown> = { chat_id: ctx.creds.chatId };
  const topic = job.options.topicId ?? ctx.creds.topicId;
  if (topic) o.message_thread_id = Number(topic);
  if (job.options.silent) o.disable_notification = true;
  return o;
}

export const telegramConnector: Connector = {
  id: "telegram",
  counter: "utf16",
  labels: { ai: "text" },
  info: info({
    id: "telegram",
    name: "Telegram",
    tier: "direct",
    auth: "key",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, dm: false, inbox: true }),
    limits: { maxChars: 4096, maxImages: 10, maxVideoMb: 50, perDay: 50 },
    setup:
      "Message @BotFather, send /newbot and copy the bot token. Add the bot to your channel or group as an admin with \"Post Messages\". Connect with params { token, chat } where chat is @channelusername or the numeric -100… id (key name \"telegram\" can hold the token).",
    docs: "https://core.telegram.org/bots/api",
    keyNames: ["telegram"],
  }),
  async connectKey(ctx, params, keys) {
    const token = need(params.token ?? (await keys.get("telegram")), "Telegram bot token", "Get one from @BotFather and pass params.token or store it under the key \"telegram\".");
    const chat = need(params.chat ?? params.chatId, "Telegram chat", "Pass params.chat: @channelusername or the numeric -100… id of the channel or group.");
    const c: ConnCtx = { ...ctx, creds: { token } };
    const bot = await call(c, "getMe", { json: {} }, { id: 777000, is_bot: true, username: "claudia_bot", first_name: "Claudia" });
    const chatInfo = await call(c, "getChat", { json: { chat_id: chat } }, { id: -1001234567890, type: "channel", title: "Claudia News", username: "claudia_news" });
    return [
      {
        account: {
          id: `telegram:${chatInfo.id}`,
          network: "telegram",
          handle: chatInfo.username ? `@${chatInfo.username}` : String(chatInfo.title ?? chatInfo.id),
          name: chatInfo.title,
          notes: [`bot @${bot.username}`, chatInfo.type],
        },
        credentials: { token, chatId: chatInfo.id, chatUsername: chatInfo.username, botId: bot.id, botUsername: bot.username, topicId: params.topicId },
      },
    ];
  },
  async publish(ctx, job) {
    const ids: string[] = [...job.done];
    const parts = [job.text, ...job.thread];
    let first = 0;
    let lastId: number | undefined = ids.length ? Number(ids[ids.length - 1]) : job.replyTo ? Number(job.replyTo) : undefined;
    const reply = () => (lastId ? { reply_parameters: { message_id: lastId, allow_sending_without_reply: true } } : {});
    if (!ids.length && job.media.length) {
      const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
      const captionFits = job.text.length <= CAPTION_MAX;
      const caption = captionFits ? job.text : undefined;
      let sent: any;
      if (files.length === 1) {
        const f = files[0]!;
        const [method, field] = f.mime === "image/gif" ? ["sendAnimation", "animation"] : f.kind === "video" ? ["sendVideo", "video"] : ["sendPhoto", "photo"];
        const fields: Record<string, unknown> = { ...common(ctx, job), ...reply(), ...(caption ? { caption } : {}) };
        if (f.kind === "video") fields.supports_streaming = true;
        sent = await call(
          ctx,
          method!,
          {
            multipart: [
              ...Object.entries(fields).map(([k, v]) => ({ name: k, value: typeof v === "string" ? v : JSON.stringify(v) })),
              { name: field!, file: { bytes: f.bytes, mime: f.mime, filename: f.filename } },
            ],
          },
          { message_id: 101 },
        );
      } else {
        const media = files.map((f, i) => ({
          type: f.kind === "video" ? "video" : "photo",
          media: `attach://file${i}`,
          ...(i === 0 && caption ? { caption } : {}),
        }));
        const fields: Record<string, unknown> = { ...common(ctx, job), ...reply(), media };
        const res = await call(
          ctx,
          "sendMediaGroup",
          {
            multipart: [
              ...Object.entries(fields).map(([k, v]) => ({ name: k, value: typeof v === "string" ? v : JSON.stringify(v) })),
              ...files.map((f, i) => ({ name: `file${i}`, file: { bytes: f.bytes, mime: f.mime, filename: f.filename } })),
            ],
          },
          files.map((_, i) => ({ message_id: 101 + i })),
        );
        sent = res[0];
      }
      lastId = sent.message_id;
      ids.push(String(sent.message_id));
      await job.progress(String(sent.message_id));
      first = captionFits ? 1 : 0;
    } else first = ids.length;
    for (let i = first; i < parts.length; i++) {
      const sent = await call(
        ctx,
        "sendMessage",
        {
          json: {
            ...common(ctx, job),
            ...reply(),
            text: parts[i],
            link_preview_options: { is_disabled: !!job.options.noPreview },
          },
        },
        { message_id: 200 + i },
        i === 0 ? "sendMessage" : `sendMessage (part ${i + 1})`,
      );
      lastId = sent.message_id;
      ids.push(String(sent.message_id));
      await job.progress(String(sent.message_id));
    }
    return { remoteId: ids[0]!, remoteIds: ids, url: msgUrl(ctx, ids[0]!) };
  },
  async reply(ctx, to, text) {
    // inbox ids are "<chatId>:<messageId>" (the bot may be in several chats); a bare id means this account's chat
    const i = to.lastIndexOf(":");
    const chatId = i > 0 ? to.slice(0, i) : ctx.creds.chatId;
    const messageId = Number(i > 0 ? to.slice(i + 1) : to);
    const sent = await call(
      ctx,
      "sendMessage",
      { json: { chat_id: chatId, text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } },
      { message_id: 300 },
      "reply",
    );
    return { remoteId: String(sent.message_id), url: msgUrl(ctx, sent.message_id) };
  },
  async inbox(ctx, cursor) {
    const updates: any[] = await call(
      ctx,
      "getUpdates",
      { json: { offset: cursor?.offset, timeout: 0, limit: 100, allowed_updates: ["message", "channel_post"] } },
      [],
      "getUpdates",
    );
    const bot = String(ctx.creds.botUsername ?? "").toLowerCase();
    const items = [];
    let offset = cursor?.offset;
    for (const u of updates) {
      offset = Math.max(offset ?? 0, u.update_id + 1);
      const m = u.message ?? u.channel_post;
      if (!m?.text && !m?.caption) continue;
      const text = m.text ?? m.caption ?? "";
      const isDm = m.chat?.type === "private";
      const mentions = bot && text.toLowerCase().includes(`@${bot}`);
      const repliesToBot = m.reply_to_message?.from?.id === ctx.creds.botId;
      if (!isDm && !mentions && !repliesToBot) continue;
      items.push({
        kind: isDm ? ("dm" as const) : repliesToBot ? ("reply" as const) : ("mention" as const),
        id: `${m.chat.id}:${m.message_id}`,
        from: m.from?.username ? `@${m.from.username}` : String(m.from?.first_name ?? m.chat?.title ?? m.chat.id),
        text,
        at: (m.date ?? 0) * 1000,
      });
    }
    return { items, cursor: { offset }, reads: 1 };
  },
};
