// claudia keys set|list|remove <name> — the user's own provider keys, stored on this machine only (masked on screen).
import { UsageError } from "../args.js";
import { CliError, EXIT, type Ctx } from "../context.js";
import { KNOWN_KEYS, envNameOf, normalizeKeyName } from "../keystore.js";
import { ago, c, info, isInteractive, log, mask, ok, secret, section, sym, table, title, warn } from "../ui.js";

export async function keys(ctx: Ctx) {
  const [action = "list", rawName, ...rest] = ctx.args;
  const store = ctx.keys;
  if (action === "list" || action === "ls") {
    const list = await store.list();
    if (!ctx.json) {
      title("Your keys", "stored on this machine");
      table(
        [
          { header: "Name", get: (k) => c.bold(k.name), headline: true },
          { header: "Key", get: (k) => mask(k.value), headline: true },
          { header: "From", get: (k) => c.dim(k.from) },
          { header: "Added", get: (k) => c.dim(k.addedAt ? ago(k.addedAt) : "—"), priority: 1 },
          { header: "For", get: (k) => c.dim(KNOWN_KEYS[k.name]?.what ?? "custom"), priority: 2 },
        ],
        list,
        { empty: "No keys yet." },
      );
      const missing = Object.keys(KNOWN_KEYS).filter((n) => !list.some((k) => k.name === n));
      if (missing.length) {
        section("Not set");
        for (const group of ["models", "media", "social", "notify"] as const) {
          const names = missing.filter((n) => KNOWN_KEYS[n].group === group);
          if (names.length) log(`  ${c.dim(group.padEnd(8))} ${names.join(c.dim(` ${sym().dot} `))}`);
        }
      }
      log("");
      info(`Add one: claudia keys set <name> · env vars work too (${envNameOf("openai")}, OPENAI_API_KEY…)`);
      info(`File: ${store.file}${ctx.home.isEncrypted() ? " (encrypted with your passphrase)" : " (only you can read it)"}`);
    }
    return { keys: list.map((k) => ({ name: k.name, masked: mask(k.value), from: k.from, addedAt: k.addedAt ?? null })) };
  }
  if (!rawName) throw new UsageError(`Usage: claudia keys ${action} <name>`);
  const name = normalizeKeyName(rawName);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new UsageError("Key names are letters, digits and dashes (e.g. openai, fal, telegram-chat)");
  if (action === "set" || action === "add") {
    let value = rest.join(" ").trim();
    if (!value && isInteractive() && !ctx.json) value = await secret(`${KNOWN_KEYS[name]?.what ?? name} key:`);
    if (!value && !process.stdin.isTTY) value = (await readStdin()).trim();
    if (!value) throw new UsageError(`Usage: claudia keys set ${name}   (it asks without echoing; or pipe it: … | claudia keys set ${name})`);
    if (rest.length && !ctx.json) warn("Tip: leave the value off and paste it at the prompt, so it doesn't land in your shell history.");
    if (ctx.dryRun) return { dryRun: true, name, masked: mask(value) };
    await store.set(name, value);
    if (!KNOWN_KEYS[name] && !ctx.json) info(`"${name}" isn't a name Claudia's packages look for — known names: claudia keys list`);
    if (!ctx.json) ok(`Saved ${c.bold(name)} ${c.dim(mask(value))}`);
    const src = await store.source(name);
    if (src && src.from !== "keys.json" && !ctx.json) warn(`${src.from} is set in your environment and wins over the saved key.`);
    return { saved: name, masked: mask(value) };
  }
  if (action === "remove" || action === "rm" || action === "unset" || action === "delete") {
    const removed = ctx.dryRun ? false : await store.remove(name);
    if (!removed && !ctx.dryRun) throw new CliError(EXIT.ERROR, "not_found", `No saved key named ${name}.`, "claudia keys list");
    if (!ctx.json) ok(ctx.dryRun ? `Would remove ${name}` : `Removed ${c.bold(name)}`);
    return { removed: name, dryRun: ctx.dryRun };
  }
  throw new UsageError("Usage: claudia keys [list] | set <name> | remove <name>");
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
  });
}
