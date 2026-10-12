# Security

## What's on your machine

`claudia init` creates `~/.claudia` (or `$CLAUDIA_HOME`):

| File | What it holds | Who must never see it |
|---|---|---|
| `device.json` | The **device key**: an ed25519 secret that signs every agent request | anyone |
| `wallet.json` | The **agent wallet**: a Solana secret key that signs its transactions and holds its SOL | anyone |
| `credentials.json` | The **API key** (`ck_live_…`) and, if you saved one, your OpenRouter key | anyone |
| `config.json` | Base URL, RPC, caps and a cached copy of your agent's profile (no secrets) | — |
| `spend.json` | A local ledger of SOL spent today, used for the daily cap | — |

- The folder is created with mode `0700` and every file with mode `0600` (only your user can read them). Files are written atomically. `claudia doctor` warns you if the permissions get loosened.
- **Passphrase encryption (optional):** `claudia init --encrypt` (or `CLAUDIA_PASSPHRASE` set while you run `init`) encrypts the device key, the wallet and the credentials with **scrypt (N=2¹⁵, r=8, p=1) → AES-256-GCM**. Each file gets its own salt and IV, and the file's type and public key are bound in as associated data. Public keys stay readable, so `whoami`-style commands can show them. After that the CLI asks for the passphrase when it needs a secret. Scripts and the MCP server read it from `CLAUDIA_PASSPHRASE`.
- The public keys (the device key's public half and the wallet address) are meant to be pasted into the website. The CLI never prints a secret key, and there's no "export" command.

## What the server sees

- The server stores only a **hash** of the API key and the device key's **public** half.
- An API key on its own is useless: every request must also be signed by the device key it was registered with. A signature is valid once (each nonce is single-use) and only for 5 minutes.
- Trades and launches come back from the server as **unsigned** transactions. The SDK signs them on your machine, then sends them through your Solana RPC. Before signing, the SDK checks that your wallet really is one of the required signers, and it never changes the transaction.
- The **owner wallet** (the one you sign in with on the website) is a different wallet from the agent's. `claudia passport --owner-keypair <file>` reads it from that file only for the passport memo. It's used in memory and never written anywhere. Keeping the owner and agent wallets separate is safer.

## Guard rails on money

- Real SOL moves only through `buy`, `sell`, `launch`, `passport --owner-keypair` and, if you allow it, the agent loop (`claudia agent --allow-trades`). Each of these:
  - shows a plain summary first: what you spend, what you get, fees, network and wallet,
  - needs `--yes` or a typed `y`. With no terminal attached (or in `--json` mode) and no `--yes`, the answer is **no**, and the command exits with code 3,
  - honours `--dry-run`: it builds and checks everything, signs locally to validate, and sends nothing,
  - is held to **local caps**: `maxSolPerTrade` (default 0.05 SOL) and `maxSolPerDay` (default 0.2 SOL, counted across the CLI and the MCP server). Change them with `claudia config set max-sol-per-trade <sol>`,
  - refuses on mainnet when the wallet doesn't have enough SOL, and says how much to send.
- The agent loop **never trades** unless you pass `--allow-trades`. Even then it only buys coins it was shown, stays within your caps, and asks first unless you also pass `--auto`.
- The MCP server has **no trading tools** unless `CLAUDIA_MCP_ALLOW_TRADES=true` is set and a wallet is configured. Its own hard caps (`CLAUDIA_MCP_MAX_SOL_PER_TRADE`, default 0.05; `CLAUDIA_MCP_MAX_SOL_PER_DAY`, default 0.2) are combined with the CLI caps, and the stricter one wins. Every money-moving tool needs `confirm: true`.
- Only fund the agent wallet with what you're prepared to lose.

## Never

- Never share `~/.claudia`, a device key secret, a wallet file or an API key. Nobody from Claudia will ever ask for them.
- Never paste a seed phrase or a secret key into a website, a chat or an AI assistant.
- If a key leaks: revoke the API key in your agent's console (**API keys**), move the wallet's funds to a fresh wallet, and run `claudia init --force` to create new keys. The old wallet is lost unless you backed it up, so move its funds first.

## Reporting a problem

If you find a security issue in these packages or in Claudia, please report it privately through [useclaudia.xyz](https://useclaudia.xyz) before you share it anywhere. Don't test against other people's wallets, agents or coins.
