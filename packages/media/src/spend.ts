// Spend ledger (<dataDir>/media/spend.jsonl, append-only, last line per job wins) and limit checks.
// A job reserves its estimate when it is submitted; on success the entry is settled at the final cost,
// on failure / block / cancel before any output it is voided (providers generally don't bill failed generations).
// Days and months are UTC, like the @useclaudia/sdk SOL ledger.
import { join } from "node:path";
import { ClaudiaMediaError } from "./errors.js";
import { appendLine, mtimeMs, readLines } from "./store.js";
import type { SpendLimits, SpendSummary } from "./types.js";

export interface SpendEntry {
  jobId: string;
  provider: string;
  model: string;
  usd: number;
  /** When the spend was first reserved (keeps it in the same day/month after settling). */
  at: number;
  state: "reserved" | "settled" | "void";
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

export class SpendLedger {
  private file: string;
  private byJob = new Map<string, SpendEntry>();
  private seenMtime = -1;
  constructor(mediaDir: string) {
    this.file = join(mediaDir, "spend.jsonl");
    this.reload();
  }
  private reload(): void {
    const m = mtimeMs(this.file);
    if (m === this.seenMtime) return;
    this.seenMtime = m;
    this.byJob.clear();
    for (const e of readLines<SpendEntry>(this.file)) if (e && e.jobId) this.byJob.set(e.jobId, e);
  }
  private write(e: SpendEntry): void {
    this.reload();
    this.byJob.set(e.jobId, e);
    appendLine(this.file, e);
    this.seenMtime = mtimeMs(this.file);
  }
  reserve(jobId: string, provider: string, model: string, usd: number, at = Date.now()): void {
    this.write({ jobId, provider, model, usd: round(usd), at, state: "reserved" });
  }
  settle(jobId: string, usd: number): void {
    const prev = this.get(jobId);
    if (!prev) return;
    this.write({ ...prev, usd: round(usd), state: "settled" });
  }
  void(jobId: string): void {
    const prev = this.get(jobId);
    if (!prev || prev.state === "void") return;
    this.write({ ...prev, usd: 0, state: "void" });
  }
  get(jobId: string): SpendEntry | undefined {
    this.reload();
    return this.byJob.get(jobId);
  }
  summary(now = Date.now()): SpendSummary {
    this.reload();
    const d = dayKey(now);
    const m = monthKey(now);
    const out: SpendSummary = { today: 0, month: 0, byProvider: {} };
    for (const e of this.byJob.values()) {
      if (e.state === "void" || monthKey(e.at) !== m) continue;
      const p = (out.byProvider[e.provider] ??= { today: 0, month: 0 });
      p.month += e.usd;
      out.month += e.usd;
      if (dayKey(e.at) === d) {
        p.today += e.usd;
        out.today += e.usd;
      }
    }
    out.today = round(out.today);
    out.month = round(out.month);
    for (const p of Object.values(out.byProvider)) {
      p.today = round(p.today);
      p.month = round(p.month);
    }
    return out;
  }
}

const round = (x: number) => Math.round(x * 10000) / 10000;

type Flat = Omit<SpendLimits, "perProvider">;

function effective(limits: SpendLimits | undefined, provider: string): { global: Flat; local: Flat } {
  return { global: limits ?? {}, local: limits?.perProvider?.[provider] ?? {} };
}

const fmt = (x: number) => `$${x.toFixed(2)}`;

/**
 * Throws over_budget when `usd` would break a per-job, per-day or per-month cap (global or for the provider).
 * `pendingUsd` is money reserved by jobs that were accepted but not yet submitted.
 */
export function checkLimits(
  limits: SpendLimits | undefined,
  provider: string,
  usd: number,
  spent: SpendSummary,
  pending: { all: number; provider: number } = { all: 0, provider: 0 },
): void {
  const { global, local } = effective(limits, provider);
  const p = spent.byProvider[provider] ?? { today: 0, month: 0 };
  const checks: [number | undefined, number, string][] = [
    [global.perJobUsd, usd, "per-job limit"],
    [local.perJobUsd, usd, `${provider} per-job limit`],
    [global.perDayUsd, spent.today + pending.all + usd, "daily limit"],
    [local.perDayUsd, p.today + pending.provider + usd, `${provider} daily limit`],
    [global.perMonthUsd, spent.month + pending.all + usd, "monthly limit"],
    [local.perMonthUsd, p.month + pending.provider + usd, `${provider} monthly limit`],
  ];
  for (const [cap, value, what] of checks) {
    if (cap !== undefined && cap !== null && value > cap + 1e-9)
      throw new ClaudiaMediaError("over_budget", `This job (about ${fmt(usd)}) would go over the ${what} of ${fmt(cap)}.`, {
        hint: `Raise the ${what}, pick a cheaper model, shorten the video, or wait until the ${what.includes("month") ? "month" : what.includes("daily") ? "day" : "limit"} resets.`,
      });
  }
}

/** The lower of the global and per-provider approval thresholds, if any. */
export function approvalThreshold(limits: SpendLimits | undefined, provider: string): number | undefined {
  const { global, local } = effective(limits, provider);
  const vals = [global.approveAboveUsd, local.approveAboveUsd].filter((x): x is number => typeof x === "number");
  return vals.length ? Math.min(...vals) : undefined;
}
