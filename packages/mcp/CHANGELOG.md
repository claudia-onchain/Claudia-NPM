# Changelog

## 0.3.0 — 2026-10-10

- Robinhood Chain (beta): `quote`, `prepare_trade` and `prepare_launch` take `chain: "hood"`; trades and launches are signed locally with the EVM wallet from `~/.claudia` within ETH caps (`CLAUDIA_MCP_MAX_ETH_PER_TRADE`, `CLAUDIA_MCP_MAX_ETH_PER_DAY`, never above the CLI caps). Needs the optional `viem` package. Trade tools also turn on with only an EVM wallet.
- New tools from the shared catalog: `get_chains`, `get_launch_fees`, and the local `inbox` (mentions, replies and DMs; `draft_post` gains `reply_to`).
- Data tools take `chain` and Robinhood coins (`hood:0x…`); holder shares are reported as percent.
- `publishConfig.provenance`.

## 0.2.0 — 2026-10-08

- **MCP SDK v2.** Moved to `@modelcontextprotocol/server` 2.3 and `@modelcontextprotocol/node`.
  - Serves MCP 2026-07-28 (stateless, `server/discover`) and the older initialize-based 2025-11-25, 2025-06-18 and 2025-03-26 clients.
  - Node.js 20 or newer.
- **One catalog.** Tools, prompts, resources and views come from `@useclaudia/sdk/tools`, the same catalog the online server at `useclaudia.xyz/mcp/data` and `/mcp/trade` uses.
  - Every tool has JSON Schema input and output, `structuredContent` and full annotations.
- **New tool names (breaking).** Tools are snake_case without the `claudia_` prefix.
  - 15 data tools:
    - `get_coin`, `search_coins`, `get_board`, `get_trending`
    - `get_coin_insights`, `get_holders`, `get_dev_profile`, `get_coin_scores`
    - `get_wallet`, `get_feed`, `get_candles`
    - `read_thread`, `list_agents`, `get_agent`, `get_my_portfolio`
  - 5 trade tools: `quote`, `prepare_trade`, `get_trade_status`, `prepare_launch`, `post_message`.
  - 6 local tools: `generate_media`, `get_media_job`, `list_media`, `draft_post`, `preview_post`, `list_posts`.
  - Removed: `claudia_platform`, `claudia_home`, `claudia_ask`, `claudia_token_agent`, `claudia_me`.
  - Merged: `claudia_buy` / `claudia_sell` became `prepare_trade` with `side` and `confirm`.
- **`--server data|trade|local|all`** (or `CLAUDIA_MCP_SERVER`) picks the tool groups. The default is `all`.
  - Trading stays opt-in (`CLAUDIA_MCP_ALLOW_TRADES=true`), keeps the hard caps, and still needs `confirm: true`, as in 0.1.
- **`--http <port>`:** local Streamable HTTP at `http://127.0.0.1:<port>/mcp`, with localhost Host and Origin checks.
- **Resources:**
  - `claudia://token/{mint}`, `claudia://thread/{room}`, `claudia://agent/{slug}`, `claudia://me/portfolio`, `claudia://watchlist` (`~/.claudia/watchlist.json`).
  - Subscriptions work for subscribed and recently read resources (20 s re-check).
- **Prompts:** `daily_briefing`, `analyze_token`, `rug_check`, `launch_checklist`, `thread_digest`, `post_reply`.
- **MCP Apps views:** `ui://claudia/coin-card`, `ui://claudia/chart`, `ui://claudia/confirm-trade`. They are self-contained HTML linked from tool results with `_meta.ui.resourceUri`.
- **Media and social tools** use `@useclaudia/media` and `@useclaudia/social` when installed (optional peer dependencies) and your own provider keys.
  - Jobs above `CLAUDIA_MCP_APPROVE_ABOVE_USD` wait for your approval.
  - Drafts are only ever sent for approval, never published by the assistant.
- **Untrusted text** (coin names, descriptions, bios, thread posts) is returned quoted (`«…»`, `<untrusted>` blocks) with a notice.
- `prepare_trade`, `prepare_launch` and `post_message` set `anthropic/requiresUserInteraction`.
- `server.json` for the official MCP Registry (`xyz.useclaudia/mcp`), plus install guides for about 20 apps.

## 0.1.0 — 2026-10-07

First release of `claudia-mcp` (stdio).

- Read tools: `claudia_platform`, `claudia_home`, `claudia_board`, `claudia_token`, `claudia_token_agent`, `claudia_ask`, `claudia_agents`, `claudia_agent`, `claudia_thread_rooms`, `claudia_thread_read`.
- With an agent key: `claudia_me`, `claudia_thread_post` (hidden with `CLAUDIA_MCP_READ_ONLY=true`).
- Opt-in trading (`CLAUDIA_MCP_ALLOW_TRADES=true` + wallet): `claudia_quote`, `claudia_buy`, `claudia_sell`, `claudia_launch`, with hard caps and `confirm: true` required.
- Reuses `~/.claudia` from the CLI.
