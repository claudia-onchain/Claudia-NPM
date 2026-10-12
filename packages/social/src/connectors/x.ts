// X (Twitter) API v2 with the user's own developer app (pay-per-use credits).
// Docs: https://docs.x.com/x-api/posts/create-post · https://docs.x.com/x-api/media/upload-media
//       https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
//       https://docs.x.com/x-api/getting-started/pricing
import { ClaudiaSocialError } from "../errors.js";
import { basicAuth } from "../oauth.js";
import { qs } from "../util.js";
import type { ConnCtx, Connected, Connector } from "./base.js";
import { bearer, caps, chain, info, poll } from "./common.js";

const API = "https://api.x.com";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write", "dm.read", "dm.write"];
// pay-per-use list prices (docs.x.com/x-api/getting-started/pricing, checked 2026-10-08)
export const X_PRICES = { post: 0.015, postWithUrl: 0.2, summonedReply: 0.01, postRead: 0.005, dmSend: 0.015, dmRead: 0.01, mediaMetadata: 0.005 };

function tokenHeaders(c: { clientId: string; clientSecret?: string }): Record<string, string> {
  return c.clientSecret ? { Authorization: basicAuth(c.clientId, c.clientSecret) } : {};
}

async function me(ctx: ConnCtx, token: string) {
  const res = await ctx.http.request({
    method: "GET",
    url: `${API}/2/users/me?${qs({ "user.fields": "profile_image_url,name,username" })}`,
    headers: bearer(token),
    secrets: [token],
    network: "x",
    label: "who am I",
    mock: { data: { id: "1234567890", username: "claudia_agent", name: "Claudia Agent" } },
  });
  return res.json.data as { id: string; username: string; name?: string; profile_image_url?: string };
}

async function uploadMedia(ctx: ConnCtx, job: { media: { path: string; mime?: string; alt?: string }[] }): Promise<string[]> {
  const token = ctx.creds.accessToken as string;
  const ids: string[] = [];
  for (const [i, m] of job.media.entries()) {
    const f = await ctx.media.load(m);
    let id: string;
    if (f.kind === "image") {
      const category = f.mime === "image/gif" ? "tweet_gif" : "tweet_image";
      const res = await ctx.http.request({
        method: "POST",
        url: `${API}/2/media/upload`,
        headers: bearer(token),
        multipart: [
          { name: "media", file: { bytes: f.bytes, mime: f.mime, filename: f.filename } },
          { name: "media_category", value: category },
        ],
        secrets: [token],
        network: "x",
        label: `media upload ${i + 1}`,
        timeoutMs: 5 * 60_000,
        mock: { data: { id: `17000000000000000${i}`, media_key: `3_17000000000000000${i}` } },
      });
      id = res.json.data.id;
    } else {
      // chunked: initialize → append (≤5 MB segments) → finalize → status
      const init = await ctx.http.request({
        method: "POST",
        url: `${API}/2/media/upload/initialize`,
        headers: bearer(token),
        json: { media_type: f.mime, total_bytes: f.size, media_category: "tweet_video" },
        secrets: [token],
        network: "x",
        label: `video upload ${i + 1}: initialize`,
        mock: { data: { id: `18000000000000000${i}`, media_key: `7_18000000000000000${i}` } },
      });
      id = init.json.data.id;
      const SEG = 5 * 1024 * 1024;
      for (let off = 0, seg = 0; off < f.size; off += SEG, seg++) {
        await ctx.http.request({
          method: "POST",
          url: `${API}/2/media/upload/${id}/append`,
          headers: bearer(token),
          multipart: [
            { name: "segment_index", value: String(seg) },
            { name: "media", file: { bytes: f.bytes.subarray(off, off + SEG), mime: "application/octet-stream", filename: f.filename } },
          ],
          secrets: [token],
          network: "x",
          label: `video upload ${i + 1}: append ${seg}`,
          timeoutMs: 5 * 60_000,
        });
      }
      const fin = await ctx.http.request({
        method: "POST",
        url: `${API}/2/media/upload/${id}/finalize`,
        headers: bearer(token),
        secrets: [token],
        network: "x",
        label: `video upload ${i + 1}: finalize`,
        mock: { data: { id, processing_info: { state: "succeeded" } } },
      });
      if (fin.json.data?.processing_info && fin.json.data.processing_info.state !== "succeeded") {
        await poll(
          ctx,
          async () => {
            const st = await ctx.http.request({
              method: "GET",
              url: `${API}/2/media/upload?${qs({ command: "STATUS", media_id: id })}`,
              headers: bearer(token),
              secrets: [token],
              network: "x",
              label: "video status",
              mock: { data: { processing_info: { state: "succeeded" } } },
            });
            const s = st.json.data?.processing_info?.state;
            if (s === "failed") throw new ClaudiaSocialError("provider_error", "X could not process the video.", { network: "x" });
            return s === "succeeded" || !s ? true : undefined;
          },
          { what: "X video", everyMs: 3000 },
        );
      }
    }
    if (m.alt) {
      await ctx.http.request({
        method: "POST",
        url: `${API}/2/media/metadata`,
        headers: bearer(token),
        json: { id, metadata: { alt_text: { text: m.alt.slice(0, 1000) } } },
        secrets: [token],
        network: "x",
        label: `alt text ${i + 1}`,
      });
    }
    ids.push(id);
  }
  return ids;
}

/** X only lets the API reply to posts whose author @mentioned (or quoted) this account. */
async function assertSummoned(ctx: ConnCtx, to: string): Promise<void> {
  if (ctx.mentionCache.has(to)) return;
  const token = ctx.creds.accessToken as string;
  const res = await ctx.http.request({
    method: "GET",
    url: `${API}/2/tweets/${encodeURIComponent(to)}?${qs({ "tweet.fields": "entities,author_id,referenced_tweets", expansions: "referenced_tweets.id.author_id" })}`,
    headers: bearer(token),
    secrets: [token],
    network: "x",
    label: "check the post mentions this account (1 post read)",
    mock: { data: { id: to, entities: { mentions: [{ username: ctx.creds.username ?? "claudia_agent" }] } } },
  });
  const handle = String(ctx.creds.username ?? "").toLowerCase();
  const mentions: { username: string }[] = res.json.data?.entities?.mentions ?? [];
  const quotedUs = (res.json.includes?.users ?? []).some((u: any) => String(u.username).toLowerCase() === handle);
  if (!mentions.some((m) => m.username.toLowerCase() === handle) && !quotedUs) {
    throw new ClaudiaSocialError("blocked", `X only allows replies to posts that mention @${ctx.creds.username}. Post ${to} doesn't.`, {
      network: "x",
      hint: "Reply only to posts in the X inbox (mentions), or post a new post instead.",
    });
  }
}

async function createPost(ctx: ConnCtx, body: Record<string, unknown>, label: string) {
  const token = ctx.creds.accessToken as string;
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}/2/tweets`,
    headers: bearer(token),
    json: body,
    secrets: [token],
    network: "x",
    label,
    mock: { data: { id: `19${Math.floor(Math.random() * 1e15)}`, text: body.text } },
  });
  return res.json.data.id as string;
}

export const xConnector: Connector = {
  id: "x",
  counter: "x",
  labels: {
    ai: "native",
    aiName: "X made_with_ai",
    aiWarning: "X also wants bot accounts to show the \"Automated\" label (Settings → Your account → Account information → Automation). That is an account setting; turn it on once.",
    adNative: "X paid_partnership",
  },
  info: info({
    id: "x",
    name: "X",
    tier: "direct",
    auth: "oauth-loopback",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, dm: true, inbox: true }),
    limits: { maxChars: 280, maxImages: 4, maxVideoMb: 512, perDay: 10 },
    costHint: "Pay-per-use on your own X developer account: about $0.015 per post, $0.20 per post with a link, $0.01 per reply to a mention, $0.005 per post read (inbox).",
    setup:
      "Create an app at developer.x.com (pay-per-use). In User authentication settings choose OAuth 2.0, type \"Web App, Automated App or Bot\" (confidential) or \"Native App\" (public), permissions Read + Write + Direct Messages, and add the callback URL http://127.0.0.1:<port>/oauth/callback exactly (Claudia Local: http://127.0.0.1:3939/oauth/callback). Copy the OAuth 2.0 Client ID (and Client Secret) into the key \"x\".",
    docs: "https://docs.x.com/x-api/posts/create-post",
    scopes: SCOPES,
    keyNames: ["x"],
  }),
  cost(job) {
    const parts = [job.text, ...job.thread];
    return parts.reduce((sum, p, i) => {
      if (/https?:\/\//.test(p)) return sum + X_PRICES.postWithUrl;
      if (i === 0 && job.reply) return sum + X_PRICES.summonedReply;
      return sum + X_PRICES.post;
    }, 0);
  },
  check(_a, job) {
    const tags = [job.text, ...job.thread].map((t) => (t.match(/(^|[^\w$])\$[A-Za-z][A-Za-z0-9_]{0,11}\b/g) ?? []).length);
    if (tags.some((n) => n > 1)) return "X rejects API posts with more than one $cashtag. Keep one per post.";
    if (job.media.length > 1 && job.media.some((m) => /video|\.mp4|\.mov|\.gif$/i.test(m.mime ?? m.path))) return "X takes up to 4 images, or 1 GIF, or 1 video per post.";
    return undefined;
  },
  warnings(_a, job) {
    const w: string[] = [];
    if (job.media.length) w.push("Media upload price is not on X's price list; it may add cost.");
    return w;
  },
  oauth: {
    redirect: "loopback",
    keyName: "x",
    scopes: SCOPES,
    needsSecret: false,
    authorizeUrl(p) {
      return `https://x.com/i/oauth2/authorize?${qs({
        response_type: "code",
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: p.scopes.join(" "),
        state: p.state,
        code_challenge: p.challenge,
        code_challenge_method: "S256",
      })}`;
    },
    async exchange(ctx, p): Promise<Connected> {
      const form: Record<string, string> = { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier };
      if (!p.clientSecret) form.client_id = p.clientId;
      const res = await ctx.http.request({
        method: "POST",
        url: `${API}/2/oauth2/token`,
        headers: tokenHeaders(p),
        form,
        secrets: [p.clientSecret, p.code],
        network: "x",
        label: "token exchange",
        mock: { access_token: "x-access", refresh_token: "x-refresh", expires_in: 7200, scope: SCOPES.join(" ") },
      });
      const t = res.json;
      const u = await me(ctx, t.access_token);
      return {
        account: { id: `x:${u.id}`, network: "x", handle: `@${u.username}`, name: u.name, avatar: u.profile_image_url },
        credentials: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + Number(t.expires_in ?? 7200) * 1000,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          userId: u.id,
          username: u.username,
        },
      };
    },
  },
  async refresh(ctx) {
    const c = ctx.creds as { clientId: string; clientSecret?: string; refreshToken: string };
    const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: c.refreshToken };
    if (!c.clientSecret) form.client_id = c.clientId;
    const res = await ctx.http.request({
      method: "POST",
      url: `${API}/2/oauth2/token`,
      headers: tokenHeaders(c),
      form,
      secrets: [c.clientSecret, c.refreshToken],
      network: "x",
      label: "token refresh",
      mock: { access_token: "x-access-2", refresh_token: "x-refresh-2", expires_in: 7200 },
    });
    // X may rotate the refresh token: always keep the newest one
    return {
      accessToken: res.json.access_token,
      refreshToken: res.json.refresh_token ?? c.refreshToken,
      expiresAt: Date.now() + Number(res.json.expires_in ?? 7200) * 1000,
    };
  },
  async publish(ctx, job) {
    if (job.replyTo && job.done.length === 0) await assertSummoned(ctx, job.replyTo);
    const mediaIds = job.done.length ? [] : await uploadMedia(ctx, job);
    const ids = await chain(job, (text, replyTo, i) => {
      const body: Record<string, unknown> = { text };
      if (i === 0 && mediaIds.length) body.media = { media_ids: mediaIds };
      if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
      if (job.flags.ai) body.made_with_ai = true;
      if (job.flags.ad) body.paid_partnership = true;
      return createPost(ctx, body, i === 0 ? "create post" : `thread part ${i + 1}`);
    });
    const user = ctx.creds.username ?? "i";
    return { remoteId: ids[0]!, remoteIds: ids, url: `https://x.com/${user}/status/${ids[0]}` };
  },
  async reply(ctx, to, text, flags) {
    const token = ctx.creds.accessToken as string;
    if (to.startsWith("dm:")) {
      const participant = to.slice(3);
      const res = await ctx.http.request({
        method: "POST",
        url: `${API}/2/dm_conversations/with/${encodeURIComponent(participant)}/messages`,
        headers: bearer(token),
        json: { text },
        secrets: [token],
        network: "x",
        label: "send DM",
        mock: { data: { dm_conversation_id: `${participant}-1234567890`, dm_event_id: "1900000000000000001" } },
      });
      return { remoteId: res.json.data.dm_event_id };
    }
    await assertSummoned(ctx, to);
    const body: Record<string, unknown> = { text, reply: { in_reply_to_tweet_id: to } };
    if (flags.ai) body.made_with_ai = true;
    const id = await createPost(ctx, body, "reply");
    return { remoteId: id, url: `https://x.com/${ctx.creds.username ?? "i"}/status/${id}` };
  },
  async inbox(ctx, cursor, budget) {
    const token = ctx.creds.accessToken as string;
    const max = Math.max(5, Math.min(100, budget));
    const res = await ctx.http.request({
      method: "GET",
      url: `${API}/2/users/${ctx.creds.userId}/mentions?${qs({
        max_results: max,
        since_id: cursor?.sinceId,
        "tweet.fields": "created_at,author_id,conversation_id",
        expansions: "author_id",
        "user.fields": "username",
      })}`,
      headers: bearer(token),
      secrets: [token],
      network: "x",
      label: "mentions",
      mock: { data: [], meta: { result_count: 0 } },
    });
    const users = new Map<string, string>((res.json.includes?.users ?? []).map((u: any) => [u.id, u.username]));
    const items = (res.json.data ?? []).map((t: any) => ({
      kind: "mention" as const,
      id: t.id,
      from: `@${users.get(t.author_id) ?? t.author_id}`,
      text: t.text,
      at: Date.parse(t.created_at ?? "") || Date.now(),
      url: `https://x.com/${users.get(t.author_id) ?? "i"}/status/${t.id}`,
    }));
    return { items, cursor: { sinceId: res.json.meta?.newest_id ?? cursor?.sinceId }, reads: Math.max(1, Number(res.json.meta?.result_count ?? items.length)) };
  },
};
