// @useclaudia/media — images, video, speech, music, sound effects and talking avatars for Claudia agents,
// with your own provider keys. See README.md.
export { createMedia } from "./media.js";
export { ClaudiaMediaError, isMediaError, type MediaErrorCode } from "./errors.js";
export { envKeys, chainKeys, staticKeys, KEY_NAMES } from "./keys.js";
export { createTransport, redactRequest, type Transport, type HttpRequest, type HttpResponse, type DryRunResult, type FormPart } from "./transport.js";
export { DEFAULT_BRAND, launchCardPrompt } from "./brands.js";
export { MODELS as MODEL_TABLE, findModel, type ModelEntry } from "./models.js";
export { CONNECTORS } from "./providers/index.js";
export type { Connector, Ctx as ConnectorContext, Step as ConnectorStep, RemoteOutput } from "./providers/base.js";
export { sniff, pcmToWav } from "./sniff.js";
export type {
  MediaKind,
  ProviderId,
  ModelInfo,
  PriceInfo,
  GenerateRequest,
  Estimate,
  JobStatus,
  MediaOutput,
  Provenance,
  Job,
  SpendLimits,
  Brand,
  DryRun,
  DryRunRequest,
  ProviderSummary,
  SpendSummary,
  KeyProvider,
  MediaOptions,
  Media,
  JobListener,
  CheckModelsResult,
} from "./types.js";
