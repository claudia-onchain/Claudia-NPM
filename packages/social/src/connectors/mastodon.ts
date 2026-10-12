// Mastodon (any instance). OAuth with PKCE on the user's instance (Claudia registers an app there for them),
// or an access token from Preferences → Development.
// Docs: https://docs.joinmastodon.org/methods/apps/ · /methods/oauth/ · /methods/statuses/ · /methods/media/ · /methods/notifications/
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import { need, type ConnCtx, type Connected, type Connector } from "./base.js";
import { bearer, caps, chain, info, poll } from "./common.js";

const SCOPES = ["read:accounts", "read:notifications", "write:statuses", "write:media"];

function instanceUrl(raw: string): string {
  const s = raw.trim().replace(/\/$/, "");
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

async function verify(ctx: ConnCtx, instance: string, token: string): Promise<Connected> {
  const res = await ctx.http.request({
    method: "GET",
    url: `${instance}/api/v1/accounts/verify_credentials`,
    headers: bearer(token),
    secrets: [token],
    network: "mastodon",
    label: "who am I",
    mock: { id: "109000000000000001", username: "claudia", acct: "claudia", display_name: "Claudia", avatar: "", bot: true },
  });
  const a = res.json;
  const host = new URL(instance).host;
  return {
    account: {
      id: `mastodon:${host}:${a.id}`,
      network: "mastodon",
      handle: `@${a.username}@${host}`,
      name: a.display_name || a.username,
      avatar: a.avatar,
      notes: [a.bot ? "bot flag on" : "bot flag off"],
    },
    credentials: { instance, accessToken: token, accountId: a.id },
  };
}

async function uploadMedia(ctx: ConnCtx, media: { path: string; mime?: string; alt?: string }[]): Promise<string[]> {
  const { instance, accessToken: token } = ctx.creds as { instance: string; accessToken: string };
  const ids: string[] = [];
  for (const [i, m] of media.entries()) {
    const f = await ctx.media.load(m);
    const res = await ctx.http.request({
      method: "POST",
      url: `${instance}/api/v2/media`,
      headers: bearer(token),
      multipart: [{ name: "file", file: { bytes: f.bytes, mime: f.mime, filename: f.filename } }, ...(m.alt ? [{ name: "description", value: m.alt.slice(0, 1500) }] : [])],
      secrets: [token],
      network: "mastodon",
      label: `media upload ${i + 1}`,
      timeoutMs: 10 * 60_000,
      mock: { id: `11000000000000000${i}`, type: f.kind, url: "https://files.example/x" },
    });
    const id = String(res.json.id);
    if (res.status === 202 || res.json.url === null) {
      await poll(
        ctx,
        async () => {
          const st = await ctx.http.request({
            method: "GET",
            url: `${instance}/api/v1/media/${id}`,
            headers: bearer(token),
            secrets: [token],
            network: "mastodon",
            label: "media processing",
            ok: (s) => s === 200 || s === 206,
          });
          return st.status === 200 ? true : undefined;
        },
        { what: "Mastodon media", everyMs: 2000 },
      );
    }
    ids.push(id);
  }
  return ids;
}

async function status(ctx: ConnCtx, body: Record<string, unknown>, idemKey: string, label: string) {
  const { instance, accessToken: token } = ctx.creds as { instance: string; accessToken: string };
  const res = await ctx.http.request({
    method: "POST",
    url: `${instance}/api/v1/statuses`,
    // the server keeps Idempotency-Key for 1 hour: a resend inside that window returns the same status
    headers: { ...bearer(token), "Idempotency-Key": idemKey },
    json: body,
    secrets: [token],
    network: "mastodon",
    label,
    mock: { id: `1120000000000000${Math.floor(Math.random() * 100)}`, url: `${instance}/@claudia/112000000000000000` },
  });
  return res.json as { id: string; url: string };
}

export const mastodonConnector: Connector = {
  id: "mastodon",
  counter: "mastodon",
  idempotent: true,
  labels: { ai: "account", aiName: "bot account flag" },
  info: info({
    id: "mastodon",
    name: "Mastodon",
    tier: "direct",
    auth: "oauth-loopback",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, inbox: true }),
    limits: { maxChars: 500, maxImages: 4, maxVideoMb: 40, perDay: 30 },
    setup:
      "Connect with params { instance: \"mastodon.social\" }: Claudia registers a small app on your instance with the redirect URI http://127.0.0.1:<port>/oauth/callback and opens the sign-in page (no developer portal needed). Or create an app yourself in Preferences → Development (scopes read:accounts read:notifications write:statuses write:media) and pass params { instance, accessToken }. Turn on \"This is an automated account\" in Profile settings so posts carry the bot label.",
    docs: "https://docs.joinmastodon.org/methods/statuses/",
    scopes: SCOPES,
    keyNames: ["mastodon"],
  }),
  warnings(account) {
    return account?.notes?.includes("bot flag off")
      ? ["Mastodon asks automated accounts to set the bot flag (Profile → \"This is an automated account\"). It is off for this account."]
      : [];
  },
  async connectKey(ctx, params, keys) {
    const instance = instanceUrl(need(params.instance, "Mastodon instance", "Pass params.instance, e.g. mastodon.social."));
    const token = need(params.accessToken ?? (await keys.get("mastodon")), "Mastodon access token", "Create one in Preferences → Development, or connect without it to sign in.");
    return [await verify(ctx, instance, token)];
  },
  oauth: {
    redirect: "loopback",
    keyName: "mastodon-app",
    scopes: SCOPES,
    needsSecret: true,
    async prepare(ctx, p) {
      const instance = instanceUrl(need(p.params.instance, "Mastodon instance", "Pass params.instance, e.g. mastodon.social."));
      if (p.clientId && p.clientSecret) return { clientId: p.clientId, clientSecret: p.clientSecret, extra: { instance } };
      const res = await ctx.http.request({
        method: "POST",
        url: `${instance}/api/v1/apps`,
        json: { client_name: "Claudia", redirect_uris: [p.redirectUri], scopes: SCOPES.join(" "), website: "https://useclaudia.xyz" },
        network: "mastodon",
        label: "register app on the instance",
        mock: { client_id: "mastodon-client-id", client_secret: "mastodon-client-secret" },
      });
      return { clientId: res.json.client_id, clientSecret: res.json.client_secret, extra: { instance } };
    },
    authorizeUrl(p) {
      return `${p.extra.instance}/oauth/authorize?${qs({
        response_type: "code",
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: p.scopes.join(" "),
        state: p.state,
        code_challenge: p.challenge,
        code_challenge_method: "S256",
      })}`;
    },
    async exchange(ctx, p) {
      const instance = p.extra.instance as string;
      const res = await ctx.http.request({
        method: "POST",
        url: `${instance}/oauth/token`,
        form: {
          grant_type: "authorization_code",
          code: p.code,
          client_id: p.clientId,
          client_secret: p.clientSecret ?? "",
          redirect_uri: p.redirectUri,
          code_verifier: p.verifier,
        },
        secrets: [p.clientSecret, p.code],
        network: "mastodon",
        label: "token exchange",
        mock: { access_token: "mastodon-token", token_type: "Bearer", scope: SCOPES.join(" ") },
      });
      const c = await verify(ctx, instance, res.json.access_token);
      c.credentials.clientId = p.clientId;
      c.credentials.clientSecret = p.clientSecret;
      return c;
    },
  },
  async publish(ctx, job) {
    const mediaIds = job.done.length ? [] : await uploadMedia(ctx, job.media);
    let firstUrl: string | undefined;
    const ids = await chain(job, async (text, replyTo, i) => {
      const body: Record<string, unknown> = { status: text, visibility: job.options.visibility ?? "public" };
      if (i === 0 && mediaIds.length) body.media_ids = mediaIds;
      if (replyTo) body.in_reply_to_id = replyTo;
      if (job.options.spoilerText) body.spoiler_text = job.options.spoilerText;
      if (job.options.language) body.language = job.options.language;
      const s = await status(ctx, body, `${job.key}-${i}`, i === 0 ? "create status" : `thread part ${i + 1}`);
      if (i === 0) firstUrl = s.url;
      return String(s.id);
    });
    return { remoteId: ids[0]!, remoteIds: ids, url: firstUrl ?? `${ctx.creds.instance}/statuses/${ids[0]}` };
  },
  async reply(ctx, to, text) {
    const s = await status(ctx, { status: text, in_reply_to_id: to, visibility: "public" }, `reply-${to}-${Buffer.from(text).toString("base64url").slice(0, 16)}`, "reply");
    return { remoteId: s.id, url: s.url };
  },
  async inbox(ctx, cursor) {
    const { instance, accessToken: token } = ctx.creds as { instance: string; accessToken: string };
    const res = await ctx.http.request({
      method: "GET",
      url: `${instance}/api/v1/notifications?${qs({ "types[]": "mention", limit: 40, since_id: cursor?.sinceId })}`,
      headers: bearer(token),
      secrets: [token],
      network: "mastodon",
      label: "notifications",
      mock: [],
    });
    const list: any[] = Array.isArray(res.json) ? res.json : [];
    const items = list.map((n) => ({
      kind: (n.status?.in_reply_to_account_id === ctx.creds.accountId ? "reply" : "mention") as "reply" | "mention",
      id: String(n.status?.id ?? n.id),
      from: `@${n.account?.acct}`,
      text: stripHtml(n.status?.content ?? ""),
      at: Date.parse(n.created_at) || Date.now(),
      url: n.status?.url,
    }));
    if (!res.dryRun && list.length === 0 && res.status !== 200) throw new ClaudiaSocialError("provider_error", "Mastodon notifications failed.", { network: "mastodon" });
    return { items, cursor: { sinceId: list[0]?.id ?? cursor?.sinceId }, reads: 1 };
  },
};

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
