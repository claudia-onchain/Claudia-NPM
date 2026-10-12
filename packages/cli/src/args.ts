// Tiny argv parser: positionals, --flag, --flag value, --flag=value, -y, --no-x. No dependencies.

/** Flags that never take a value. */
const BOOLEAN = new Set([
  "json",
  "yes",
  "dry-run",
  "follow",
  "loop",
  "auto",
  "allow-trades",
  "allow-paid-model",
  "clear-kill-file",
  "force",
  "help",
  "version",
  "no-color",
  "encrypt",
  "no-encrypt",
  "once",
  "no-verify",
  "mayhem",
  "verbose",
  "show-secret",
  "local",
  "history",
  "ascii",
  "no-open",
  "all",
  "print",
  "approve",
  "oauth",
  "quiet",
  "wide",
]);

const SHORT: Record<string, string> = { y: "yes", h: "help", v: "version", f: "follow", n: "dry-run", q: "quiet" };
/** Short flags that take a value: -p "<prompt>", -m <model>, -o <file>. */
const SHORT_VALUE: Record<string, string> = { p: "prompt", m: "model", o: "out" };

/** "webhookUrl" / "webhook-url" / "WEBHOOK_URL" → "webhook-url". */
export const flagName = (raw: string): string =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

/** "webhook-url" → "webhookUrl" (what @useclaudia/social connectors read). */
export const camelName = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());

export interface Parsed {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      rest = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      // camelCase → kebab-case (--webhookUrl → webhook-url), so both spellings land on the same flag.
      const name = flagName(eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (eq > 0) {
        flags[name] = a.slice(eq + 1);
        continue;
      }
      if (BOOLEAN.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith("--") && next.length > 2)) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(a) && SHORT_VALUE[a[1]]) {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${a} needs a value`);
      flags[SHORT_VALUE[a[1]]] = next;
      i++;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) flags[SHORT[ch] ?? ch] = true;
      continue;
    }
    positionals.push(a);
  }
  const command = positionals.shift();
  return { command, positionals, flags };
}

export class UsageError extends Error {
  readonly code = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function str(flags: Parsed["flags"], name: string): string | undefined {
  const v = flags[name];
  if (v === undefined || v === false) return undefined;
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
}

export function numFlag(flags: Parsed["flags"], name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v.replace(/%$/, ""));
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

export const bool = (flags: Parsed["flags"], name: string): boolean => flags[name] === true || flags[name] === "true";
