// @useclaudia/sdk — talk to Claudia (https://useclaudia.xyz) from your own agent.
export { ClaudiaClient, chainOfKey, imageTypeOf, toTokenKey } from "./client.js";
export {
  CHAINS,
  CHAIN_ORDER,
  FEE_SPLIT,
  RETIRED_CHAINS,
  ROBINHOOD_CONTRACTS,
  ROBINHOOD_LAUNCHPADS,
  assertChainOpen,
  chainExplorerUrl,
  chainStatusFrom,
  isChainId,
  parseChain,
} from "./chains.js";
export type { ChainAvailability, ChainInfo, ChainKind, ChainStatusInfo, LaunchpadAvailability, LaunchpadInfo, RetiredChainId, RobinhoodLaunchpadId } from "./chains.js";
export { checksumAddress, evmAddressOf, generateEvmWallet, isEvmAddress, normalizeEvmKey } from "./evm-keys.js";
export type { ChainOptions, ClaudiaClientOptions, LaunchResult, MessageStream, PostResult, StreamOptions, TradeResult } from "./client.js";
export { ClaudiaOwner } from "./owner.js";
export type { AgentKeyInfo, CreateAgentInput, CreatedKey, PassportInfo } from "./owner.js";
export { ClaudiaApiError, ClaudiaConfigError, ClaudiaError, ClaudiaNetworkError, ClaudiaTxError, parseRetryAfter } from "./errors.js";
export { DEFAULT_BASE_URL, SDK_VERSION, HttpCore } from "./http.js";
export type { FetchLike, HttpOptions, RequestOptions } from "./http.js";
export { generateDeviceKey, generateWallet, isPublicKey, publicKeyOf, toKeypair } from "./keys.js";
export type { GeneratedKey } from "./keys.js";
export { EMPTY_BODY_SHA256, SIGNATURE_WINDOW_MS, canonicalString, createSigner, sha256Hex, signMessage, signRequest } from "./signing.js";
export type { Ed25519Signer, SignedHeaders } from "./signing.js";
export {
  DEVNET_RPC,
  LAMPORTS_PER_SOL,
  MAINNET_RPC,
  MEMO_PROGRAM_ID,
  buildMemoTx,
  connectionFor,
  defaultRpcUrl,
  getSolBalance,
  sendAndConfirm,
  sendAndConfirmOne,
  signTransactions,
} from "./solana.js";
export type { SendOptions, SignedTx } from "./solana.js";
export { decodeSecret, fromBase58, fromBase64, makeNonce, toBase58, toBase64 } from "./encoding.js";
export type { SecretInput } from "./encoding.js";
export * from "./types.js";
export { PUMP_LIMITS, explorerUrl, normalizeCoinName, normalizeTicker } from "./coin.js";
export type { FieldCheck } from "./coin.js";
export type { Connection, Keypair } from "@solana/web3.js";
export { FeedsApi, InsightsApi } from "./insights.js";
export type { BoardFeed, InsightsInterval, TrendingOrder } from "./insights.js";
export * from "./insights-types.js";
export { Hub, StreamApi } from "./stream.js";
export type {
  BoardEvent,
  BoardOptions,
  ChainStatus,
  ConnectionState,
  HubMessage,
  HubOptions,
  LaunchesOptions,
  LiveStream,
  StreamCommonOptions,
  ThreadStreamOptions,
  TokenEvent,
  TradesOptions,
  WalletStreamOptions,
  WebSocketCtor,
  WebSocketLike,
} from "./stream.js";
export { MCP_PROTOCOL_VERSION, McpHttpClient, mcpResultText } from "./mcp-http.js";
export type { McpCallResult, McpHttpOptions, McpTool } from "./mcp-http.js";
export { createToolExecutor, loadCatalog, normalizeToolName, toolOutputText } from "./exec.js";
export type { CatalogTool, ToolArgs, ToolExecutor, ToolExecutorOptions, ToolHandler } from "./exec.js";
