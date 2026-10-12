// Farcaster through Neynar: the user's own Neynar API key + an approved signer UUID.
// Docs: https://docs.neynar.com/reference/publish-cast · https://docs.neynar.com/reference/lookup-signer
//       https://docs.neynar.com/reference/fetch-all-notifications · https://docs.neynar.com/reference/compute-units
import { ClaudiaSocialError } from "../errors.js";
import { isUrl, qs } from "../util.js";
import { need, type ConnCtx, type Connector } from "./base.js";
import { caps, chain, info } from "./common.js";

const API = "https://api.neynar.com/v2/farcaster";

function headers(ctx: ConnCtx): Record<string, string> {
  return { "x-api-key": ctx.creds.apiKey };
}

async function cast(ctx: ConnCtx, body: Record<string, unknown>, label: string): Promise<string> {
  const res = await ctx.http.request({
    method: "POST",
    url: `${API}/cast/`,
    headers: headers(ctx),
    json: { signer_uuid: ctx.creds.signerUuid, ...body },
    secrets: [ctx.creds.apiKey, ctx.creds.signerUuid],
    network: "farcaster",
    label,
    mock: { success: true, cast: { hash: "0x71d5225f77e0164388b1d4c120825f3a2c1f131c", author: { fid: ctx.creds.fid } } },
  });
  return res.json.cast.hash as string;
}

function castUrl(ctx: ConnCtx, hash: string): string {
  return ctx.creds.username ? `https://farcaster.xyz/${ctx.creds.username}/${hash.slice(0, 10)}` : `https://farcaster.xyz/~/conversations/${hash}`;
}

export const farcasterConnector: Connector = {
  id: "farcaster",
  counter: "bytes",
  idempotent: true,
  labels: { ai: "text" },
  info: info({
    id: "farcaster",
    name: "Farcaster (via Neynar)",
    tier: "direct",
    auth: "key",
    caps: caps({ text: true, image: true, video: true, thread: true, reply: true, inbox: true }),
    limits: { maxChars: 320, maxImages: 2, perDay: 20 },
    costHint: "Neynar credits: 150 per cast, 5 per notification read (their plan, your key).",
    setup:
      "Create a Neynar account at neynar.com, copy the API key, and create a managed signer for your Farcaster account (Neynar dashboard → Signers, or their Sign In with Neynar flow) and approve it in the Farcaster app. Connect with params { apiKey, signerUuid } (key names \"neynar\" and \"neynar-signer\"). Images go in as links: give an https URL, not a local file.",
    docs: "https://docs.neynar.com/reference/publish-cast",
    keyNames: ["neynar", "neynar-signer"],
  }),
  check(_a, job) {
    const local = job.media.filter((m) => !isUrl(m.path));
    if (local.length) return "Farcaster shows media from a permanent link. Give the image/video as an https URL (a short-lived relay link would break later).";
    if (job.media.length + (job.link ? 1 : 0) > 2) return "Neynar takes at most 2 embeds per cast (media + link).";
    return undefined;
  },
  async connectKey(ctx, params, keys) {
    const apiKey = need(params.apiKey ?? (await keys.get("neynar")), "Neynar API key", "Copy it from the Neynar dashboard.");
    const signerUuid = need(params.signerUuid ?? (await keys.get("neynar-signer")), "Neynar signer UUID", "Create a signer in Neynar and approve it in the Farcaster app.");
    const c: ConnCtx = { ...ctx, creds: { apiKey, signerUuid } };
    const s = (
      await c.http.request({
        method: "GET",
        url: `${API}/signer/?${qs({ signer_uuid: signerUuid })}`,
        headers: headers(c),
        secrets: [apiKey, signerUuid],
        network: "farcaster",
        label: "check signer",
        mock: { signer_uuid: "***", status: "approved", fid: 1234 },
      })
    ).json;
    if (s.status !== "approved") {
      throw new ClaudiaSocialError("invalid", `The Neynar signer is "${s.status}", not approved.`, {
        network: "farcaster",
        hint: s.signer_approval_url ? `Approve it here: ${s.signer_approval_url}` : "Approve it in the Farcaster app.",
      });
    }
    const u = (
      await c.http.request({
        method: "GET",
        url: `${API}/user/bulk/?${qs({ fids: s.fid })}`,
        headers: headers(c),
        secrets: [apiKey],
        network: "farcaster",
        label: "look up user",
        mock: { users: [{ fid: 1234, username: "claudia", display_name: "Claudia", pfp_url: "" }] },
      })
    ).json.users?.[0];
    return [
      {
        account: { id: `farcaster:${s.fid}`, network: "farcaster", handle: `@${u?.username ?? s.fid}`, name: u?.display_name, avatar: u?.pfp_url },
        credentials: { apiKey, signerUuid, fid: s.fid, username: u?.username },
      },
    ];
  },
  async publish(ctx, job) {
    const embeds = [...job.media.map((m) => ({ url: m.path })), ...(job.link ? [{ url: job.link }] : [])].slice(0, 2);
    const ids = await chain(job, (text, parent, i) =>
      cast(
        ctx,
        {
          text: i === 0 && job.link ? text.replace(job.link, "").trim() : text,
          ...(i === 0 && embeds.length ? { embeds } : {}),
          ...(parent ? { parent } : i === 0 && job.options.channel ? { channel_id: job.options.channel } : {}),
          // Neynar's idempotency key: the same idem on a retry never makes a second cast
          idem: `${job.key.slice(0, 14)}${i.toString(36).padStart(2, "0")}`,
        },
        i === 0 ? "cast" : `thread part ${i + 1}`,
      ),
    );
    return { remoteId: ids[0]!, remoteIds: ids, url: castUrl(ctx, ids[0]!) };
  },
  async reply(ctx, to, text) {
    const hash = await cast(ctx, { text, parent: to }, "reply");
    return { remoteId: hash, url: castUrl(ctx, hash) };
  },
  async inbox(ctx, cursor) {
    const res = await ctx.http.request({
      method: "GET",
      url: `${API}/notifications/?${qs({ fid: ctx.creds.fid, type: "mentions,replies", limit: 25 })}`,
      headers: headers(ctx),
      secrets: [ctx.creds.apiKey],
      network: "farcaster",
      label: "notifications",
      mock: { notifications: [] },
    });
    const seen = cursor?.last ? Date.parse(cursor.last) : 0;
    let last = cursor?.last;
    const items = [];
    for (const n of res.json.notifications ?? []) {
      if (!n.cast) continue;
      const at = Date.parse(n.most_recent_timestamp ?? n.cast.timestamp);
      if (at <= seen) continue;
      if (!last || at > Date.parse(last)) last = n.most_recent_timestamp ?? n.cast.timestamp;
      items.push({
        kind: /reply/.test(n.type) ? ("reply" as const) : ("mention" as const),
        id: n.cast.hash,
        from: `@${n.cast.author?.username ?? n.cast.author?.fid}`,
        text: n.cast.text ?? "",
        at,
        url: `https://farcaster.xyz/${n.cast.author?.username}/${String(n.cast.hash).slice(0, 10)}`,
      });
    }
    return { items, cursor: { last }, reads: 1 };
  },
};
