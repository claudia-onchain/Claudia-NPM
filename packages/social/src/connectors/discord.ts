// Discord: a channel webhook (simplest: no bot needed) or a bot token + channel id. Forum channels create a post (thread).
// Docs: https://docs.discord.com/developers/resources/webhook · https://docs.discord.com/developers/resources/message
//       https://docs.discord.com/developers/resources/channel (Start Thread in Forum or Media Channel)
import { ClaudiaSocialError } from "../errors.js";
import type { MultipartPart } from "../transport.js";
import { sha256Hex } from "../util.js";
import { need, type ConnCtx, type Connector, type PublishJob } from "./base.js";
import { caps, info, titleOf, VERSION } from "./common.js";

const API = "https://discord.com/api/v10";
const UA = `DiscordBot (https://useclaudia.xyz, ${VERSION})`;
const FORUM_TYPES = new Set([15, 16]); // GUILD_FORUM, GUILD_MEDIA

function auth(ctx: ConnCtx): Record<string, string> {
  return ctx.creds.botToken ? { Authorization: `Bot ${ctx.creds.botToken}`, "User-Agent": UA } : { "User-Agent": UA };
}

async function send(
  ctx: ConnCtx,
  url: string,
  payload: Record<string, unknown>,
  files: { bytes: Uint8Array; mime: string; filename: string; alt?: string }[],
  label: string,
  mock: unknown,
) {
  const secrets = [ctx.creds.botToken, ctx.creds.webhookToken];
  if (files.length) {
    const body = { ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.filename, ...(f.alt ? { description: f.alt.slice(0, 1024) } : {}) })) };
    const parts: MultipartPart[] = [
      { name: "payload_json", value: JSON.stringify(body) },
      ...files.map((f, i) => ({ name: `files[${i}]`, file: { bytes: f.bytes, mime: f.mime, filename: f.filename } })),
    ];
    return (await ctx.http.request({ method: "POST", url, headers: auth(ctx), multipart: parts, secrets, network: "discord", label, mock, timeoutMs: 10 * 60_000 })).json;
  }
  return (await ctx.http.request({ method: "POST", url, headers: auth(ctx), json: payload, secrets, network: "discord", label, mock })).json;
}

function messageUrl(ctx: ConnCtx, channelId: string, messageId: string): string | undefined {
  return ctx.creds.guildId ? `https://discord.com/channels/${ctx.creds.guildId}/${channelId}/${messageId}` : undefined;
}

const noMentions = { parse: [] as string[] }; // an agent never pings @everyone / roles / users by accident

export const discordConnector: Connector = {
  id: "discord",
  counter: "utf16",
  labels: { ai: "text" },
  info: info({
    id: "discord",
    name: "Discord",
    tier: "direct",
    auth: "key",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, inbox: true }),
    limits: { maxChars: 2000, maxImages: 10, maxVideoMb: 20, perDay: 50 },
    setup:
      "Easiest: Channel settings → Integrations → Webhooks → New Webhook → Copy URL, then connect with params { webhookUrl }. For replies and the inbox, create a bot at discord.com/developers/applications (Bot → Reset Token; enable Message Content intent), invite it with Send Messages + Attach Files + Read Message History (+ Create Posts / Send Messages in Threads for forums), and connect with params { token, channelId } (key name \"discord\" can hold the bot token or the webhook URL). Forum channels become new forum posts.",
    docs: "https://docs.discord.com/developers/resources/webhook",
    keyNames: ["discord"],
  }),
  async connectKey(ctx, params, keys) {
    const stored = await keys.get("discord");
    const webhookUrl = params.webhookUrl ?? (stored && /^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(stored) ? stored : undefined);
    if (webhookUrl) {
      const m = /\/webhooks\/(\d+)\/([\w-]+)/.exec(webhookUrl);
      if (!m) throw new ClaudiaSocialError("invalid", "That doesn't look like a Discord webhook URL.", { network: "discord" });
      const c: ConnCtx = { ...ctx, creds: { webhookToken: m[2] } };
      const wh = (
        await c.http.request({
          method: "GET",
          url: `${API}/webhooks/${m[1]}/${m[2]}`,
          headers: { "User-Agent": UA },
          secrets: [m[2]],
          network: "discord",
          label: "check webhook",
          mock: { id: m[1], name: "Claudia", channel_id: "1100000000000000001", guild_id: "1000000000000000001" },
        })
      ).json;
      const forum = params.forum === "1" || params.forum === "true";
      return [
        {
          account: {
            id: `discord:webhook:${wh.channel_id}:${sha256Hex(m[1]!).slice(0, 8)}`,
            network: "discord",
            handle: `#${wh.channel_id} (${wh.name})`,
            name: wh.name,
            notes: ["webhook", ...(forum ? ["forum"] : []), "no inbox (webhooks can't read)"],
          },
          credentials: { webhookId: m[1], webhookToken: m[2], channelId: wh.channel_id, guildId: wh.guild_id, forum },
        },
      ];
    }
    const botToken = need(params.token ?? stored, "Discord bot token or webhook URL", "Pass params.webhookUrl, or params.token + params.channelId.");
    const channelId = need(params.channelId, "Discord channel id", "Right-click the channel → Copy Channel ID (turn on Developer Mode in Discord settings).");
    const c: ConnCtx = { ...ctx, creds: { botToken } };
    const me = (await c.http.request({ method: "GET", url: `${API}/users/@me`, headers: auth(c), secrets: [botToken], network: "discord", label: "who am I", mock: { id: "1200000000000000001", username: "claudia", bot: true } })).json;
    const ch = (
      await c.http.request({
        method: "GET",
        url: `${API}/channels/${channelId}`,
        headers: auth(c),
        secrets: [botToken],
        network: "discord",
        label: "check channel",
        mock: { id: channelId, type: 0, name: "announcements", guild_id: "1000000000000000001" },
      })
    ).json;
    const forum = FORUM_TYPES.has(Number(ch.type));
    return [
      {
        account: {
          id: `discord:${ch.id}`,
          network: "discord",
          handle: `#${ch.name ?? ch.id}`,
          name: ch.name,
          notes: [`bot ${me.username}`, ...(forum ? ["forum"] : [])],
        },
        credentials: { botToken, botId: me.id, channelId: ch.id, guildId: ch.guild_id, forum },
      },
    ];
  },
  async publish(ctx, job: PublishJob) {
    const files = job.done.length ? [] : await Promise.all(job.media.map((m) => ctx.media.load(m)));
    const parts = [job.text, ...job.thread];
    const ids = [...job.done];
    const webhook = !!ctx.creds.webhookToken;
    let channel = String(ctx.creds.channelId);
    let threadId: string | undefined = job.options.threadId ?? ctx.creds.threadId;
    if (ctx.creds.forum && ids.length) threadId = ids[0]; // resume inside the forum post we already created
    for (let i = ids.length; i < parts.length; i++) {
      const content = parts[i]!;
      const withFiles = i === 0 ? files.map((f, n) => ({ ...f, alt: job.media[n]?.alt })) : [];
      let msg: any;
      if (ctx.creds.forum && !threadId) {
        const name = String(job.options.title ?? titleOf(content, 100));
        if (webhook) {
          msg = await send(
            ctx,
            `${API}/webhooks/${ctx.creds.webhookId}/${ctx.creds.webhookToken}?wait=true`,
            { content, thread_name: name, allowed_mentions: noMentions, ...(job.options.tags ? { applied_tags: job.options.tags } : {}) },
            withFiles,
            "forum post (webhook)",
            { id: "1300000000000000001", channel_id: "1300000000000000001" },
          );
          threadId = msg.channel_id;
        } else {
          const th = await send(
            ctx,
            `${API}/channels/${channel}/threads`,
            { name, message: { content, allowed_mentions: noMentions }, ...(job.options.tags ? { applied_tags: job.options.tags } : {}) },
            withFiles,
            "forum post",
            { id: "1300000000000000001", message: { id: "1300000000000000001" } },
          );
          threadId = th.id;
          msg = { id: th.message?.id ?? th.id, channel_id: th.id };
        }
      } else if (webhook) {
        msg = await send(
          ctx,
          `${API}/webhooks/${ctx.creds.webhookId}/${ctx.creds.webhookToken}?wait=true${threadId ? `&thread_id=${threadId}` : ""}`,
          { content, allowed_mentions: noMentions },
          withFiles,
          i === 0 ? "webhook message" : `webhook message (part ${i + 1})`,
          { id: `14000000000000000${i}`, channel_id: threadId ?? channel },
        );
      } else {
        const target = threadId ?? channel;
        const prev = i > 0 ? ids[i - 1] : job.replyTo;
        msg = await send(
          ctx,
          `${API}/channels/${target}/messages`,
          {
            content,
            allowed_mentions: noMentions,
            // Discord dedupes the same nonce for a few minutes
            nonce: `${job.key.slice(0, 20)}${i}`.slice(0, 25),
            enforce_nonce: true,
            ...(prev ? { message_reference: { message_id: prev, fail_if_not_exists: false } } : {}),
          },
          withFiles,
          i === 0 ? "message" : `message (part ${i + 1})`,
          { id: `14000000000000000${i}`, channel_id: target },
        );
      }
      channel = msg.channel_id ?? channel;
      ids.push(String(msg.id));
      await job.progress(String(msg.id));
    }
    const firstChannel = ctx.creds.forum ? (threadId ?? channel) : channel;
    return { remoteId: ids[0]!, remoteIds: ids, url: messageUrl(ctx, firstChannel, ids[0]!) };
  },
  async reply(ctx, to, text) {
    if (!ctx.creds.botToken) throw new ClaudiaSocialError("unsupported", "Webhook connections can't reply. Connect a bot for replies.", { network: "discord" });
    const msg = await send(
      ctx,
      `${API}/channels/${ctx.creds.channelId}/messages`,
      { content: text, allowed_mentions: noMentions, message_reference: { message_id: to, fail_if_not_exists: false } },
      [],
      "reply",
      { id: "1500000000000000001", channel_id: ctx.creds.channelId },
    );
    return { remoteId: msg.id, url: messageUrl(ctx, ctx.creds.channelId, msg.id) };
  },
  async inbox(ctx, cursor) {
    if (!ctx.creds.botToken) return { items: [], cursor, reads: 0 };
    const res = await ctx.http.request({
      method: "GET",
      url: `${API}/channels/${ctx.creds.channelId}/messages?limit=50${cursor?.after ? `&after=${cursor.after}` : ""}`,
      headers: auth(ctx),
      secrets: [ctx.creds.botToken],
      network: "discord",
      label: "read channel",
      mock: [],
    });
    const list: any[] = Array.isArray(res.json) ? res.json : [];
    const bot = String(ctx.creds.botId);
    let after = cursor?.after;
    const items = [];
    for (const m of list) {
      if (!after || BigInt(m.id) > BigInt(after)) after = m.id;
      if (m.author?.id === bot) continue;
      const mentioned = (m.mentions ?? []).some((u: any) => u.id === bot);
      const replied = m.referenced_message?.author?.id === bot;
      if (!mentioned && !replied) continue;
      items.push({
        kind: replied ? ("reply" as const) : ("mention" as const),
        id: m.id,
        from: m.author?.username ?? m.author?.id,
        text: m.content ?? "",
        at: Date.parse(m.timestamp) || Date.now(),
        url: messageUrl(ctx, ctx.creds.channelId, m.id),
      });
    }
    return { items, cursor: { after }, reads: 1 };
  },
};
