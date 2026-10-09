/**
 * The composer's usage ring (Claude's desktop composer: a small circle beside Send): how much of the plan's limit is
 * used, as the agent's own CLI reports it without a model call (`claude -p /usage`, `agy -p /usage`, Claude Code's
 * rate_limit_event during a turn), and this chat's tokens. An agent that reports no limits shows the tokens only.
 */
import type { TokenUsage, UsageInfo, UsageWindow } from "@shared/agents/types";

export type RingState = "none" | "ok" | "warn" | "full";

/** The windows that count for this model: Antigravity's limits are per group of models (Gemini / Claude and GPT). */
export function relevantWindows(info: UsageInfo | null | undefined, model?: string): UsageWindow[] {
  const all = info?.windows ?? [];
  if (!all.some((w) => w.group)) return all;
  const gemini = /^gemini/i.test(model ?? "gemini");
  const mine = all.filter((w) => !w.group || /gemini/i.test(w.group) === gemini);
  return mine.length ? mine : all;
}

/** The ring: the most used window's share, and how it reads (75 % warns, 95 % is full). */
export function ringOf(windows: UsageWindow[]): { state: RingState; pct: number } {
  if (!windows.length) return { state: "none", pct: 0 };
  const pct = Math.max(0, Math.min(100, Math.max(...windows.map((w) => w.usedPct))));
  return { state: pct >= 95 ? "full" : pct >= 75 ? "warn" : "ok", pct };
}

/** "980", "12.3k", "1.2M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "Resets in 1 h 17 min", "Resets in 6 days", or the CLI's own words ("Resets Oct 10 at 3:59am"). */
export function resetLabel(w: UsageWindow, now = Date.now()): string | null {
  if (w.resetsAt) {
    const min = Math.max(0, Math.round((w.resetsAt - now) / 60_000));
    if (min < 60) return `Resets in ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Resets in ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
    const d = Math.round(h / 24);
    return `Resets in ${d} ${d === 1 ? "day" : "days"}`;
  }
  return w.resetText ? `Resets ${w.resetText}` : null;
}

/** "Used 5%" */
export const usedLabel = (w: UsageWindow) => `${Math.round(w.usedPct)}% used`;

/** A chat's tokens so far, plus a turn's. */
export const addTokens = (a: TokenUsage | undefined, b: TokenUsage): TokenUsage => ({ input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output });
