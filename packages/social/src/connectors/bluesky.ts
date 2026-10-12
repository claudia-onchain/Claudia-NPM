// Bluesky / AT Protocol with a handle + app password.
// Lexicons: https://github.com/bluesky-social/atproto/tree/main/lexicons (app.bsky.feed.post, com.atproto.repo.*)
// Guides:   https://docs.bsky.app/docs/advanced-guides/posts · https://docs.bsky.app/docs/tutorials/video
import { ClaudiaSocialError } from "../errors.js";
import { qs } from "../util.js";
import { need, type ConnCtx, type Connected, type Connector, type PublishJob } from "./base.js";
import { bearer, caps, hostname, info, jwtExpMs, poll } from "./common.js";

const ENTRYWAY = "https://bsky.social";
const VIDEO_SERVICE = "https://video.bsky.app";
const IMAGE_MAX = 2_000_000; // lexicon app.bsky.embed.images maxSize

interface StrongRef {
  uri: string;
  cid: string;
}

function pdsOf(session: any, fallback: string): string {
  const svc = (session.didDoc?.service ?? []).find((s: any) => String(s.id).endsWith("#atproto_pds") && s.type === "AtprotoPersonalDataServer");
  return (svc?.serviceEndpoint as string | undefined)?.replace(/\/$/, "") ?? fallback;
}

async function createSession(ctx: ConnCtx, service: string, identifier: string, password: string) {
  const res = await ctx.http.request({
    method: "POST",
    url: `${service}/xrpc/com.atproto.server.createSession`,
    json: { identifier, password },
    secrets: [password],
    network: "bluesky",
    label: "log in (app password)",
    mock: {
      did: "did:plc:claudiaexample123",
      handle: identifier.includes(".") ? identifier : "claudia.bsky.social",
      accessJwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig",
      refreshJwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.ref",
      didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://morel.us-east.host.bsky.network" }] },
    },
  });
  return res.json;
}

function sessionCreds(s: any, service: string, prev: Record<string, unknown> = {}) {
  return {
    ...prev,
    accessJwt: s.accessJwt,
    refreshJwt: s.refreshJwt,
    did: s.did,
    handle: s.handle,
    pds: pdsOf(s, String(prev.pds ?? service)),
    expiresAt: jwtExpMs(s.accessJwt) ?? Date.now() + 2 * 3600_000,
    refreshable: true,
  };
}

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).byteLength;

/** Rich-text facets: links, @mentions (resolved to DIDs) and #tags, with UTF-8 byte offsets. */
async function facetsFor(ctx: ConnCtx, text: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const at = (i: number) => byteLen(text.slice(0, i));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g)) {
    out.push({ index: { byteStart: at(m.index!), byteEnd: at(m.index! + m[0].length) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|[\s(])@(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,})/g)) {
    const handle = m[2]!;
    const start = m.index! + m[1]!.length;
    try {
      const r = await ctx.http.request({
        method: "GET",
        url: `${ctx.creds.pds ?? ENTRYWAY}/xrpc/com.atproto.identity.resolveHandle?${qs({ handle })}`,
        network: "bluesky",
        label: `resolve @${handle}`,
        mock: { did: "did:plc:mentioned000" },
      });
      out.push({ index: { byteStart: at(start), byteEnd: at(start + handle.length + 1) }, features: [{ $type: "app.bsky.richtext.facet#mention", did: r.json.did }] });
    } catch {
      /* unknown handle: leave as plain text */
    }
  }
  for (const m of text.matchAll(/(^|\s)#([^\s#.,;:!?()[\]{}"']{1,64})/gu)) {
    if (/^\d+$/.test(m[2]!)) continue;
    const start = m.index! + m[1]!.length;
    out.push({ index: { byteStart: at(start), byteEnd: at(start + m[2]!.length + 1) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[2] }] });
  }
  return out;
}

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
/** Deterministic record key (TID) per (post, account, part): a resend hits the same rkey instead of duplicating. */
export function stableTid(atMs: number, key: string, part: number): string {
  let n = ((BigInt(Math.floor(atMs)) * 1000n + BigInt(part)) << 10n) | BigInt(parseInt(key.slice(0, 3), 16) % 1024);
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = TID_CHARS[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

async function uploadBlob(ctx: ConnCtx, bytes: Uint8Array, mime: string, label: string) {
  const res = await ctx.http.request({
    method: "POST",
    url: `${ctx.creds.pds}/xrpc/com.atproto.repo.uploadBlob`,
    headers: bearer(ctx.creds.accessJwt),
    raw: { bytes, mime },
    secrets: [ctx.creds.accessJwt],
    network: "bluesky",
    label,
    timeoutMs: 5 * 60_000,
    mock: { blob: { $type: "blob", ref: { $link: "bafkreidryrun" }, mimeType: mime, size: bytes.byteLength } },
  });
  return res.json.blob;
}

async function uploadVideo(ctx: ConnCtx, f: { bytes: Uint8Array; mime: string; filename: string }) {
  const token = ctx.creds.accessJwt as string;
  const aud = `did:web:${hostname(ctx.creds.pds)}`;
  const sa = await ctx.http.request({
    method: "GET",
    url: `${ctx.creds.pds}/xrpc/com.atproto.server.getServiceAuth?${qs({ aud, lxm: "com.atproto.repo.uploadBlob", exp: Math.floor(Date.now() / 1000) + 1800 })}`,
    headers: bearer(token),
    secrets: [token],
    network: "bluesky",
    label: "video: service auth",
    mock: { token: "service-token" },
  });
  const svc = sa.json.token as string;
  const up = await ctx.http.request({
    method: "POST",
    url: `${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo?${qs({ did: ctx.creds.did, name: f.filename })}`,
    headers: bearer(svc),
    raw: { bytes: f.bytes, mime: "video/mp4" },
    secrets: [svc],
    network: "bluesky",
    label: "video: upload",
    timeoutMs: 15 * 60_000,
    // already_exists comes back as 409 with the job (and blob) inside
    ok: (s) => (s >= 200 && s < 300) || s === 409,
    mock: { jobId: "job-dryrun", state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: "bafkvideo" }, mimeType: "video/mp4", size: f.bytes.byteLength } },
  });
  const job = up.json.jobStatus ?? up.json;
  if (job.blob) return job.blob;
  return poll(
    ctx,
    async () => {
      const st = await ctx.http.request({
        method: "GET",
        url: `${VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus?${qs({ jobId: job.jobId })}`,
        headers: bearer(token),
        secrets: [token],
        network: "bluesky",
        label: "video: status",
        mock: { jobStatus: { state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: "bafkvideo" }, mimeType: "video/mp4" } } },
      });
      const js = st.json.jobStatus;
      if (js?.state === "JOB_STATE_FAILED") throw new ClaudiaSocialError("provider_error", `Bluesky video failed: ${js.error ?? js.message ?? "unknown"}`, { network: "bluesky" });
      return js?.blob ?? undefined;
    },
    { what: "Bluesky video", everyMs: 1500, tries: 200 },
  );
}

async function getRecord(ctx: ConnCtx, uri: string): Promise<{ uri: string; cid: string; value: any }> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m) throw new ClaudiaSocialError("invalid", `Not an at:// post uri: ${uri}`, { network: "bluesky", hint: "Use the uri from the inbox (at://did/app.bsky.feed.post/rkey)." });
  const res = await ctx.http.request({
    method: "GET",
    url: `${ctx.creds.pds}/xrpc/com.atproto.repo.getRecord?${qs({ repo: m[1], collection: m[2], rkey: m[3] })}`,
    headers: bearer(ctx.creds.accessJwt),
    secrets: [ctx.creds.accessJwt],
    network: "bluesky",
    label: "fetch parent post",
    mock: { uri, cid: "bafyparent", value: { text: "parent" } },
  });
  return res.json;
}

async function replyRefs(ctx: ConnCtx, parentUri: string): Promise<{ root: StrongRef; parent: StrongRef }> {
  const p = await getRecord(ctx, parentUri);
  const parent = { uri: p.uri, cid: p.cid };
  return { root: p.value?.reply?.root ?? parent, parent };
}

async function createPost(ctx: ConnCtx, record: Record<string, unknown>, rkey: string | undefined, label: string): Promise<StrongRef> {
  try {
    const res = await ctx.http.request({
      method: "POST",
      url: `${ctx.creds.pds}/xrpc/com.atproto.repo.createRecord`,
      headers: bearer(ctx.creds.accessJwt),
      json: { repo: ctx.creds.did, collection: "app.bsky.feed.post", ...(rkey ? { rkey } : {}), record },
      secrets: [ctx.creds.accessJwt],
      network: "bluesky",
      label,
      mock: { uri: `at://${ctx.creds.did}/app.bsky.feed.post/${rkey ?? "3kdryrun"}`, cid: `bafy${rkey ?? "dryrun"}` },
    });
    return { uri: res.json.uri, cid: res.json.cid };
  } catch (e) {
    // the same rkey already exists: an earlier attempt went through. Use it instead of posting again.
    if (rkey && e instanceof ClaudiaSocialError && /already exist|RecordAlreadyExists|conflict/i.test(e.message)) {
      const r = await getRecord(ctx, `at://${ctx.creds.did}/app.bsky.feed.post/${rkey}`);
      return { uri: r.uri, cid: r.cid };
    }
    throw e;
  }
}

function postUrl(ctx: ConnCtx, uri: string): string {
  return `https://bsky.app/profile/${ctx.creds.handle ?? ctx.creds.did}/post/${uri.split("/").pop()}`;
}

async function buildEmbed(ctx: ConnCtx, job: PublishJob): Promise<unknown | undefined> {
  if (job.media.length) {
    const files = await Promise.all(job.media.map((m) => ctx.media.load(m)));
    const video = files.find((f) => f.kind === "video");
    if (video) {
      const blob = await uploadVideo(ctx, video);
      return { $type: "app.bsky.embed.video", video: blob, ...(video.alt ? { alt: video.alt.slice(0, 1000) } : {}) };
    }
    const images = [];
    for (const [i, f] of files.slice(0, 4).entries()) {
      if (f.size > IMAGE_MAX) throw new ClaudiaSocialError("invalid", `${f.filename} is ${Math.round(f.size / 1000)} KB; Bluesky images must be under 2 MB.`, { network: "bluesky" });
      images.push({ alt: f.alt ?? "", image: await uploadBlob(ctx, f.bytes, f.mime, `image ${i + 1}`) });
    }
    return { $type: "app.bsky.embed.images", images };
  }
  if (job.link) {
    return {
      $type: "app.bsky.embed.external",
      external: { uri: job.link, title: String(job.options.linkTitle ?? hostname(job.link)), description: String(job.options.linkDescription ?? "") },
    };
  }
  return undefined;
}

export const blueskyConnector: Connector = {
  id: "bluesky",
  counter: "graphemes",
  idempotent: true,
  labels: { ai: "text" },
  info: info({
    id: "bluesky",
    name: "Bluesky",
    tier: "direct",
    auth: "key",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, inbox: true }),
    limits: { maxChars: 300, maxImages: 4, maxVideoMb: 100, perDay: 30 },
    setup:
      "In Bluesky open Settings → Privacy and security → App passwords → Add App Password (don't use your main password). Connect with params { handle, appPassword } (key name \"bluesky\" can hold the app password). Video needs a verified email on the account.",
    docs: "https://docs.bsky.app/docs/advanced-guides/posts",
    keyNames: ["bluesky"],
  }),
  async connectKey(ctx, params, keys): Promise<Connected[]> {
    const identifier = need(params.handle ?? params.identifier, "Bluesky handle", "Pass params.handle, e.g. claudia.bsky.social.");
    const password = need(params.appPassword ?? params.password ?? (await keys.get("bluesky")), "Bluesky app password", "Create one in Settings → App passwords.");
    const service = (params.service ?? ENTRYWAY).replace(/\/$/, "");
    const s = await createSession(ctx, service, identifier, password);
    return [
      {
        account: { id: `bluesky:${s.did}`, network: "bluesky", handle: `@${s.handle}`, name: s.handle },
        credentials: sessionCreds(s, service, { identifier, appPassword: password, service }),
      },
    ];
  },
  async refresh(ctx) {
    const c = ctx.creds;
    try {
      const res = await ctx.http.request({
        method: "POST",
        url: `${c.pds}/xrpc/com.atproto.server.refreshSession`,
        headers: bearer(c.refreshJwt),
        secrets: [c.refreshJwt],
        network: "bluesky",
        label: "refresh session",
      });
      return sessionCreds(res.json, c.service ?? ENTRYWAY, c);
    } catch {
      // refresh token expired too: log in again with the stored app password
      const s = await createSession(ctx, c.service ?? ENTRYWAY, c.identifier, c.appPassword);
      return sessionCreds(s, c.service ?? ENTRYWAY, c);
    }
  },
  async publish(ctx, job) {
    const parts = [job.text, ...job.thread];
    const refs: StrongRef[] = [];
    let root: StrongRef | undefined;
    let parent: StrongRef | undefined;
    if (job.done.length) {
      // resume a thread: fetch what is already live
      for (const uri of job.done) refs.push(await getRecord(ctx, uri).then((r) => ({ uri: r.uri, cid: r.cid })));
      root = refs[0];
      parent = refs[refs.length - 1];
      if (job.replyTo) root = (await replyRefs(ctx, job.replyTo)).root;
    } else if (job.replyTo) {
      const r = await replyRefs(ctx, job.replyTo);
      root = r.root;
      parent = r.parent;
    }
    const embed = job.done.length ? undefined : await buildEmbed(ctx, job);
    const langs = (job.options.langs as string[] | undefined) ?? ["en"];
    for (let i = refs.length; i < parts.length; i++) {
      const text = parts[i]!;
      const record: Record<string, unknown> = {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
        langs,
      };
      const facets = await facetsFor(ctx, text);
      if (facets.length) record.facets = facets;
      if (i === 0 && embed) record.embed = embed;
      if (parent) record.reply = { root: root ?? parent, parent };
      const ref = await createPost(ctx, record, stableTid(job.stableAt, job.key, i), i === 0 ? "create post" : `thread part ${i + 1}`);
      refs.push(ref);
      await job.progress(ref.uri);
      if (!root) root = ref;
      parent = ref;
    }
    return { remoteId: refs[0]!.uri, remoteIds: refs.map((r) => r.uri), url: postUrl(ctx, refs[0]!.uri) };
  },
  async reply(ctx, to, text) {
    const { root, parent } = await replyRefs(ctx, to);
    const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), reply: { root, parent } };
    const facets = await facetsFor(ctx, text);
    if (facets.length) record.facets = facets;
    const ref = await createPost(ctx, record, undefined, "reply");
    return { remoteId: ref.uri, url: postUrl(ctx, ref.uri) };
  },
  async inbox(ctx, cursor) {
    const res = await ctx.http.request({
      method: "GET",
      url: `${ctx.creds.pds}/xrpc/app.bsky.notification.listNotifications?limit=50&reasons=mention&reasons=reply&reasons=quote`,
      headers: bearer(ctx.creds.accessJwt),
      secrets: [ctx.creds.accessJwt],
      network: "bluesky",
      label: "notifications",
      mock: { notifications: [] },
    });
    const seen = cursor?.lastIndexedAt ? Date.parse(cursor.lastIndexedAt) : 0;
    let newest = cursor?.lastIndexedAt;
    const items = [];
    for (const n of res.json.notifications ?? []) {
      const at = Date.parse(n.indexedAt);
      if (at <= seen) continue;
      if (!newest || at > Date.parse(newest)) newest = n.indexedAt;
      items.push({
        kind: n.reason === "reply" ? ("reply" as const) : ("mention" as const),
        id: n.uri,
        from: `@${n.author?.handle ?? n.author?.did}`,
        text: n.record?.text ?? "",
        at,
        url: `https://bsky.app/profile/${n.author?.handle ?? n.author?.did}/post/${String(n.uri).split("/").pop()}`,
      });
    }
    return { items, cursor: { lastIndexedAt: newest }, reads: 1 };
  },
};
