// v2 direct: Pinterest API v5 with the user's own Pinterest app.
// Docs: https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
//       https://developers.pinterest.com/docs/api/v5/pins-create (schema: github.com/pinterest/api-description v5/openapi.yaml)
//       https://developers.pinterest.com/docs/key-concepts/access-tiers/
import { ClaudiaSocialError } from "../errors.js";
import { basicAuth } from "../oauth.js";
import { qs } from "../util.js";
import type { ConnCtx, Connector } from "./base.js";
import { bearer, caps, info, poll, titleOf } from "./common.js";

const API = "https://api.pinterest.com/v5";
const SCOPES = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];

async function token(ctx: ConnCtx, form: Record<string, string>, c: { clientId: string; clientSecret?: string }, label: string, secrets: (string | undefined)[]) {
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}/oauth/token`,
    headers: { Authorization: basicAuth(c.clientId, c.clientSecret ?? "") },
    form,
    secrets: [c.clientSecret, ...secrets],
    network: "pinterest",
    label,
    mock: { access_token: "pina_dryrun", refresh_token: "pinr_dryrun", expires_in: 2592000, refresh_token_expires_in: 5184000 },
  });
  return res.json;
}

export const pinterestConnector: Connector = {
  id: "pinterest",
  counter: "codepoints",
  labels: { ai: "native", aiName: "Pinterest ai_disclosures AI_MODIFIED" },
  info: info({
    id: "pinterest",
    name: "Pinterest",
    tier: "v2",
    auth: "oauth-relay",
    caps: caps({ image: true, video: true, text: true }),
    limits: { maxChars: 800, maxImages: 5, maxVideoMb: 2048, perDay: 10 },
    setup:
      "At developers.pinterest.com create an app, add the redirect URI https://useclaudia.xyz/relay/oauth/callback (or http://localhost:<port>/oauth/callback with params.redirectUri), and copy the App ID + App secret into the key \"pinterest\". Connect with params.boardId (or pass options.pinterest.boardId per post). New apps start on Trial access: pins are visible only to you until Pinterest grants Standard access.",
    docs: "https://developers.pinterest.com/docs/api/v5/pins-create",
    scopes: SCOPES,
    keyNames: ["pinterest"],
  }),
  check(_a, job) {
    if (!job.media.length) return "Pinterest pins need an image or a video.";
    return undefined;
  },
  oauth: {
    redirect: "relay",
    keyName: "pinterest",
    scopes: SCOPES,
    needsSecret: true,
    authorizeUrl(p) {
      return `https://www.pinterest.com/oauth/?${qs({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: p.scopes.join(","), state: p.state })}`;
    },
    async exchange(ctx, p) {
      const t = await token(ctx, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri }, p, "token exchange", [p.code]);
      const me = (
        await ctx.http.request({ method: "GET", url: `${API}/user_account`, headers: bearer(t.access_token), secrets: [t.access_token], network: "pinterest", label: "who am I", mock: { username: "claudia", profile_image: "" } })
      ).json;
      return {
        account: { id: `pinterest:${me.username}`, network: "pinterest", handle: `@${me.username}`, name: me.business_name ?? me.username, avatar: me.profile_image, notes: ["Trial access: pins visible only to you until Standard access"] },
        credentials: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + Number(t.expires_in ?? 2592000) * 1000,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          boardId: p.params.boardId,
        },
      };
    },
  },
  async refresh(ctx) {
    const c = ctx.creds;
    const t = await token(ctx, { grant_type: "refresh_token", refresh_token: c.refreshToken }, c as { clientId: string; clientSecret?: string }, "token refresh", [c.refreshToken]);
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: Date.now() + Number(t.expires_in ?? 2592000) * 1000 };
  },
  async publish(ctx, job) {
    const boardId = String(job.options.boardId ?? ctx.creds.boardId ?? "");
    if (!boardId) throw new ClaudiaSocialError("invalid", "Pinterest needs a board.", { network: "pinterest", hint: "Pass options.pinterest.boardId, or connect with params.boardId." });
    const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
    let media_source: Record<string, unknown>;
    const video = files.find((f) => f.kind === "video");
    if (video) {
      const reg = (
        await ctx.http.request({
          method: "POST",
          url: `${API}/media`,
          headers: bearer(ctx.creds.accessToken),
          json: { media_type: "video" },
          secrets: [ctx.creds.accessToken],
          network: "pinterest",
          label: "register video",
          mock: { media_id: "12345", upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/", upload_parameters: { key: "uploads/dryrun", policy: "…", "x-amz-signature": "…" } },
        })
      ).json;
      await ctx.http.request({
        method: "POST",
        url: reg.upload_url,
        multipart: [...Object.entries<string>(reg.upload_parameters ?? {}).map(([name, value]) => ({ name, value })), { name: "file", file: { bytes: video.bytes, mime: video.mime, filename: video.filename } }],
        network: "pinterest",
        label: "upload video (S3 form)",
        timeoutMs: 30 * 60_000,
        mockStatus: 204,
      });
      await poll(
        ctx,
        async () => {
          const st = await ctx.http.request({ method: "GET", url: `${API}/media/${reg.media_id}`, headers: bearer(ctx.creds.accessToken), secrets: [ctx.creds.accessToken], network: "pinterest", label: "video status", mock: { status: "succeeded" } });
          if (st.json.status === "failed") throw new ClaudiaSocialError("provider_error", "Pinterest could not process the video.", { network: "pinterest" });
          return st.json.status === "succeeded" ? true : undefined;
        },
        { what: "Pinterest video", everyMs: 5000 },
      );
      media_source = { source_type: "video_id", media_id: reg.media_id, cover_image_key_frame_time: 0 };
    } else if (files.length === 1) {
      const f = files[0]!;
      media_source = { source_type: "image_base64", content_type: f.mime === "image/png" ? "image/png" : "image/jpeg", data: Buffer.from(f.bytes).toString("base64") };
    } else {
      media_source = {
        source_type: "multiple_image_base64",
        items: files.slice(0, 5).map((f) => ({ content_type: f.mime === "image/png" ? "image/png" : "image/jpeg", data: Buffer.from(f.bytes).toString("base64") })),
      };
    }
    const res = await ctx.http.request({
      method: "POST",
      url: `${API}/pins`,
      headers: bearer(ctx.creds.accessToken),
      json: {
        board_id: boardId,
        title: titleOf(String(job.options.title ?? job.text), 100),
        description: job.text.slice(0, 800),
        ...(job.link ? { link: job.link } : {}),
        ...(job.media[0]?.alt ? { alt_text: job.media[0].alt.slice(0, 500) } : {}),
        ...(job.flags.ai ? { ai_disclosures: { values: ["AI_MODIFIED"] } } : {}),
        media_source,
      },
      secrets: [ctx.creds.accessToken],
      network: "pinterest",
      label: "create pin",
      mockStatus: 201,
      mock: { id: "813744226420795884" },
    });
    return { remoteId: res.json.id, url: `https://www.pinterest.com/pin/${res.json.id}/` };
  },
};
