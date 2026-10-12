// @useclaudia/social — draft, approve, schedule and publish posts from a Claudia agent with your own keys.
export { createSocial } from "./social.js";
export { ClaudiaSocialError, isSocialError } from "./errors.js";
export type { SocialErrorCode } from "./errors.js";
export { KEY_NAMES, chainKeys, envKeys, parseClientCreds, staticKeys } from "./keys.js";
export { fileTokenStore, memoryTokenStore } from "./vault.js";
export { DEFAULT_RELAY, createPkce, loopbackRedirect, makeState, portFromState, waitForOAuthCallback } from "./oauth.js";
export { DEFAULT_MEDIA_RELAY } from "./media.js";
export {
  DEFAULT_CAPS,
  DEFAULT_LINKS_PER_DAY,
  DEFAULT_TEXTS,
  applyContentRules,
  countChars,
  countX,
  mentionsFinance,
  normalizedHash,
  promiseBlock,
} from "./rules.js";
export { CONNECTORS, LISTED_ONLY } from "./connectors/index.js";
export { launchAnnouncement } from "./announce.js";
export type { AnnounceChain, LaunchAnnouncement, LaunchAnnouncementInput } from "./announce.js";
export { X_PRICES } from "./connectors/x.js";
export { LINKEDIN_VERSION } from "./connectors/linkedin.js";
export { GRAPH_VERSION } from "./connectors/meta.js";
export { DEFAULT_RELAYS as NOSTR_DEFAULT_RELAYS, nostrKeygen, signEvent as signNostrEvent } from "./connectors/nostr.js";
export { stableTid } from "./connectors/bluesky.js";
export { escapeLittle } from "./connectors/linkedin.js";
export type { Connector, ConnCtx, PublishJob, PublishOut, OAuthSpec } from "./connectors/base.js";
export type { HttpRequest, HttpResponse, MultipartPart } from "./transport.js";
export * from "./types.js";
