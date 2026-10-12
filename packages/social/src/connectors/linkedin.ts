// LinkedIn personal profile through the user's own app ("Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect").
// Docs: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
//       https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
//       https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api · .../videos-api
//       https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import type { ConnCtx, Connector } from "./base.js";
import { bearer, caps, info, poll } from "./common.js";

const API = "https://api.linkedin.com";
export const LINKEDIN_VERSION = "202609";
const SCOPES = ["openid", "profile", "w_member_social"];

function rest(ctx: ConnCtx): Record<string, string> {
  return { ...bearer(ctx.creds.accessToken), "Linkedin-Version": String(ctx.creds.version ?? LINKEDIN_VERSION), "X-Restli-Protocol-Version": "2.0.0" };
}

/** "little" text format: reserved characters need a backslash. Hashtags (#word) stay live. */
export function escapeLittle(text: string): string {
  return text.replace(/[|{}@[\]()<>\\*_~#]/g, (c, i: number, s: string) => (c === "#" && /[\p{L}\p{N}_]/u.test(s[i + 1] ?? "") && (i === 0 || /\s/.test(s[i - 1]!)) ? c : `\\${c}`));
}

async function uploadImage(ctx: ConnCtx, owner: string, f: { bytes: Uint8Array; mime: string }, i: number): Promise<string> {
  const init = await ctx.http.request({
    method: "POST",
    url: `${API}/rest/images?action=initializeUpload`,
    headers: rest(ctx),
    json: { initializeUploadRequest: { owner } },
    secrets: [ctx.creds.accessToken],
    network: "linkedin",
    label: `image ${i + 1}: initialize`,
    mock: { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/dryrun-image", image: `urn:li:image:D4E10dryrun${i}` } },
  });
  await ctx.http.request({
    method: "PUT",
    url: init.json.value.uploadUrl,
    headers: bearer(ctx.creds.accessToken),
    raw: { bytes: f.bytes, mime: f.mime },
    secrets: [ctx.creds.accessToken],
    network: "linkedin",
    label: `image ${i + 1}: upload`,
    timeoutMs: 5 * 60_000,
  });
  return init.json.value.image;
}

async function uploadVideo(ctx: ConnCtx, owner: string, f: { bytes: Uint8Array; mime: string; size: number }): Promise<string> {
  const init = await ctx.http.request({
    method: "POST",
    url: `${API}/rest/videos?action=initializeUpload`,
    headers: rest(ctx),
    json: { initializeUploadRequest: { owner, fileSizeBytes: f.size, uploadCaptions: false, uploadThumbnail: false } },
    secrets: [ctx.creds.accessToken],
    network: "linkedin",
    label: "video: initialize",
    mock: { value: { video: "urn:li:video:D4E10dryrun", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://www.linkedin.com/dms-uploads/dryrun-video", firstByte: 0, lastByte: f.size - 1 }] } },
  });
  const v = init.json.value;
  const etags: string[] = [];
  for (const [n, part] of (v.uploadInstructions as { uploadUrl: string; firstByte: number; lastByte: number }[]).entries()) {
    const res = await ctx.http.request({
      method: "PUT",
      url: part.uploadUrl,
      raw: { bytes: f.bytes.subarray(part.firstByte, part.lastByte + 1), mime: "application/octet-stream" },
      network: "linkedin",
      label: `video: part ${n + 1}`,
      timeoutMs: 10 * 60_000,
      mockHeaders: { etag: `"dryrun-etag-${n}"` },
    });
    etags.push(res.headers.etag ?? "");
  }
  await ctx.http.request({
    method: "POST",
    url: `${API}/rest/videos?action=finalizeUpload`,
    headers: rest(ctx),
    json: { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } },
    secrets: [ctx.creds.accessToken],
    network: "linkedin",
    label: "video: finalize",
  });
  await poll(
    ctx,
    async () => {
      const st = await ctx.http.request({
        method: "GET",
        url: `${API}/rest/videos/${encodeURIComponent(v.video)}`,
        headers: rest(ctx),
        secrets: [ctx.creds.accessToken],
        network: "linkedin",
        label: "video: status",
        mock: { status: "AVAILABLE" },
      });
      if (st.json.status === "PROCESSING_FAILED") throw new ClaudiaSocialError("provider_error", `LinkedIn could not process the video: ${st.json.processingFailureReason ?? ""}`, { network: "linkedin" });
      return st.json.status === "AVAILABLE" ? true : undefined;
    },
    { what: "LinkedIn video", everyMs: 5000 },
  );
  return v.video;
}

export const linkedinConnector: Connector = {
  id: "linkedin",
  counter: "codepoints",
  labels: { ai: "text" },
  info: info({
    id: "linkedin",
    name: "LinkedIn (personal profile)",
    tier: "direct",
    auth: "oauth-relay",
    caps: caps({ text: true, image: true, video: true }),
    limits: { maxChars: 3000, maxImages: 20, maxVideoMb: 500, perDay: 5 },
    setup:
      "Create an app at linkedin.com/developers (it must be tied to a LinkedIn Page; any page you admin works). Add the products \"Share on LinkedIn\" and \"Sign In with LinkedIn using OpenID Connect\". In Auth → Authorized redirect URLs add https://useclaudia.xyz/relay/oauth/callback (LinkedIn wants https; the relay bounces the code straight back to your machine). Copy Client ID + Client Secret into the key \"linkedin\". Tokens last 60 days and self-serve apps get no refresh token: Claudia reminds you a week before.",
    docs: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
    scopes: SCOPES,
    keyNames: ["linkedin"],
  }),
  check(_a, job) {
    const videos = job.media.filter((m) => /video|\.mp4|\.mov/i.test(m.mime ?? m.path)).length;
    if (videos && job.media.length > 1) return "LinkedIn takes one video, or 1–20 images, per post.";
    return undefined;
  },
  oauth: {
    redirect: "relay",
    keyName: "linkedin",
    scopes: SCOPES,
    needsSecret: true,
    authorizeUrl(p) {
      // the standard 3-legged flow (LinkedIn's PKCE endpoint is partner-only); the state is still checked
      return `https://www.linkedin.com/oauth/v2/authorization?${qs({ response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state, scope: p.scopes.join(" ") })}`;
    },
    async exchange(ctx, p) {
      const res = await ctx.http.request({
        method: "POST",
        url: "https://www.linkedin.com/oauth/v2/accessToken",
        form: { grant_type: "authorization_code", code: p.code, client_id: p.clientId, client_secret: p.clientSecret ?? "", redirect_uri: p.redirectUri },
        secrets: [p.clientSecret, p.code],
        network: "linkedin",
        label: "token exchange",
        mock: { access_token: "li-token", expires_in: 5184000, scope: SCOPES.join(",") },
      });
      const t = res.json;
      const u = (
        await ctx.http.request({
          method: "GET",
          url: `${API}/v2/userinfo`,
          headers: bearer(t.access_token),
          secrets: [t.access_token],
          network: "linkedin",
          label: "who am I",
          mock: { sub: "abc123XYZ", name: "Claudia Agent", picture: "" },
        })
      ).json;
      const expiresAt = Date.now() + Number(t.expires_in ?? 5184000) * 1000;
      return {
        account: { id: `linkedin:${u.sub}`, network: "linkedin", handle: u.name ?? u.sub, name: u.name, avatar: u.picture, expiresAt },
        credentials: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          personUrn: `urn:li:person:${u.sub}`,
        },
      };
    },
  },
  async refresh(ctx) {
    const c = ctx.creds;
    if (!c.refreshToken) return null; // self-serve apps: reconnect every 60 days
    const res = await ctx.http.request({
      method: "POST",
      url: "https://www.linkedin.com/oauth/v2/accessToken",
      form: { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret },
      secrets: [c.clientSecret, c.refreshToken],
      network: "linkedin",
      label: "token refresh",
    });
    return { accessToken: res.json.access_token, refreshToken: res.json.refresh_token ?? c.refreshToken, expiresAt: Date.now() + Number(res.json.expires_in) * 1000 };
  },
  async publish(ctx, job) {
    const owner = ctx.creds.personUrn as string;
    const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
    let content: Record<string, unknown> | undefined;
    const video = files.find((f) => f.kind === "video");
    if (video) content = { media: { id: await uploadVideo(ctx, owner, video), ...(video.alt ? { title: video.alt.slice(0, 200) } : {}) } };
    else if (files.length === 1) content = { media: { id: await uploadImage(ctx, owner, files[0]!, 0), ...(files[0]!.alt ? { altText: files[0]!.alt.slice(0, 4086) } : {}) } };
    else if (files.length > 1) {
      const images = [];
      for (const [i, f] of files.entries()) images.push({ id: await uploadImage(ctx, owner, f, i), ...(f.alt ? { altText: f.alt.slice(0, 4086) } : {}) });
      content = { multiImage: { images } };
    } else if (job.link && job.options.linkTitle) {
      content = { article: { source: job.link, title: String(job.options.linkTitle), ...(job.options.linkDescription ? { description: String(job.options.linkDescription) } : {}) } };
    }
    const res = await ctx.http.request({
      method: "POST",
      url: `${API}/rest/posts`,
      headers: rest(ctx),
      json: {
        author: owner,
        commentary: escapeLittle(job.text),
        visibility: job.options.visibility ?? "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...(content ? { content } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
      secrets: [ctx.creds.accessToken],
      network: "linkedin",
      label: "create post",
      mockStatus: 201,
      mockHeaders: { "x-restli-id": "urn:li:share:7380000000000000000" },
    });
    const urn = res.headers["x-restli-id"] ?? res.headers["x-linkedin-id"];
    if (!urn) throw new ClaudiaSocialError("provider_error", "LinkedIn did not return the post id.", { network: "linkedin", uncertain: true });
    return { remoteId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  },
};
