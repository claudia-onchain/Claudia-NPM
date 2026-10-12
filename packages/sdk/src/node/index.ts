// Node-only helpers: the shared ~/.claudia home (keys, API key, caps, spend ledger) and passphrase encryption.
export { ClaudiaHome, DEFAULT_CAPS, checkCaps, defaultHomeDir, ensurePrivateDir, modeOf, writePrivateJson } from "./home.js";
export type { Caps, ClaudiaConfig, HomeOptions } from "./home.js";
export { WrongPassphraseError, isSealed, open as openSealed, seal } from "./crypto-box.js";
export type { SealedBox } from "./crypto-box.js";
