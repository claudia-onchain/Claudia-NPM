// Registry of connectors plus the networks that are listed with a reason but have no connector.
import type { ListedNetworkInfo, NetworkId } from "../types.js";
import type { Connector } from "./base.js";
import { blueskyConnector } from "./bluesky.js";
import { caps } from "./common.js";
import { discordConnector } from "./discord.js";
import { farcasterConnector } from "./farcaster.js";
import { linkedinConnector } from "./linkedin.js";
import { mastodonConnector } from "./mastodon.js";
import { facebookConnector, instagramConnector, threadsConnector } from "./meta.js";
import { nostrConnector } from "./nostr.js";
import { pinterestConnector } from "./pinterest.js";
import { bufferConnector, uploadPostConnector, zernioConnector } from "./services.js";
import { telegramConnector } from "./telegram.js";
import { tiktokConnector } from "./tiktok.js";
import { xConnector } from "./x.js";
import { youtubeConnector } from "./youtube.js";

export const CONNECTORS: Record<NetworkId, Connector> = {
  x: xConnector,
  telegram: telegramConnector,
  discord: discordConnector,
  bluesky: blueskyConnector,
  mastodon: mastodonConnector,
  farcaster: farcasterConnector,
  nostr: nostrConnector,
  linkedin: linkedinConnector,
  youtube: youtubeConnector,
  buffer: bufferConnector,
  zernio: zernioConnector,
  "upload-post": uploadPostConnector,
  instagram: instagramConnector,
  facebook: facebookConnector,
  threads: threadsConnector,
  tiktok: tiktokConnector,
  pinterest: pinterestConnector,
};

const none = caps({ schedule: false });

function listed(id: ListedNetworkInfo["id"], name: string, tier: "later" | "skip", reason: string, docs: string): ListedNetworkInfo {
  return { id, name, tier, auth: "key", caps: none, limits: {}, setup: reason, reason, docs };
}

export const LISTED_ONLY: ListedNetworkInfo[] = [
  listed("whatsapp", "WhatsApp", "skip", "Meta's WhatsApp Business policy does not allow crypto or token promotion, so Claudia does not post there. (Buffer/Zernio channels to WhatsApp are not used for the same reason.)", "https://business.whatsapp.com/policy"),
  listed("snapchat", "Snapchat", "later", "Snapchat's posting API (Public Profile / Snap Kit) is invite-only: apps need Snap's allowlist.", "https://developers.snap.com/"),
  listed("reddit", "Reddit", "later", "Reddit's Data API needs manual approval for new apps, and most crypto subreddits ban bots. Planned once approval is practical.", "https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki"),
  listed("zora", "Zora", "skip", "Every Zora post mints a new coin. Claudia never mints by posting.", "https://docs.zora.co/"),
  listed("lemon8", "Lemon8", "skip", "No public posting API.", "https://www.lemon8-app.com/"),
  listed("weibo", "Weibo", "skip", "Open-platform posting needs a mainland China developer identity.", "https://open.weibo.com/"),
  listed("douyin", "Douyin", "skip", "Open-platform posting needs a mainland China business identity.", "https://developer.open-douyin.com/"),
];

export type { Connector };
