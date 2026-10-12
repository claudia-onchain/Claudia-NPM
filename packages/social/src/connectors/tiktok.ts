// v2 direct: TikTok Content Posting API with the user's own TikTok developer app (Desktop platform: loopback redirect).
// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
//       https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
//       https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
//       https://developers.tiktok.com/doc/login-kit-desktop (PKCE: code_challenge = hex(SHA-256(verifier)))
import { createHash } from "node:crypto";
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import type { ConnCtx, Connector } from "./base.js";
import { bearer, caps, info, poll, isVideo } from "./common.js";

const API = "https://open.tiktokapis.com/v2";
const SCOPES = ["user.info.basic", "video.publish", "video.upload"];
const JSONH = { "Content-Type": "application/json; charset=UTF-8" };
const MB = 1024 * 1024;

async function api(ctx: ConnCtx, path: string, body: unknown, label: string, mock: unknown) {
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}${path}`,
    headers: { ...bearer(ctx.creds.accessToken), ...JSONH },
    json: body,
    secrets: [ctx.creds.accessToken],
    network: "tiktok",
    label,
    mock: { data: mock, error: { code: "ok", message: "" } },
  });
  if (res.json.error && res.json.error.code !== "ok") {
    throw new ClaudiaSocialError(res.json.error.code === "spam_risk_too_many_posts" ? "rate_limited" : "provider_error", `TikTok: ${res.json.error.code} ${res.json.error.message ?? ""}`, { network: "tiktok" });
  }
  return res.json.data;
}

async function token(ctx: ConnCtx, form: Record<string, string>, label: string, secrets: (string | undefined)[]) {
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}/oauth/token/`,
    form,
    secrets,
    network: "tiktok",
    label,
    mock: { access_token: "act.dryrun", refresh_token: "rft.dryrun", expires_in: 86400, refresh_expires_in: 31536000, open_id: "open-id-dryrun", scope: SCOPES.join(",") },
  });
  if (res.json.error && !res.json.access_token) throw new ClaudiaSocialError("provider_error", `TikTok token: ${res.json.error_description ?? res.json.error}`, { network: "tiktok" });
  return res.json;
}

export const tiktokConnector: Connector = {
  id: "tiktok",
  counter: "utf16",
  labels: { ai: "native", aiName: "TikTok is_aigc", adNative: "TikTok brand_content_toggle" },
  info: info({
    id: "tiktok",
    name: "TikTok",
    tier: "v2",
    auth: "oauth-loopback",
    caps: caps({ video: true, text: true }),
    limits: { maxChars: 2200, maxImages: 1, maxVideoMb: 4096, perDay: 5 },
    setup:
      "At developers.tiktok.com create an app, add Login Kit + Content Posting API (Direct Post), choose the Desktop platform and register the redirect URI http://127.0.0.1:<port>/oauth/callback (TikTok allows 127.0.0.1 with a port for desktop apps). Copy the Client key + Client secret into the key \"tiktok\". Until TikTok audits your app every post is private (SELF_ONLY) and the account must be private. TikTok is strict about crypto: no token promotion, no return claims, no branded crypto content.",
    docs: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
    scopes: SCOPES,
    keyNames: ["tiktok"],
  }),
  check(_a, job) {
    const vids = job.media.filter((m) => /video|\.mp4|\.mov|\.webm/i.test(m.mime ?? m.path));
    if (vids.length !== 1 || job.media.length !== 1) return "TikTok here takes exactly one video. (Photo posts need a domain verified in your TikTok app, so they are not supported.)";
    return undefined;
  },
  warnings(_a, job) {
    const w = ["Posts are private (SELF_ONLY) until your TikTok app passes TikTok's audit."];
    if (/\$[A-Za-z]|coin|token|crypto|pump/i.test(job.text)) w.push("TikTok removes crypto promotion, even organic. Keep it to news/education with no tickers or calls to buy.");
    return w;
  },
  oauth: {
    redirect: "loopback",
    keyName: "tiktok",
    scopes: SCOPES,
    needsSecret: true,
    authorizeUrl(p) {
      // TikTok desktop PKCE is non-standard: hex(SHA-256(verifier)) instead of base64url
      const challenge = createHash("sha256").update(p.verifier).digest("hex");
      return `https://www.tiktok.com/v2/auth/authorize/?${qs({ client_key: p.clientId, scope: p.scopes.join(","), redirect_uri: p.redirectUri, state: p.state, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`;
    },
    async exchange(ctx, p) {
      const t = await token(
        ctx,
        { client_key: p.clientId, client_secret: p.clientSecret ?? "", code: p.code, grant_type: "authorization_code", redirect_uri: p.redirectUri, code_verifier: p.verifier },
        "token exchange",
        [p.clientSecret, p.code],
      );
      const u = (
        await ctx.http.request({
          method: "GET",
          url: `${API}/user/info/?${qs({ fields: "open_id,display_name,avatar_url,username" })}`,
          headers: bearer(t.access_token),
          secrets: [t.access_token],
          network: "tiktok",
          label: "who am I",
          mock: { data: { user: { open_id: t.open_id, display_name: "Claudia", username: "claudia", avatar_url: "" } } },
        })
      ).json.data?.user ?? {};
      return {
        account: { id: `tiktok:${t.open_id}`, network: "tiktok", handle: u.username ? `@${u.username}` : u.display_name ?? t.open_id, name: u.display_name, avatar: u.avatar_url, notes: ["private until audited"] },
        credentials: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + Number(t.expires_in ?? 86400) * 1000, clientId: p.clientId, clientSecret: p.clientSecret, openId: t.open_id },
      };
    },
  },
  async refresh(ctx) {
    const c = ctx.creds;
    const t = await token(ctx, { client_key: c.clientId, client_secret: c.clientSecret ?? "", grant_type: "refresh_token", refresh_token: c.refreshToken }, "token refresh", [c.clientSecret, c.refreshToken]);
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: Date.now() + Number(t.expires_in ?? 86400) * 1000 };
  },
  async publish(ctx, job) {
    const f = await ctx.media.load(job.media[0]!);
    if (!isVideo(f.mime)) throw new ClaudiaSocialError("invalid", "TikTok needs a video.", { network: "tiktok" });
    const creator = await api(ctx, "/post/publish/creator_info/query/", {}, "creator info", {
      creator_username: "claudia",
      creator_nickname: "Claudia",
      privacy_level_options: ["SELF_ONLY"],
      max_video_post_duration_sec: 600,
    });
    const privacy = String(job.options.privacyLevel ?? "SELF_ONLY");
    if (!(creator.privacy_level_options ?? []).includes(privacy)) {
      throw new ClaudiaSocialError("invalid", `TikTok allows ${JSON.stringify(creator.privacy_level_options)} for this account, not ${privacy}.`, { network: "tiktok", hint: "Unaudited apps can only post SELF_ONLY." });
    }
    if (job.flags.ad && privacy === "SELF_ONLY") {
      throw new ClaudiaSocialError("invalid", "TikTok doesn't allow branded content (a paid partnership) to be private.", { network: "tiktok", hint: "Post it publicly from an audited app, through a posting service, or by hand in the TikTok app with the Branded content toggle on." });
    }
    // TikTok: files up to 64 MB may go as one chunk (under 5 MB they must); bigger files use 10 MB chunks and the
    // last chunk takes the remainder (it may be up to 128 MB). total_chunk_count = floor(size / chunk_size).
    const single = f.size <= 64 * MB;
    const chunk = single ? f.size : 10 * MB;
    const count = single ? 1 : Math.floor(f.size / chunk);
    const init = await api(
      ctx,
      "/post/publish/video/init/",
      {
        post_info: {
          title: job.text.slice(0, 2200),
          privacy_level: privacy,
          // TikTok's UX rules: interactions off unless the person turned them on
          disable_comment: !job.options.allowComment,
          disable_duet: !job.options.allowDuet,
          disable_stitch: !job.options.allowStitch,
          is_aigc: job.flags.ai,
          // labels.ad = a paid third-party sponsorship → "Branded content". options.ownBrand = promoting your own
          // business → "Your brand". (TikTok's Content Posting API: brand_content_toggle / brand_organic_toggle.)
          brand_content_toggle: !!job.flags.ad,
          brand_organic_toggle: !!job.options.ownBrand,
        },
        source_info: { source: "FILE_UPLOAD", video_size: f.size, chunk_size: chunk, total_chunk_count: count },
      },
      "init direct post",
      { publish_id: "v_pub_dryrun", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=dryrun" },
    );
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? f.size - 1 : start + chunk - 1;
      await ctx.http.request({
        method: "PUT",
        url: init.upload_url,
        headers: { "Content-Range": `bytes ${start}-${end}/${f.size}` },
        raw: { bytes: f.bytes.subarray(start, end + 1), mime: f.mime },
        network: "tiktok",
        label: `upload chunk ${i + 1}/${count}`,
        timeoutMs: 30 * 60_000,
        ok: (s) => s === 201 || s === 206 || (s >= 200 && s < 300),
        mockStatus: i === count - 1 ? 201 : 206,
      });
    }
    const done = await poll(
      ctx,
      async () => {
        const st = await api(ctx, "/post/publish/status/fetch/", { publish_id: init.publish_id }, "status", { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] });
        if (st.status === "FAILED") throw new ClaudiaSocialError("provider_error", `TikTok: ${st.fail_reason ?? "failed"}`, { network: "tiktok" });
        return st.status === "PUBLISH_COMPLETE" || st.status === "SEND_TO_USER_INBOX" ? st : undefined;
      },
      { what: "TikTok post", everyMs: 10_000, tries: 60 },
    );
    const postId = done.publicaly_available_post_id?.[0] ?? done.publicly_available_post_id?.[0];
    return { remoteId: String(postId ?? init.publish_id), url: postId ? `https://www.tiktok.com/@${String(ctx.account?.handle ?? "").replace(/^@/, "")}/video/${postId}` : undefined };
  },
};
