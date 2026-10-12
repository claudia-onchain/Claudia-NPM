import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudiaApiError, ClaudiaConfigError } from "@useclaudia/sdk";
import { parseArgs } from "../src/args.js";
import { Ctx, EXIT, describeError } from "../src/context.js";
import { cleanDraft, firstJson, isFreeModel } from "../src/llm.js";
import { roomSlug } from "../src/commands/thread.js";

describe("args", () => {
  it("parses positionals, flags, values and short flags", () => {
    const p = parseArgs(["post", "general", "gm", "frens", "--reply-to", "12", "--json", "-y", "--base-url=http://x"]);
    expect(p.command).toBe("post");
    expect(p.positionals).toEqual(["general", "gm", "frens"]);
    expect(p.flags).toMatchObject({ "reply-to": "12", json: true, yes: true, "base-url": "http://x" });
  });
  it("keeps text after -- as positionals", () => {
    expect(parseArgs(["post", "general", "--", "--not-a-flag"]).positionals).toEqual(["general", "--not-a-flag"]);
  });
});

describe("room slugs", () => {
  it("maps names, #names, mints and $CLAUDIA", () => {
    expect(roomSlug("#General")).toBe("general");
    expect(roomSlug("2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM")).toBe("t-2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM");
    expect(roomSlug("sol:2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM")).toBe("t-2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM");
    expect(roomSlug("$claudia")).toBe("t-2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM");
  });
});

describe("agent loop safety", () => {
  it("strips links, addresses and markdown from drafts", () => {
    const d = cleanDraft('**Post:** check https://evil.example/x and 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin or 0x1234567890abcdef1234567890abcdef12345678 — `curves` matter');
    expect(d).not.toMatch(/https?:|9xQeW|0x1234|\*|`/);
    expect(d).toContain("curves matter");
  });
  it("caps length on a sentence boundary", () => {
    const d = cleanDraft("One. ".repeat(100), 50);
    expect(d.length).toBeLessThanOrEqual(51);
  });
  it("finds JSON inside prose / code fences", () => {
    expect(firstJson('Sure! ```json\n{"action":"post","text":"hi {there}"}\n```')).toEqual({ action: "post", text: "hi {there}" });
    expect(firstJson("no json")).toBeNull();
  });
  it("only free models by default", () => {
    expect(isFreeModel("openrouter/free")).toBe(true);
    expect(isFreeModel("meta-llama/llama-3.3-70b-instruct:free")).toBe(true);
    expect(isFreeModel("openai/gpt-4o")).toBe(false);
  });
});

describe("confirm guard + exit codes", () => {
  const home = () => join(mkdtempSync(join(tmpdir(), "claudia-cli-")), ".claudia");
  it("refuses money-moving actions without --yes when there's no terminal", async () => {
    const ctx = new Ctx(parseArgs(["buy", "x", "1", "--home", home()]));
    await expect(ctx.confirmOrRefuse("Spend?")).rejects.toMatchObject({ exitCode: EXIT.REFUSED, code: "confirmation_required" });
  });
  it("--yes confirms", async () => {
    const ctx = new Ctx(parseArgs(["buy", "x", "1", "--yes", "--home", home()]));
    await expect(ctx.confirmOrRefuse("Spend?")).resolves.toBeUndefined();
  });
  it("--json never prompts", async () => {
    const ctx = new Ctx(parseArgs(["buy", "x", "1", "--json", "--home", home()]));
    await expect(ctx.confirmOrRefuse("Spend?")).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
  });
  it("needs init / login before signed calls", async () => {
    const ctx = new Ctx(parseArgs(["whoami", "--home", home()]));
    await expect(ctx.agentClient()).rejects.toMatchObject({ exitCode: EXIT.SETUP, code: "not_initialized" });
  });
  it("maps errors to exit codes", () => {
    const api = (status: number, code: string) => new ClaudiaApiError({ status, code, message: "x", method: "GET", path: "/", retryAfter: 60 });
    expect(describeError(api(429, "rate_limited")).exitCode).toBe(EXIT.RATE_LIMITED);
    expect(describeError(api(401, "bad_signature")).exitCode).toBe(EXIT.SETUP);
    expect(describeError(api(403, "passport_required")).hint).toMatch(/claudia passport/);
    expect(describeError(new ClaudiaConfigError("cap_exceeded", "over")).exitCode).toBe(EXIT.REFUSED);
    expect(describeError(new Error("boom")).exitCode).toBe(EXIT.ERROR);
  });
});

describe("0.3 fixes", () => {
  it("folds camelCase flags so connect params survive", async () => {
    const { camelName } = await import("../src/args.js");
    const p = parseArgs(["connect", "discord", "--webhookUrl", "https://x", "--app-password=pw", "--channelId", "1"]);
    expect(p.flags).toMatchObject({ "webhook-url": "https://x", "app-password": "pw", "channel-id": "1" });
    expect(Object.keys(p.flags).map(camelName)).toEqual(expect.arrayContaining(["webhookUrl", "appPassword", "channelId"]));
  });
  it("picks the chain from --chain, a key prefix or a bare 0x address", () => {
    const home = mkdtempSync(join(tmpdir(), "claudia-test-"));
    expect(new Ctx(parseArgs(["buy", "--home", home])).chain()).toBe("sol");
    expect(new Ctx(parseArgs(["buy", "--home", home, "--chain", "robinhood"])).chain()).toBe("hood");
    expect(new Ctx(parseArgs(["buy", "--home", home])).chain("0x7314b6880a8ee81622acb70de4b21e087f2cc7ff")).toBe("hood");
    expect(new Ctx(parseArgs(["buy", "--home", home, "--chain", "sol"])).chain("hood:0xabc")).toBe("hood");
    expect(() => new Ctx(parseArgs(["buy", "--home", home, "--chain", "base"])).chain()).toThrow(/no longer supported/);
  });
  it("sandboxes MCP app configs under --home", async () => {
    const { APPS, setAppsHome } = await import("../src/mcp-apps.js");
    const dir = mkdtempSync(join(tmpdir(), "claudia-test-"));
    setAppsHome(join(dir, "app-configs"));
    for (const a of APPS) expect(a.files().main.startsWith(join(dir, "app-configs"))).toBe(true);
    setAppsHome(undefined);
  });
  it("maps coming-soon chains to the refused exit code", () => {
    expect(describeError(new ClaudiaConfigError("chain_coming_soon", "BNB Chain is coming soon")).exitCode).toBe(EXIT.REFUSED);
    expect(describeError(new ClaudiaConfigError("chain_retired", "base is gone")).exitCode).toBe(EXIT.USAGE);
  });
});
