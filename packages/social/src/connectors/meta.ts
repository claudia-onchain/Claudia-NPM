// v2 direct Meta connectors, each with the user's own Meta app (Business type). Meta portals want https redirect URIs,
// so these default to the Claudia relay (https://useclaudia.xyz/relay/oauth/callback), which bounces to 127.0.0.1.
// Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//            https://developers.facebook.com/docs/instagram-platform/content-publishing
// Facebook:  https://developers.facebook.com/docs/pages-api/posts · https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
// Threads:   https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions · https://developers.facebook.com/docs/threads/posts
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import type { ConnCtx, Connected, Connector, PublishJob } from "./base.js";
import { caps, chain, info, poll, isVideo } from "./common.js";

export const GRAPH_VERSION = "v25.0";
const IG = `https://graph.instagram.com/${GRAPH_VERSION}`;
const FB = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TH = "https://graph.threads.net/v1.0";
const WEEK = 7 * 24 * 3600_000;

function defined(o: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));
}

function v2Setup(what: string): string {
  return `${what} Register https://useclaudia.xyz/relay/oauth/callback as the redirect URI (Meta requires https; the relay sends the code straight back to http://127.0.0.1:<port>/oauth/callback on your machine and stores nothing). Your app stays in Standard Access: it can post to accounts that have a role on the app (yours). Media must be on a public URL, so set mediaRelay (Claudia's short-lived links, deleted after publish).`;
}

// ======================================================================== Instagram

async function igContainer(ctx: ConnCtx, fields: Record<string, string | undefined>, label: string): Promise<string> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${IG}/${ctx.creds.userId}/media`,
    form: { ...defined(fields), access_token: ctx.creds.accessToken },
    secrets: [ctx.creds.accessToken],
    network: "instagram",
    label,
    mock: { id: `1789000000000000${Math.floor(Math.random() * 100)}` },
  });
  return res.json.id;
}

async function igWait(ctx: ConnCtx, id: string): Promise<void> {
  await poll(
    ctx,
    async () => {
      const st = await ctx.http.request({
        method: "GET",
        url: `${IG}/${id}?${qs({ fields: "status_code", access_token: ctx.creds.accessToken })}`,
        secrets: [ctx.creds.accessToken],
        network: "instagram",
        label: "container status",
        mock: { status_code: "FINISHED" },
      });
      const s = st.json.status_code;
      if (s === "ERROR" || s === "EXPIRED") throw new ClaudiaSocialError("provider_error", `Instagram could not process the media (${s}).`, { network: "instagram" });
      return s === "FINISHED" ? true : undefined;
    },
    { what: "Instagram media", everyMs: 5000, tries: 60 },
  );
}

export const instagramConnector: Connector = {
  id: "instagram",
  counter: "codepoints",
  refreshEarlyMs: WEEK,
  labels: { ai: "native", aiName: "Instagram is_ai_generated" },
  info: info({
    id: "instagram",
    name: "Instagram",
    tier: "v2",
    auth: "oauth-relay",
    caps: caps({ image: true, video: true, text: true }),
    limits: { maxChars: 2200, maxImages: 10, maxVideoMb: 300, perDay: 20 },
    setup: v2Setup(
      "Needs an Instagram professional account (Business or Creator). At developers.facebook.com create an app (type Business), add the use case \"Manage messaging & content on Instagram\" (Instagram API with Instagram Login), and copy the Instagram App ID + Instagram App Secret into the key \"instagram\".",
    ),
    docs: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    keyNames: ["instagram"],
  }),
  check(_a, job) {
    if (!job.media.length) return "Instagram posts need an image or a video.";
    return undefined;
  },
  warnings(_a, job) {
    return job.media.some((m) => /\.png$|image\/png|\.webp$|image\/webp/i.test(m.mime ?? m.path)) ? ["Instagram's API takes JPEG images only; convert PNG/WebP first."] : [];
  },
  oauth: {
    redirect: "relay",
    keyName: "instagram",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    needsSecret: true,
    authorizeUrl(p) {
      return `https://www.instagram.com/oauth/authorize?${qs({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: p.scopes.join(","), state: p.state })}`;
    },
    async exchange(ctx, p): Promise<Connected> {
      const short = (
        await ctx.http.request({
          method: "POST",
          url: "https://api.instagram.com/oauth/access_token",
          form: { client_id: p.clientId, client_secret: p.clientSecret ?? "", grant_type: "authorization_code", redirect_uri: p.redirectUri, code: p.code },
          secrets: [p.clientSecret, p.code],
          network: "instagram",
          label: "token exchange (short-lived)",
          mock: { access_token: "IGshort", user_id: "17841400000000000" },
        })
      ).json;
      const long = (
        await ctx.http.request({
          method: "GET",
          url: `https://graph.instagram.com/access_token?${qs({ grant_type: "ig_exchange_token", client_secret: p.clientSecret, access_token: short.access_token })}`,
          secrets: [p.clientSecret, short.access_token],
          network: "instagram",
          label: "long-lived token (60 days)",
          mock: { access_token: "IGlong", token_type: "bearer", expires_in: 5184000 },
        })
      ).json;
      const me = (
        await ctx.http.request({
          method: "GET",
          url: `${IG}/me?${qs({ fields: "user_id,username,name,profile_picture_url", access_token: long.access_token })}`,
          secrets: [long.access_token],
          network: "instagram",
          label: "who am I",
          mock: { user_id: "17841400000000000", username: "claudia", name: "Claudia" },
        })
      ).json;
      const expiresAt = Date.now() + Number(long.expires_in ?? 5184000) * 1000;
      return {
        account: { id: `instagram:${me.user_id}`, network: "instagram", handle: `@${me.username}`, name: me.name, avatar: me.profile_picture_url, expiresAt },
        credentials: { accessToken: long.access_token, expiresAt, userId: me.user_id, username: me.username, refreshable: true },
      };
    },
  },
  async refresh(ctx) {
    const res = await ctx.http.request({
      method: "GET",
      url: `https://graph.instagram.com/refresh_access_token?${qs({ grant_type: "ig_refresh_token", access_token: ctx.creds.accessToken })}`,
      secrets: [ctx.creds.accessToken],
      network: "instagram",
      label: "refresh long-lived token",
    });
    return { accessToken: res.json.access_token, expiresAt: Date.now() + Number(res.json.expires_in ?? 5184000) * 1000 };
  },
  async publish(ctx, job) {
    const ai = job.flags.ai ? { is_ai_generated: "true" } : {};
    let creation: string;
    if (job.media.length === 1) {
      const m = job.media[0]!;
      const url = await ctx.media.publicUrl(m);
      const video = ctx.media.kind(m) === "video";
      creation = await igContainer(
        ctx,
        video
          ? { media_type: "REELS", video_url: url, caption: job.text, share_to_feed: "true", ...ai }
          : { image_url: url, caption: job.text, ...(m.alt ? { alt_text: m.alt.slice(0, 1000) } : {}), ...ai },
        video ? "reel container" : "image container",
      );
      if (video) await igWait(ctx, creation);
    } else {
      const children: string[] = [];
      for (const [i, m] of job.media.slice(0, 10).entries()) {
        const url = await ctx.media.publicUrl(m);
        const video = ctx.media.kind(m) === "video";
        const id = await igContainer(
          ctx,
          video ? { media_type: "VIDEO", video_url: url, is_carousel_item: "true" } : { image_url: url, is_carousel_item: "true", ...(m.alt ? { alt_text: m.alt.slice(0, 1000) } : {}) },
          `carousel item ${i + 1}`,
        );
        if (video) await igWait(ctx, id);
        children.push(id);
      }
      creation = await igContainer(ctx, { media_type: "CAROUSEL", children: children.join(","), caption: job.text, ...ai }, "carousel container");
      await igWait(ctx, creation);
    }
    const pub = await ctx.http.request({
      method: "POST",
      url: `${IG}/${ctx.creds.userId}/media_publish`,
      form: { creation_id: creation, access_token: ctx.creds.accessToken },
      secrets: [ctx.creds.accessToken],
      network: "instagram",
      label: "publish",
      mock: { id: "17900000000000001" },
    });
    const id = pub.json.id as string;
    const link = await ctx.http
      .request({ method: "GET", url: `${IG}/${id}?${qs({ fields: "permalink", access_token: ctx.creds.accessToken })}`, secrets: [ctx.creds.accessToken], network: "instagram", label: "permalink", mock: { permalink: "https://www.instagram.com/p/DRYRUN/" } })
      .then((r) => r.json.permalink as string)
      .catch(() => undefined);
    return { remoteId: id, url: link };
  },
};

// ======================================================================== Facebook Pages

export const facebookConnector: Connector = {
  id: "facebook",
  counter: "codepoints",
  labels: { ai: "text" },
  info: info({
    id: "facebook",
    name: "Facebook Page",
    tier: "v2",
    auth: "oauth-relay",
    caps: caps({ text: true, image: true, video: true }),
    limits: { maxChars: 63206, maxImages: 10, maxVideoMb: 1024, perDay: 10 },
    setup: v2Setup(
      "At developers.facebook.com create an app (type Business) with Facebook Login, request pages_show_list, pages_read_engagement and pages_manage_posts, and copy the App ID + App Secret into the key \"facebook\". Every Page you manage becomes its own Claudia account.",
    ),
    docs: "https://developers.facebook.com/docs/pages-api/posts",
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    keyNames: ["facebook"],
  }),
  oauth: {
    redirect: "relay",
    keyName: "facebook",
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    needsSecret: true,
    authorizeUrl(p) {
      // apps using "Facebook Login for Business" pass config_id instead of scope
      return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${qs({
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        state: p.state,
        response_type: "code",
        ...(p.params.configId ? { config_id: p.params.configId } : { scope: p.scopes.join(",") }),
      })}`;
    },
    async exchange(ctx, p): Promise<Connected[]> {
      const short = (
        await ctx.http.request({
          method: "GET",
          url: `${FB}/oauth/access_token?${qs({ client_id: p.clientId, redirect_uri: p.redirectUri, client_secret: p.clientSecret, code: p.code })}`,
          secrets: [p.clientSecret, p.code],
          network: "facebook",
          label: "token exchange",
          mock: { access_token: "EAAshort", expires_in: 3600 },
        })
      ).json;
      const long = (
        await ctx.http.request({
          method: "GET",
          url: `${FB}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: p.clientId, client_secret: p.clientSecret, fb_exchange_token: short.access_token })}`,
          secrets: [p.clientSecret, short.access_token],
          network: "facebook",
          label: "long-lived user token",
          mock: { access_token: "EAAlong", expires_in: 5184000 },
        })
      ).json;
      const pages = (
        await ctx.http.request({
          method: "GET",
          url: `${FB}/me/accounts?${qs({ fields: "id,name,access_token,tasks", access_token: long.access_token })}`,
          secrets: [long.access_token],
          network: "facebook",
          label: "pages",
          mock: { data: [{ id: "100000000000001", name: "Claudia", access_token: "EAApage", tasks: ["CREATE_CONTENT"] }] },
        })
      ).json.data as any[];
      if (!pages?.length) throw new ClaudiaSocialError("invalid", "No Facebook Pages came back.", { network: "facebook", hint: "Pick at least one Page in the login dialog, and make sure you can create content on it." });
      // page tokens made from a long-lived user token don't expire
      return pages.map((pg) => ({
        account: { id: `facebook:${pg.id}`, network: "facebook" as const, handle: pg.name, name: pg.name },
        credentials: { accessToken: pg.access_token, pageId: pg.id },
      }));
    },
  },
  async publish(ctx, job) {
    const token = ctx.creds.accessToken as string;
    const page = ctx.creds.pageId as string;
    const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
    const video = files.find((f) => isVideo(f.mime));
    if (video) {
      const res = await ctx.http.request({
        method: "POST",
        url: `https://graph-video.facebook.com/${GRAPH_VERSION}/${page}/videos`,
        multipart: [
          { name: "access_token", value: token },
          { name: "description", value: job.text },
          { name: "source", file: { bytes: video.bytes, mime: video.mime, filename: video.filename } },
        ],
        secrets: [token],
        network: "facebook",
        label: "video",
        timeoutMs: 30 * 60_000,
        mock: { id: "200000000000001" },
      });
      return { remoteId: res.json.id, url: `https://www.facebook.com/${page}/videos/${res.json.id}` };
    }
    if (files.length === 1) {
      const f = files[0]!;
      const res = await ctx.http.request({
        method: "POST",
        url: `${FB}/${page}/photos`,
        multipart: [
          { name: "access_token", value: token },
          { name: "caption", value: job.text },
          ...(f.alt ? [{ name: "alt_text_custom", value: f.alt }] : []),
          { name: "source", file: { bytes: f.bytes, mime: f.mime, filename: f.filename } },
        ],
        secrets: [token],
        network: "facebook",
        label: "photo",
        mock: { id: "300000000000001", post_id: `${page}_300000000000001` },
      });
      return { remoteId: res.json.post_id ?? res.json.id, url: `https://www.facebook.com/${res.json.post_id ?? res.json.id}` };
    }
    const attached: { media_fbid: string }[] = [];
    for (const [i, f] of files.entries()) {
      const res = await ctx.http.request({
        method: "POST",
        url: `${FB}/${page}/photos`,
        multipart: [
          { name: "access_token", value: token },
          { name: "published", value: "false" },
          { name: "source", file: { bytes: f.bytes, mime: f.mime, filename: f.filename } },
        ],
        secrets: [token],
        network: "facebook",
        label: `photo ${i + 1} (unpublished)`,
        mock: { id: `30000000000000${i}` },
      });
      attached.push({ media_fbid: res.json.id });
    }
    const res = await ctx.http.request({
      method: "POST",
      url: `${FB}/${page}/feed`,
      json: { message: job.text, ...(job.link && !attached.length ? { link: job.link } : {}), ...(attached.length ? { attached_media: attached } : {}), access_token: token },
      secrets: [token],
      network: "facebook",
      label: "feed post",
      mock: { id: `${page}_400000000000001` },
    });
    return { remoteId: res.json.id, url: `https://www.facebook.com/${res.json.id}` };
  },
};

// ======================================================================== Threads

async function thContainer(ctx: ConnCtx, fields: Record<string, string | undefined>, label: string): Promise<string> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${TH}/${ctx.creds.userId}/threads`,
    form: { ...defined(fields), access_token: ctx.creds.accessToken },
    secrets: [ctx.creds.accessToken],
    network: "threads",
    label,
    mock: { id: `1800000000000000${Math.floor(Math.random() * 100)}` },
  });
  return res.json.id;
}

async function thPublish(ctx: ConnCtx, creation: string, wait: boolean, label: string): Promise<string> {
  if (wait) {
    await poll(
      ctx,
      async () => {
        const st = await ctx.http.request({
          method: "GET",
          url: `${TH}/${creation}?${qs({ fields: "status,error_message", access_token: ctx.creds.accessToken })}`,
          secrets: [ctx.creds.accessToken],
          network: "threads",
          label: "container status",
          mock: { status: "FINISHED" },
        });
        if (st.json.status === "ERROR" || st.json.status === "EXPIRED") throw new ClaudiaSocialError("provider_error", `Threads: ${st.json.error_message ?? st.json.status}`, { network: "threads" });
        return st.json.status === "FINISHED" ? true : undefined;
      },
      { what: "Threads media", everyMs: 15000, tries: 20 },
    );
  }
  const res = await ctx.http.request({
    method: "POST",
    url: `${TH}/${ctx.creds.userId}/threads_publish`,
    form: { creation_id: creation, access_token: ctx.creds.accessToken },
    secrets: [ctx.creds.accessToken],
    network: "threads",
    label,
    mock: { id: `1810000000000000${Math.floor(Math.random() * 100)}` },
  });
  return res.json.id;
}

export const threadsConnector: Connector = {
  id: "threads",
  counter: "codepoints",
  refreshEarlyMs: WEEK,
  labels: { ai: "text" },
  info: info({
    id: "threads",
    name: "Threads",
    tier: "v2",
    auth: "oauth-relay",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true }),
    limits: { maxChars: 500, maxImages: 20, maxVideoMb: 1024, perDay: 25 },
    setup: v2Setup("At developers.facebook.com create an app with the \"Access the Threads API\" use case and copy the Threads App ID + Threads App Secret into the key \"threads\"."),
    docs: "https://developers.facebook.com/docs/threads/posts",
    scopes: ["threads_basic", "threads_content_publish"],
    keyNames: ["threads"],
  }),
  oauth: {
    redirect: "relay",
    keyName: "threads",
    scopes: ["threads_basic", "threads_content_publish"],
    needsSecret: true,
    authorizeUrl(p) {
      return `https://threads.net/oauth/authorize?${qs({ client_id: p.clientId, redirect_uri: p.redirectUri, scope: p.scopes.join(","), response_type: "code", state: p.state })}`;
    },
    async exchange(ctx, p) {
      const short = (
        await ctx.http.request({
          method: "POST",
          url: "https://graph.threads.net/oauth/access_token",
          form: { client_id: p.clientId, client_secret: p.clientSecret ?? "", code: p.code, grant_type: "authorization_code", redirect_uri: p.redirectUri },
          secrets: [p.clientSecret, p.code],
          network: "threads",
          label: "token exchange (short-lived)",
          mock: { access_token: "THshort", user_id: "26000000000000000" },
        })
      ).json;
      const long = (
        await ctx.http.request({
          method: "GET",
          url: `https://graph.threads.net/access_token?${qs({ grant_type: "th_exchange_token", client_secret: p.clientSecret, access_token: short.access_token })}`,
          secrets: [p.clientSecret, short.access_token],
          network: "threads",
          label: "long-lived token (60 days)",
          mock: { access_token: "THlong", expires_in: 5184000 },
        })
      ).json;
      const me = (
        await ctx.http.request({
          method: "GET",
          url: `${TH}/me?${qs({ fields: "id,username,name,threads_profile_picture_url", access_token: long.access_token })}`,
          secrets: [long.access_token],
          network: "threads",
          label: "who am I",
          mock: { id: "26000000000000000", username: "claudia" },
        })
      ).json;
      const expiresAt = Date.now() + Number(long.expires_in ?? 5184000) * 1000;
      return {
        account: { id: `threads:${me.id}`, network: "threads", handle: `@${me.username}`, name: me.name, avatar: me.threads_profile_picture_url, expiresAt },
        credentials: { accessToken: long.access_token, expiresAt, userId: me.id, username: me.username, refreshable: true },
      };
    },
  },
  async refresh(ctx) {
    const res = await ctx.http.request({
      method: "GET",
      url: `https://graph.threads.net/refresh_access_token?${qs({ grant_type: "th_refresh_token", access_token: ctx.creds.accessToken })}`,
      secrets: [ctx.creds.accessToken],
      network: "threads",
      label: "refresh long-lived token",
    });
    return { accessToken: res.json.access_token, expiresAt: Date.now() + Number(res.json.expires_in ?? 5184000) * 1000 };
  },
  async publish(ctx, job: PublishJob) {
    const ids = await chain(job, async (text, replyTo, i) => {
      const reply = replyTo ? { reply_to_id: replyTo } : {};
      if (i > 0 || !job.media.length) {
        const c = await thContainer(ctx, { media_type: "TEXT", text, ...reply, ...(i === 0 && job.link ? { link_attachment: job.link } : {}) }, i === 0 ? "text container" : `thread part ${i + 1} container`);
        return thPublish(ctx, c, false, i === 0 ? "publish" : `publish part ${i + 1}`);
      }
      if (job.media.length === 1) {
        const m = job.media[0]!;
        const url = await ctx.media.publicUrl(m);
        const video = ctx.media.kind(m) === "video";
        const c = await thContainer(ctx, { media_type: video ? "VIDEO" : "IMAGE", [video ? "video_url" : "image_url"]: url, text, ...(m.alt ? { alt_text: m.alt } : {}), ...reply }, "media container");
        return thPublish(ctx, c, true, "publish");
      }
      const children: string[] = [];
      for (const [n, m] of job.media.slice(0, 20).entries()) {
        const url = await ctx.media.publicUrl(m);
        const video = ctx.media.kind(m) === "video";
        children.push(await thContainer(ctx, { media_type: video ? "VIDEO" : "IMAGE", [video ? "video_url" : "image_url"]: url, is_carousel_item: "true" }, `carousel item ${n + 1}`));
      }
      const c = await thContainer(ctx, { media_type: "CAROUSEL", children: children.join(","), text, ...reply }, "carousel container");
      return thPublish(ctx, c, true, "publish");
    });
    const link = await ctx.http
      .request({ method: "GET", url: `${TH}/${ids[0]}?${qs({ fields: "permalink", access_token: ctx.creds.accessToken })}`, secrets: [ctx.creds.accessToken], network: "threads", label: "permalink", mock: { permalink: "https://www.threads.com/@claudia/post/DRYRUN" } })
      .then((r) => r.json.permalink as string)
      .catch(() => undefined);
    return { remoteId: ids[0]!, remoteIds: ids, url: link };
  },
  async reply(ctx, to, text) {
    const c = await thContainer(ctx, { media_type: "TEXT", text, reply_to_id: to }, "reply container");
    const id = await thPublish(ctx, c, false, "publish reply");
    return { remoteId: id };
  },
};
