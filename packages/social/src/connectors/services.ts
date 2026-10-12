// Posting services that reach Instagram, Facebook, Threads, TikTok, Pinterest, LinkedIn pages and more with ONE key
// the user gets from the service. Connecting a service creates one Claudia account per channel it has connected.
// Buffer:      https://developers.buffer.com (GraphQL at https://api.buffer.com)
// Zernio:      https://docs.zernio.com (formerly Late / getlate.dev; REST at https://zernio.com/api/v1)
// Upload-Post: https://docs.upload-post.com (REST at https://api.upload-post.com/api)
import { ClaudiaSocialError } from "../errors.js";
import type { MultipartPart } from "../transport.js";
import type { NetworkId } from "../types.js";
import { qs } from "../util.js";
import { need, type ConnCtx, type Connected, type Connector, type PublishJob } from "./base.js";
import { bearer, caps, info, poll, titleOf } from "./common.js";

const PLATFORM_TO_NETWORK: Record<string, NetworkId> = {
  twitter: "x",
  x: "x",
  instagram: "instagram",
  facebook: "facebook",
  linkedin: "linkedin",
  tiktok: "tiktok",
  pinterest: "pinterest",
  youtube: "youtube",
  mastodon: "mastodon",
  bluesky: "bluesky",
  threads: "threads",
  telegram: "telegram",
  discord: "discord",
};

function child(service: NetworkId, parentId: string, platform: string, remoteId: string, handle: string, name?: string, avatar?: string, extra: Record<string, unknown> = {}): Connected {
  const network = PLATFORM_TO_NETWORK[platform.toLowerCase()] ?? service;
  return {
    account: {
      id: `${service}:${platform.toLowerCase()}:${remoteId}`,
      network,
      handle,
      name,
      avatar,
      via: service,
      platform: platform.toLowerCase(),
      parent: parentId,
    },
    credentials: { channelId: remoteId, platform: platform.toLowerCase(), ...extra },
  };
}

const TEXT_LABEL = { ai: "text" as const };
function nativeFor(platforms: string[], name: string) {
  return (a: { platform?: string }) => (platforms.includes(a.platform ?? "") ? { ai: "native" as const, aiName: name } : TEXT_LABEL);
}

function needsMedia(platform: string, job: { media: unknown[] }): string | undefined {
  if (["instagram", "tiktok", "pinterest", "youtube"].includes(platform) && !job.media.length) return `${platform} posts need an image or video.`;
  return undefined;
}

// ======================================================================== Buffer

const BUFFER = "https://api.buffer.com";

async function gql(ctx: ConnCtx, query: string, variables: Record<string, unknown>, label: string, mock: unknown) {
  const res = await ctx.http.request({
    method: "POST",
    url: BUFFER,
    headers: bearer(ctx.creds.apiKey),
    json: { query, variables },
    secrets: [ctx.creds.apiKey],
    network: "buffer",
    label,
    mock: { data: mock },
  });
  if (res.json.errors?.length) throw new ClaudiaSocialError("provider_error", `Buffer: ${res.json.errors.map((e: any) => e.message).join("; ")}`, { network: "buffer" });
  return res.json.data;
}

const BUFFER_CREATE = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt sentAt externalLink } }
    ... on MutationError { message }
  }
}`;

function bufferMetadata(platform: string, job: PublishJob): Record<string, unknown> | undefined {
  const o = job.options;
  const ai = job.flags.ai;
  switch (platform) {
    case "instagram":
      return { instagram: { type: o.type ?? (job.media.some((m) => /video|\.mp4|\.mov/i.test(m.mime ?? m.path)) ? "reel" : "post"), shouldShareToFeed: o.shareToFeed ?? true, isAiGenerated: ai } };
    case "tiktok":
      return { tiktok: { isAiGenerated: ai, ...(o.title ? { title: o.title } : {}) } };
    case "youtube":
      return { youtube: { title: titleOf(String(o.title ?? job.text), 100), categoryId: String(o.categoryId ?? "22"), privacy: o.privacy ?? "private", madeForKids: false, isAiGenerated: ai } };
    case "twitter":
      return { twitter: { isAiGenerated: ai, ...(job.thread.length ? { thread: [job.text, ...job.thread].map((text) => ({ text })) } : {}) } };
    case "pinterest":
      return { pinterest: { boardServiceId: String(o.boardId ?? ""), title: titleOf(String(o.title ?? job.text), 100), ...(job.link ? { url: job.link } : {}) } };
    case "facebook":
      return { facebook: { type: o.type ?? "post" } };
    default:
      return undefined;
  }
}

export const bufferConnector: Connector = {
  id: "buffer",
  counter: "codepoints",
  labels: TEXT_LABEL,
  labelsFor: nativeFor(["instagram", "tiktok", "youtube", "twitter", "x"], "Buffer isAiGenerated"),
  info: info({
    id: "buffer",
    name: "Buffer",
    tier: "service",
    auth: "service",
    caps: caps({ text: true, image: true, video: true, thread: true }),
    limits: { maxChars: 2200, maxImages: 10, perDay: 10 },
    costHint: "Buffer's own plans; the API key works on the Free plan (250 requests/day).",
    setup:
      "In Buffer connect your channels (Instagram, Facebook, TikTok, Pinterest, LinkedIn pages, Threads…), then create a personal API key at publish.buffer.com/settings/api and store it under the key \"buffer\" (or pass params.apiKey). Buffer has no upload endpoint: media must be public https links, so local files go through the Claudia media relay (set mediaRelay), and permanent links are safer.",
    docs: "https://developers.buffer.com",
    keyNames: ["buffer"],
    reaches: ["instagram", "facebook", "threads", "tiktok", "pinterest", "linkedin", "youtube", "x", "mastodon", "bluesky", "google business"],
  }),
  check(account, job) {
    if (account?.platform === "pinterest" && !job.options.boardId) return "Buffer → Pinterest needs options.buffer.boardId (the board's serviceId).";
    return needsMedia(account?.platform ?? "", job);
  },
  warnings(account, job) {
    const w: string[] = [];
    if (job.media.some((m) => !/^https?:/.test(m.path))) w.push("Buffer fetches media from links; local files get a short-lived relay link. A permanent https URL is more reliable.");
    return w;
  },
  async connectKey(ctx, params, keys) {
    const apiKey = need(params.apiKey ?? (await keys.get("buffer")), "Buffer API key", "Create one at publish.buffer.com/settings/api.");
    const c: ConnCtx = { ...ctx, creds: { apiKey } };
    const orgs = await gql(c, "query { account { id email organizations { id name } } }", {}, "organizations", {
      account: { id: "acc_dry", email: "you@example.com", organizations: [{ id: "org_dry", name: "My Organization" }] },
    });
    const parentId = `buffer:${orgs.account.id}`;
    const out: Connected[] = [{ account: { id: parentId, network: "buffer", handle: orgs.account.email ?? "Buffer", name: "Buffer" }, credentials: { apiKey } }];
    for (const org of orgs.account.organizations ?? []) {
      const ch = await gql(
        c,
        "query Channels($input: ChannelsInput!) { channels(input: $input) { id name displayName service avatar isQueuePaused } }",
        { input: { organizationId: org.id } },
        `channels of ${org.name}`,
        { channels: [{ id: "ch_ig_dry", name: "claudia", displayName: "Claudia", service: "instagram", avatar: "" }, { id: "ch_tt_dry", name: "claudia", displayName: "Claudia", service: "tiktok", avatar: "" }] },
      );
      for (const x of ch.channels ?? []) out.push(child("buffer", parentId, x.service, x.id, `@${x.name}`, x.displayName, x.avatar));
    }
    out[0]!.account.notes = [`${out.length - 1} channels`];
    return out;
  },
  async publish(ctx, job) {
    if (!ctx.creds.channelId) throw new ClaudiaSocialError("invalid", "Post to one of the Buffer channels, not the Buffer connection itself.", { network: "buffer" });
    const assets = [];
    for (const m of job.media) {
      const url = await ctx.media.publicUrl(m, { ttlMin: 60 });
      assets.push(/video|\.mp4|\.mov/i.test(m.mime ?? m.path) ? { video: { url } } : { image: { url, metadata: { altText: m.alt ?? "" } } });
    }
    const metadata = bufferMetadata(ctx.creds.platform === "x" ? "twitter" : ctx.creds.platform, job);
    const data = await gql(
      ctx,
      BUFFER_CREATE,
      { input: { text: job.text, channelId: ctx.creds.channelId, schedulingType: "automatic", mode: "shareNow", assets, aiAssisted: job.flags.ai, ...(metadata ? { metadata } : {}) } },
      "createPost (shareNow)",
      { createPost: { __typename: "PostActionSuccess", post: { id: "post_dry", status: "sending", externalLink: null } } },
    );
    const r = data.createPost;
    if (!r?.post) throw new ClaudiaSocialError("provider_error", `Buffer: ${r?.message ?? r?.__typename ?? "no post returned"}`, { network: "buffer" });
    return { remoteId: r.post.id, url: r.post.externalLink ?? undefined };
  },
};

// ======================================================================== Zernio

const ZERNIO = "https://zernio.com/api/v1";

function zernioSpecific(platform: string, job: PublishJob): Record<string, unknown> | undefined {
  const o = job.options;
  switch (platform) {
    case "tiktok":
      return {
        privacy_level: o.privacyLevel ?? "SELF_ONLY",
        allow_comment: !!o.allowComment,
        allow_duet: !!o.allowDuet,
        allow_stitch: !!o.allowStitch,
        // a person reviewed the preview and approved the post in Claudia
        content_preview_confirmed: true,
        express_consent_given: true,
        video_made_with_ai: job.flags.ai,
        commercialContentType: job.flags.ad ? "brand_organic" : "none",
      };
    case "instagram":
      return { isAiGenerated: job.flags.ai, ...(o.contentType ? { contentType: o.contentType } : {}) };
    case "youtube":
      return { title: titleOf(String(o.title ?? job.text), 100), visibility: o.visibility ?? "private", madeForKids: false, containsSyntheticMedia: job.flags.ai };
    case "pinterest":
      return { boardId: o.boardId, title: titleOf(String(o.title ?? job.text), 100), ...(job.link ? { link: job.link } : {}) };
    case "facebook":
      return o.pageId ? { pageId: o.pageId } : undefined;
    case "twitter":
      return job.thread.length ? { threadItems: [job.text, ...job.thread].map((content) => ({ content })) } : undefined;
    default:
      return undefined;
  }
}

export const zernioConnector: Connector = {
  id: "zernio",
  counter: "codepoints",
  idempotent: true,
  labels: TEXT_LABEL,
  labelsFor: nativeFor(["tiktok", "instagram", "youtube"], "Zernio AI flag"),
  info: info({
    id: "zernio",
    name: "Zernio",
    tier: "service",
    auth: "service",
    caps: caps({ text: true, image: true, video: true, thread: true }),
    limits: { maxChars: 2200, maxImages: 10, perDay: 10 },
    costHint: "Zernio bills per connected account (1–2 accounts at no charge, then from $6/account/month); API on every tier.",
    setup:
      "Connect your accounts in Zernio (zernio.com, formerly Late), create an API key at zernio.com/dashboard/api-keys and store it under the key \"zernio\" (or params.apiKey). Media is uploaded to Zernio's own storage (presigned upload), so no relay is needed.",
    docs: "https://docs.zernio.com",
    keyNames: ["zernio"],
    reaches: ["instagram", "facebook", "threads", "tiktok", "pinterest", "linkedin", "youtube", "x", "bluesky", "reddit", "google business", "telegram", "snapchat"],
  }),
  check(account, job) {
    if (account?.platform === "pinterest" && !job.options.boardId) return "Zernio → Pinterest needs options.zernio.boardId.";
    return needsMedia(account?.platform ?? "", job);
  },
  async connectKey(ctx, params, keys) {
    const apiKey = need(params.apiKey ?? (await keys.get("zernio")), "Zernio API key", "Create one at zernio.com/dashboard/api-keys.");
    const res = await ctx.http.request({
      method: "GET",
      url: `${ZERNIO}/accounts`,
      headers: bearer(apiKey),
      secrets: [apiKey],
      network: "zernio",
      label: "accounts",
      mock: { accounts: [{ _id: "65f0dryrun0000000000tt01", platform: "tiktok", username: "claudia", displayName: "Claudia", isActive: true }, { _id: "65f0dryrun0000000000ig01", platform: "instagram", username: "claudia", displayName: "Claudia", isActive: true }] },
    });
    const parentId = `zernio:${apiKey.slice(-6)}`;
    const list = (res.json.accounts ?? []).filter((a: any) => a.isActive !== false);
    return [
      { account: { id: parentId, network: "zernio", handle: "Zernio", name: "Zernio", notes: [`${list.length} accounts`] }, credentials: { apiKey } },
      ...list.map((a: any) => child("zernio", parentId, a.platform, a._id, `@${a.username}`, a.displayName, a.profilePicture, { needsReconnection: a.needsReconnection })),
    ];
  },
  async publish(ctx, job) {
    if (!ctx.creds.channelId) throw new ClaudiaSocialError("invalid", "Post to one of the Zernio accounts, not the Zernio connection itself.", { network: "zernio" });
    const mediaItems = [];
    for (const [i, m] of job.media.entries()) {
      let url = m.path;
      const f = await ctx.media.load(m);
      if (!/^https?:/.test(m.path)) {
        const pre = await ctx.http.request({
          method: "POST",
          url: `${ZERNIO}/media/presign`,
          headers: bearer(ctx.creds.apiKey),
          json: { filename: f.filename, contentType: f.mime, size: f.size },
          secrets: [ctx.creds.apiKey],
          network: "zernio",
          label: `media ${i + 1}: presign`,
          mock: { uploadUrl: "https://storage.zernio.com/presigned/dryrun", publicUrl: `https://media.zernio.com/dryrun/${f.filename}` },
        });
        await ctx.http.request({ method: "PUT", url: pre.json.uploadUrl, raw: { bytes: f.bytes, mime: f.mime }, network: "zernio", label: `media ${i + 1}: upload`, timeoutMs: 30 * 60_000 });
        url = pre.json.publicUrl;
      }
      mediaItems.push({ type: f.kind === "video" ? "video" : f.mime === "image/gif" ? "gif" : "image", url, ...(m.alt ? { altText: m.alt } : {}) });
    }
    const platform = ctx.creds.platform === "x" ? "twitter" : ctx.creds.platform;
    const specific = zernioSpecific(platform, job);
    const res = await ctx.http.request({
      method: "POST",
      url: `${ZERNIO}/posts`,
      headers: { ...bearer(ctx.creds.apiKey), "Idempotency-Key": job.key },
      json: {
        content: job.text,
        ...(mediaItems.length ? { mediaItems } : {}),
        platforms: [{ platform, accountId: ctx.creds.channelId, ...(specific ? { platformSpecificData: specific } : {}) }],
        publishNow: true,
      },
      secrets: [ctx.creds.apiKey],
      network: "zernio",
      label: "create post (publishNow)",
      ok: (s) => (s >= 200 && s < 300) || s === 207,
      mockStatus: 201,
      mock: { post: { _id: "post_dryrun", status: "publishing", platforms: [{ platform, status: "publishing", platformPostUrl: null }] } },
    });
    const post = res.json.post;
    const pr = post?.platforms?.[0];
    if (pr?.status === "failed") throw new ClaudiaSocialError("provider_error", `Zernio → ${platform}: ${pr.errorMessage ?? "failed"}`, { network: "zernio" });
    return { remoteId: pr?.platformPostId ?? post?._id, url: pr?.platformPostUrl ?? undefined };
  },
};

// ======================================================================== Upload-Post

const UPLOAD_POST = "https://api.upload-post.com/api";

function upFields(platform: string, job: PublishJob, kind: "video" | "photo" | "text"): [string, string][] {
  const o = job.options;
  const f: [string, string][] = [];
  const b = (x: unknown) => (x ? "true" : "false");
  switch (platform) {
    case "tiktok":
      if (o.privacyLevel) f.push(["privacy_level", String(o.privacyLevel)]);
      f.push(["disable_comment", b(!o.allowComment)], ["disable_duet", b(!o.allowDuet)], ["disable_stitch", b(!o.allowStitch)], ["is_aigc", b(job.flags.ai)]);
      f.push(["brand_content_toggle", b(job.flags.ad)], ["brand_organic_toggle", b(o.ownBrand)]);
      break;
    case "instagram":
      f.push(["is_ai_generated", b(job.flags.ai)]);
      if (kind === "video") f.push(["media_type", String(o.mediaType ?? "REELS")]);
      break;
    case "youtube":
      f.push(["privacyStatus", String(o.privacyStatus ?? "private")], ["containsSyntheticMedia", b(job.flags.ai)], ["selfDeclaredMadeForKids", "false"]);
      break;
    case "facebook":
      if (o.pageId) f.push(["facebook_page_id", String(o.pageId)]);
      f.push(["facebook_is_ai_generated", b(job.flags.ai)]);
      break;
    case "pinterest":
      if (o.boardId) f.push(["pinterest_board_id", String(o.boardId)]);
      if (job.link) f.push(["pinterest_link", job.link]);
      break;
    case "x":
      f.push(["made_with_ai", b(job.flags.ai)]);
      break;
    case "linkedin":
      if (o.pageId) f.push(["target_linkedin_page_id", String(o.pageId)]);
      break;
  }
  return f;
}

export const uploadPostConnector: Connector = {
  id: "upload-post",
  counter: "codepoints",
  idempotent: true,
  labels: TEXT_LABEL,
  labelsFor: nativeFor(["tiktok", "instagram", "facebook", "x", "youtube"], "Upload-Post AI flag"),
  info: info({
    id: "upload-post",
    name: "Upload-Post",
    tier: "service",
    auth: "service",
    caps: caps({ text: true, image: true, video: true }),
    limits: { maxChars: 2200, maxImages: 10, perDay: 10 },
    costHint: "Upload-Post plans (Free: 10 uploads/month, no TikTok; paid from $16/month annual).",
    setup:
      "Create a profile in Upload-Post (upload-post.com), connect your social accounts to it, then copy the API key from the dashboard into the key \"upload-post\" (or params.apiKey). Facebook needs options[\"upload-post\"].pageId and Pinterest options[\"upload-post\"].boardId. Files are sent directly (multipart), no relay needed.",
    docs: "https://docs.upload-post.com",
    keyNames: ["upload-post"],
    reaches: ["tiktok", "instagram", "youtube", "linkedin", "facebook", "x", "threads", "pinterest", "bluesky", "reddit"],
  }),
  check(account, job) {
    if (account?.platform === "facebook" && !job.options.pageId) return "Upload-Post → Facebook needs options[\"upload-post\"].pageId.";
    if (account?.platform === "pinterest" && !job.options.boardId) return "Upload-Post → Pinterest needs options[\"upload-post\"].boardId.";
    return needsMedia(account?.platform ?? "", job);
  },
  warnings(account, job) {
    return account?.platform === "x" && (job.link || /https?:\/\//.test(job.text)) ? ["Upload-Post strips links from X posts unless you have their link add-on."] : [];
  },
  async connectKey(ctx, params, keys) {
    const apiKey = need(params.apiKey ?? (await keys.get("upload-post")), "Upload-Post API key", "Copy it from the Upload-Post dashboard.");
    const res = await ctx.http.request({
      method: "GET",
      url: `${UPLOAD_POST}/uploadposts/users`,
      headers: { Authorization: `Apikey ${apiKey}` },
      secrets: [apiKey],
      network: "upload-post",
      label: "profiles",
      mock: { success: true, profiles: [{ username: "claudia", social_accounts: { tiktok: { username: "open_id_dry", handle: "claudia", display_name: "Claudia" }, instagram: { username: "17841400000000000", handle: "claudia", display_name: "Claudia" } } }] },
    });
    const parentId = `upload-post:${apiKey.slice(-6)}`;
    const out: Connected[] = [{ account: { id: parentId, network: "upload-post", handle: "Upload-Post", name: "Upload-Post" }, credentials: { apiKey } }];
    for (const p of res.json.profiles ?? []) {
      for (const [platform, a] of Object.entries<any>(p.social_accounts ?? {})) {
        if (!a || typeof a !== "object") continue;
        out.push(child("upload-post", parentId, platform, `${p.username}:${a.username ?? platform}`, `@${a.handle ?? a.username}`, a.display_name, undefined, { user: p.username }));
      }
    }
    out[0]!.account.notes = [`${out.length - 1} accounts`];
    return out;
  },
  async publish(ctx, job) {
    if (!ctx.creds.user) throw new ClaudiaSocialError("invalid", "Post to one of the Upload-Post accounts, not the Upload-Post connection itself.", { network: "upload-post" });
    const platform = String(ctx.creds.platform);
    const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
    const video = files.find((f) => f.kind === "video");
    const kind: "video" | "photo" | "text" = video ? "video" : files.length ? "photo" : "text";
    const parts: MultipartPart[] = [
      { name: "user", value: String(ctx.creds.user) },
      { name: "platform[]", value: platform },
      { name: "title", value: kind === "text" ? job.text : titleOf(String(job.options.title ?? job.text), 100) },
    ];
    if (kind !== "text") parts.push({ name: "description", value: job.text });
    if (kind === "text" && job.link) parts.push({ name: "link_url", value: job.link });
    for (const [k, v] of upFields(platform, job, kind)) parts.push({ name: k, value: v });
    if (video) parts.push({ name: "video", file: { bytes: video.bytes, mime: video.mime, filename: video.filename } });
    else for (const f of files) parts.push({ name: "photos[]", file: { bytes: f.bytes, mime: f.mime, filename: f.filename } });
    const endpoint = kind === "video" ? "upload" : kind === "photo" ? "upload_photos" : "upload_text";
    const res = await ctx.http.request({
      method: "POST",
      url: `${UPLOAD_POST}/${endpoint}`,
      headers: { Authorization: `Apikey ${ctx.creds.apiKey}`, "Idempotency-Key": job.key },
      multipart: parts,
      secrets: [ctx.creds.apiKey],
      network: "upload-post",
      label: `${endpoint} → ${platform}`,
      timeoutMs: 30 * 60_000,
      mock: { success: true, results: { [platform]: { success: true, url: `https://${platform}.example/post/dryrun`, post_id: "dryrun" } } },
    });
    let result = res.json.results?.[platform];
    if (!result && res.json.request_id) {
      const rid = res.json.request_id as string;
      result = await poll(
        ctx,
        async () => {
          const st = await ctx.http.request({
            method: "GET",
            url: `${UPLOAD_POST}/uploadposts/status?${qs({ request_id: rid })}`,
            headers: { Authorization: `Apikey ${ctx.creds.apiKey}` },
            secrets: [ctx.creds.apiKey],
            network: "upload-post",
            label: "status",
          });
          if (!st.json.completed && !["completed", "failed"].includes(st.json.status)) return undefined;
          const r = (st.json.results ?? []).find((x: any) => x.platform === platform) ?? {};
          return { success: r.success, url: r.post_url, post_id: r.post_id ?? rid, error: r.message };
        },
        { what: "Upload-Post upload", everyMs: 8000, tries: 75 },
      );
    }
    if (!result?.success) throw new ClaudiaSocialError("provider_error", `Upload-Post → ${platform}: ${result?.error ?? result?.message ?? "failed"}`, { network: "upload-post" });
    return { remoteId: String(result.post_id ?? result.video_id ?? result.publish_id ?? res.json.request_id ?? ""), url: result.url };
  },
};
