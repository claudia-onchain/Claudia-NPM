// Merges (or removes) one named MCP server entry in an app's config file without touching anything else:
// JSON (re-serialised with 2 spaces), JSONC (comments kept: the entry is spliced in as text), TOML (one
// [table.name] block replaced) and YAML (one block under a top-level key replaced). Plus a small line diff.
import type { Format } from "./mcp-apps.js";

// ─── JSON / JSONC ─────────────────────────────────────────────────────

/** Removes // and /* *\/ comments and trailing commas, leaving strings alone. */
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const hasComments = (src: string) => stripJsonc(src).replace(/\s+/g, "") !== src.replace(/,(\s*[}\]])/g, "$1").replace(/\s+/g, "");

function parseJsonLoose(src: string): Record<string, unknown> {
  if (!src.trim()) return {};
  const v = JSON.parse(stripJsonc(src)) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the file isn't a JSON object");
  return v as Record<string, unknown>;
}

function jsonSet(src: string, key: string[], name: string, entry: Record<string, unknown> | null, jsonc: boolean): string {
  const obj = parseJsonLoose(src);
  if (jsonc && src.trim() && hasComments(src)) return jsoncSplice(src, obj, key, name, entry);
  let cur: Record<string, unknown> = obj;
  for (const k of key) {
    if (!cur[k] || typeof cur[k] !== "object") {
      if (entry === null) return src;
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  if (entry === null) {
    if (!(name in cur)) return src;
    delete cur[name];
  } else cur[name] = entry;
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Finds the matching close brace for the "{" at `start` (string-aware). */
function closeOf(src: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") i++;
    else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** JSONC with comments: splice text so comments survive. Only a single-level key is supported (Zed, VS Code). */
function jsoncSplice(src: string, obj: Record<string, unknown>, key: string[], name: string, entry: Record<string, unknown> | null): string {
  if (key.length !== 1) throw new Error("can't edit nested keys in a file with comments");
  const k = key[0];
  const indentOf = (s: string) => /\n([ \t]+)"/.exec(s)?.[1] ?? "  ";
  const ind = indentOf(src);
  const render = (v: unknown, level: number) => JSON.stringify(v, null, ind).replace(/\n/g, "\n" + ind.repeat(level));
  const keyRe = new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{`);
  const m = keyRe.exec(src);
  if (!m) {
    if (entry === null) return src;
    const open = src.indexOf("{");
    if (open < 0) throw new Error("no top-level object");
    const empty = !Object.keys(obj).length;
    const block = `\n${ind}"${k}": {\n${ind}${ind}"${name}": ${render(entry, 2)}\n${ind}}${empty ? "" : ","}`;
    return src.slice(0, open + 1) + block + src.slice(open + 1);
  }
  const objStart = m.index + m[0].length - 1;
  const objEnd = closeOf(src, objStart);
  const inner = (obj[k] ?? {}) as Record<string, unknown>;
  const next = { ...inner };
  if (entry === null) {
    if (!(name in next)) return src;
    delete next[name];
  } else next[name] = entry;
  // Rewrite just this object (comments inside it are lost, the rest of the file is untouched).
  return src.slice(0, objStart) + render(next, 1) + src.slice(objEnd + 1);
}

// ─── TOML ─────────────────────────────────────────────────────────────

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  return '""';
}

function tomlSet(src: string, key: string[], name: string, entry: Record<string, unknown> | null): string {
  const header = `${key.map(tomlKey).join(".")}.${tomlKey(name)}`;
  const lines = src.split("\n");
  const isOurs = (l: string) => {
    const h = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(l)?.[1]?.trim().replace(/\s*\.\s*/g, ".");
    return !!h && (h === header || h.startsWith(header + "."));
  };
  const out: string[] = [];
  let skipping = false;
  let insertAt = -1;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) {
      if (isOurs(l)) {
        if (insertAt < 0) insertAt = out.length;
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(l);
  }
  if (entry === null) return insertAt < 0 ? src : out.join("\n").replace(/\n{3,}/g, "\n\n");
  const block = [`[${header}]`, ...Object.entries(entry).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`), ""];
  if (insertAt >= 0) out.splice(insertAt, 0, ...block);
  else {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length) out.push("");
    out.push(...block);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

// ─── YAML (one top-level mapping key) ────────────────────────────────

function yamlScalar(v: unknown): string {
  if (typeof v === "string") return /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~|\d.*)$/i.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return v.length ? `[${v.map(yamlScalar).join(", ")}]` : "[]";
  const e = Object.entries(v as Record<string, unknown>);
  return e.length ? `{ ${e.map(([k, x]) => `${yamlKey(k)}: ${yamlScalar(x)}`).join(", ")} }` : "{}";
}
const yamlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function yamlSet(src: string, key: string[], name: string, entry: Record<string, unknown> | null): string {
  const top = key[0];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const topIdx = lines.findIndex((l) => new RegExp(`^${top}:\\s*(\\{\\s*\\})?\\s*(#.*)?$`).test(l));
  const blockFor = (indent: string) => [`${indent}${yamlKey(name)}:`, ...Object.entries(entry ?? {}).map(([k, v]) => `${indent}  ${yamlKey(k)}: ${yamlScalar(v)}`)];
  if (topIdx < 0) {
    if (entry === null) return src;
    const body = lines.join("\n").replace(/\n*$/, "");
    return `${body ? body + "\n" : ""}${top}:\n${blockFor("  ").join("\n")}\n`;
  }
  if (/\{\s*\}/.test(lines[topIdx])) lines[topIdx] = `${top}:`;
  // Children of `top:` run until the next line with no indent (ignoring blanks and comments).
  let end = topIdx + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]) || /^\s*#/.test(lines[end]))) end++;
  const child = lines.slice(topIdx + 1, end).find((l) => l.trim() && !l.trim().startsWith("#"));
  const indent = child ? /^(\s+)/.exec(child)?.[1] ?? "  " : "  ";
  const childRe = new RegExp(`^${indent}(${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}|"${name}"):\\s*$`);
  let s = -1;
  let e = -1;
  for (let i = topIdx + 1; i < end; i++) {
    if (s < 0 && childRe.test(lines[i])) s = i;
    else if (s >= 0 && lines[i].trim() && !lines[i].startsWith(indent + " ") && !lines[i].startsWith(indent + "\t")) {
      e = i;
      break;
    }
  }
  if (s >= 0 && e < 0) e = end;
  // Keep trailing blank lines outside the removed block.
  while (s >= 0 && e > s + 1 && lines[e - 1].trim() === "") e--;
  if (entry === null) {
    if (s < 0) return src;
    lines.splice(s, e - s);
    return lines.join("\n");
  }
  const block = blockFor(indent);
  if (s >= 0) lines.splice(s, e - s, ...block);
  else lines.splice(topIdx + 1, 0, ...block);
  return lines.join("\n").replace(/\n*$/, "\n");
}

// ─── public ───────────────────────────────────────────────────────────

/** Returns the new file text with `name` set to `entry` (or removed when entry is null). */
export function upsert(format: Format, src: string, key: string[], name: string, entry: Record<string, unknown> | null): string {
  switch (format) {
    case "json":
      return jsonSet(src, key, name, entry, false);
    case "jsonc":
      return jsonSet(src, key, name, entry, true);
    case "toml":
      return tomlSet(src, key, name, entry);
    case "yaml":
      return yamlSet(src, key, name, entry);
  }
}

/** Reads the current entry for `name` (best effort; null when absent or unreadable). */
export function readEntry(format: Format, src: string, key: string[], name: string): unknown {
  try {
    if (format === "json" || format === "jsonc") {
      let cur: unknown = parseJsonLoose(src);
      for (const k of key) cur = (cur as Record<string, unknown> | undefined)?.[k];
      return (cur as Record<string, unknown> | undefined)?.[name] ?? null;
    }
    if (format === "toml") return new RegExp(`^\\s*\\[${key.join("\\.")}\\.${name.replace(/-/g, "\\-")}\\]`, "m").test(src) ? true : null;
    return new RegExp(`^\\s+${name.replace(/-/g, "\\-")}:\\s*$`, "m").test(src) ? true : null;
  } catch {
    return null;
  }
}

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

/** Line diff (LCS). Falls back to "replace everything" for very large inputs. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a ? a.replace(/\n$/, "").split("\n") : [];
  const y = b.replace(/\n$/, "").split("\n");
  // Trim the common head and tail first (big files usually change in one place).
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  const out: DiffLine[] = x.slice(0, head).map((t) => ({ op: " ", text: t }));
  if (xm.length * ym.length > 4_000_000) {
    out.push(...xm.map((t) => ({ op: "-" as const, text: t })), ...ym.map((t) => ({ op: "+" as const, text: t })));
  } else {
    const n = xm.length;
    const m = ym.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) out.push({ op: " ", text: xm[i++] }), j++;
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: xm[i++] });
      else out.push({ op: "+", text: ym[j++] });
    }
    while (i < n) out.push({ op: "-", text: xm[i++] });
    while (j < m) out.push({ op: "+", text: ym[j++] });
  }
  out.push(...x.slice(x.length - tail).map((t) => ({ op: " " as const, text: t })));
  return out;
}

/** Only the changed hunks with `context` lines around them. */
export function hunks(d: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Set<number>();
  d.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep.add(k);
  });
  const out: (DiffLine | null)[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push(null);
    out.push(d[i]);
    last = i;
  }
  return out;
}
