// YouTube Data API v3 with the user's own Google Cloud project (OAuth client type "Desktop app", loopback redirect).
// Docs: https://developers.google.com/identity/protocols/oauth2/native-app
//       https://developers.google.com/youtube/v3/docs/videos/insert · /guides/using_resumable_upload_protocol
//       https://developers.google.com/youtube/v3/docs/commentThreads/list · /docs/comments/insert
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import type { ConnCtx, Connector } from "./base.js";
import { bearer, caps, cutBytes, info, isVideo, titleOf } from "./common.js";

const API = "https://www.googleapis.com/youtube/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

async function token(ctx: ConnCtx, form: Record<string, string>, label: string, secrets: (string | undefined)[]) {
  const res = await ctx.http.request({
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    form,
    secrets,
    network: "youtube",
    label,
    mock: { access_token: "ya29.dryrun", refresh_token: "1//dryrun", expires_in: 3599, token_type: "Bearer" },
  });
  return res.json;
}

export const youtubeConnector: Connector = {
  id: "youtube",
  counter: "codepoints",
  labels: { ai: "native", aiName: "YouTube containsSyntheticMedia" },
  info: info({
    id: "youtube",
    name: "YouTube",
    tier: "direct",
    auth: "oauth-loopback",
    caps: caps({ video: true, reply: true, inbox: true }),
    limits: { maxChars: 5000, maxImages: 1, maxVideoMb: 2048, perDay: 5 },
    costHint: "Uses your own Google Cloud quota: 100 uploads per day per project (separate bucket since June 2026), comments cost 50 units of the 10,000 daily units.",
    setup:
      "In Google Cloud Console create a project, enable \"YouTube Data API v3\", set up the OAuth consent screen (External, add yourself as a test user), then Credentials → Create OAuth client ID → \"Desktop app\". Desktop clients accept any http://127.0.0.1:<port> redirect, so nothing else to register. Copy Client ID + Client Secret into the key \"youtube\". Until Google audits your project, every upload is private (Claudia uploads private by default anyway); refresh tokens of apps in \"Testing\" expire after 7 days.",
    docs: "https://developers.google.com/youtube/v3/docs/videos/insert",
    scopes: SCOPES,
    keyNames: ["youtube"],
  }),
  check(_a, job) {
    const videos = job.media.filter((m) => /video|\.mp4|\.mov|\.webm|\.m4v/i.test(m.mime ?? m.path));
    if (videos.length !== 1) return "YouTube needs exactly one video file.";
    return undefined;
  },
  warnings(_a, job) {
    const w = ["Uploads go out private (draft) unless options.youtube.privacyStatus says otherwise; projects Google hasn't audited can only upload private videos."];
    if (job.options.shorts) w.push("Shorts: YouTube decides from the file. It must be vertical or square and up to 3 minutes.");
    return w;
  },
  oauth: {
    redirect: "loopback",
    keyName: "youtube",
    scopes: SCOPES,
    needsSecret: true,
    authorizeUrl(p) {
      return `https://accounts.google.com/o/oauth2/v2/auth?${qs({
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        response_type: "code",
        scope: p.scopes.join(" "),
        state: p.state,
        code_challenge: p.challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
      })}`;
    },
    async exchange(ctx, p) {
      const t = await token(
        ctx,
        { client_id: p.clientId, client_secret: p.clientSecret ?? "", code: p.code, code_verifier: p.verifier, grant_type: "authorization_code", redirect_uri: p.redirectUri },
        "token exchange",
        [p.clientSecret, p.code],
      );
      const ch = (
        await ctx.http.request({
          method: "GET",
          url: `${API}/channels?part=snippet&mine=true`,
          headers: bearer(t.access_token),
          secrets: [t.access_token],
          network: "youtube",
          label: "my channel",
          mock: { items: [{ id: "UCdryrun000000000000000", snippet: { title: "Claudia", customUrl: "@claudia", thumbnails: { default: { url: "" } } } }] },
        })
      ).json.items?.[0];
      if (!ch) throw new ClaudiaSocialError("invalid", "This Google account has no YouTube channel.", { network: "youtube", hint: "Create a channel at youtube.com first." });
      return {
        account: { id: `youtube:${ch.id}`, network: "youtube", handle: ch.snippet?.customUrl ?? ch.snippet?.title, name: ch.snippet?.title, avatar: ch.snippet?.thumbnails?.default?.url },
        credentials: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + Number(t.expires_in ?? 3599) * 1000,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          channelId: ch.id,
        },
      };
    },
  },
  async refresh(ctx) {
    const c = ctx.creds;
    const t = await token(ctx, { client_id: c.clientId, client_secret: c.clientSecret ?? "", refresh_token: c.refreshToken, grant_type: "refresh_token" }, "token refresh", [c.clientSecret, c.refreshToken]);
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: Date.now() + Number(t.expires_in ?? 3599) * 1000 };
  },
  async publish(ctx, job) {
    const m = job.media.find((x) => /video|\.mp4|\.mov|\.webm|\.m4v/i.test(x.mime ?? x.path))!;
    const f = await ctx.media.load(m);
    if (!isVideo(f.mime)) throw new ClaudiaSocialError("invalid", "YouTube needs a video file.", { network: "youtube" });
    const o = job.options;
    const title = titleOf(String(o.title ?? job.text), 100);
    const description = cutBytes(job.text.replace(/[<>]/g, ""), 5000);
    const status: Record<string, unknown> = {
      privacyStatus: o.privacyStatus ?? "private",
      selfDeclaredMadeForKids: !!o.madeForKids,
      containsSyntheticMedia: job.flags.ai,
    };
    if (o.publishAt) status.publishAt = new Date(Number(o.publishAt) || String(o.publishAt)).toISOString();
    const start = await ctx.http.request({
      method: "POST",
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      headers: { ...bearer(ctx.creds.accessToken), "X-Upload-Content-Length": String(f.size), "X-Upload-Content-Type": f.mime },
      json: {
        snippet: { title, description, categoryId: String(o.categoryId ?? "22"), ...(o.tags ? { tags: o.tags } : {}), ...(o.language ? { defaultLanguage: o.language } : {}) },
        status,
      },
      secrets: [ctx.creds.accessToken],
      network: "youtube",
      label: "start resumable upload",
      mockHeaders: { location: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=dryrun" },
    });
    const session = start.headers.location;
    if (!session) throw new ClaudiaSocialError("provider_error", "YouTube did not return an upload session.", { network: "youtube" });
    const up = await ctx.http.request({
      method: "PUT",
      url: session,
      headers: bearer(ctx.creds.accessToken),
      raw: { bytes: f.bytes, mime: f.mime },
      secrets: [ctx.creds.accessToken],
      network: "youtube",
      label: "upload video bytes",
      timeoutMs: 60 * 60_000,
      mockStatus: 201,
      mock: { id: "dQw4w9WgXcQ", status: { uploadStatus: "uploaded", privacyStatus: status.privacyStatus } },
    });
    const id = up.json.id as string;
    return { remoteId: id, url: o.shorts ? `https://www.youtube.com/shorts/${id}` : `https://youtu.be/${id}` };
  },
  async reply(ctx, to, text) {
    const res = await ctx.http.request({
      method: "POST",
      url: `${API}/comments?part=snippet`,
      headers: bearer(ctx.creds.accessToken),
      json: { snippet: { parentId: to, textOriginal: text } },
      secrets: [ctx.creds.accessToken],
      network: "youtube",
      label: "reply to comment (50 quota units)",
      mock: { id: "UgzDryRunReply" },
    });
    return { remoteId: res.json.id };
  },
  async inbox(ctx, cursor) {
    const res = await ctx.http.request({
      method: "GET",
      url: `${API}/commentThreads?${qs({ part: "snippet", allThreadsRelatedToChannelId: ctx.creds.channelId, maxResults: 50, order: "time", textFormat: "plainText" })}`,
      headers: bearer(ctx.creds.accessToken),
      secrets: [ctx.creds.accessToken],
      network: "youtube",
      label: "comments (1 quota unit)",
      mock: { items: [] },
    });
    const seen = cursor?.last ? Date.parse(cursor.last) : 0;
    let last = cursor?.last;
    const items = [];
    for (const t of res.json.items ?? []) {
      const c = t.snippet?.topLevelComment;
      const at = Date.parse(c?.snippet?.publishedAt ?? "");
      if (!c || at <= seen) continue;
      if (!last || at > Date.parse(last)) last = c.snippet.publishedAt;
      items.push({
        kind: "reply" as const,
        id: c.id,
        from: c.snippet.authorDisplayName,
        text: c.snippet.textOriginal ?? c.snippet.textDisplay ?? "",
        at,
        url: `https://www.youtube.com/watch?v=${c.snippet.videoId}&lc=${c.id}`,
      });
    }
    return { items, cursor: { last }, reads: 1 };
  },
};
