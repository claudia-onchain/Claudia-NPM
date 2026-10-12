// What the terminal can do: colour depth, Unicode, width. Decided once per run (flags can override).
//
//   Colour   FORCE_COLOR=0|1|2|3 wins; then NO_COLOR / --no-color (off); then not a TTY or TERM=dumb (off);
//            then COLORTERM=truecolor|24bit, Windows Terminal, iTerm, WezTerm, VS Code, recent Windows 10+ (truecolor);
//            TERM=*256* (256 colours); anything else (16 colours).
//   Unicode  CLAUDIA_ASCII=1 or TERM=dumb → ASCII. Windows: Unicode in Windows Terminal / VS Code / ConEmu, else ASCII
//            (legacy console code pages). Elsewhere: a UTF-8 locale (LC_ALL / LC_CTYPE / LANG), or macOS.
//   Width    --width, then process.stdout.columns, then COLUMNS, then 80.
import { release } from "node:os";

export type ColorLevel = 0 | 1 | 2 | 3;

export interface Term {
  color: ColorLevel;
  unicode: boolean;
  width: number;
  isTTY: boolean;
  errTTY: boolean;
}

function envColor(env: NodeJS.ProcessEnv, isTTY: boolean, noColorFlag: boolean): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    if (force === "0" || force === "false") return 0;
    const n = Number(force);
    if (n === 1 || n === 2 || n === 3) return n as ColorLevel;
    return 1;
  }
  if (noColorFlag || (env.NO_COLOR !== undefined && env.NO_COLOR !== "")) return 0;
  if (!isTTY || env.TERM === "dumb") return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return 3;
  if (env.WT_SESSION || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "ghostty") return 3;
  if (process.platform === "win32") {
    const build = Number(release().split(".")[2] ?? 0);
    return build >= 14931 ? 3 : build >= 10586 ? 2 : 1;
  }
  if (/-256(color)?$/i.test(env.TERM ?? "") || env.TERM_PROGRAM === "Apple_Terminal") return 2;
  return 1;
}

function envUnicode(env: NodeJS.ProcessEnv): boolean {
  if (/^(1|true|yes)$/i.test(env.CLAUDIA_ASCII ?? "")) return false;
  if (/^(1|true|yes)$/i.test(env.CLAUDIA_UNICODE ?? "")) return true;
  if (env.TERM === "dumb") return false;
  if (process.platform === "win32") return !!(env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.ConEmuTask || env.TERMINUS_SUBLIME || env.TERM === "xterm-256color" || env.TERM === "alacritty");
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (loc) return /utf-?8/i.test(loc);
  return process.platform === "darwin";
}

let current: Term = detect();

export function detect(opts: { noColor?: boolean; width?: number; ascii?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Term {
  const isTTY = !!process.stdout.isTTY;
  const errTTY = !!process.stderr.isTTY;
  const cols = opts.width ?? (process.stdout.columns || Number(env.COLUMNS) || 80);
  return {
    color: envColor(env, isTTY, !!opts.noColor),
    unicode: opts.ascii ? false : envUnicode(env),
    width: Math.max(30, Math.min(400, Math.floor(cols))),
    isTTY,
    errTTY,
  };
}

export const term = (): Term => current;

export function configureTerm(opts: { noColor?: boolean; width?: number; ascii?: boolean }): Term {
  current = detect(opts);
  return current;
}

/** Track terminal resizes (watch mode redraws at the new width). */
if (process.stdout.isTTY) {
  process.stdout.on("resize", () => {
    current = { ...current, width: Math.max(30, Math.min(400, process.stdout.columns || current.width)) };
  });
}
