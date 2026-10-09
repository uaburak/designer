// The composer's model and effort menus (Claude's desktop composer: "Opus 5.5", "High"), the usage ring, and a chat's
// sessions: only connected agents, grouped under their names; short model names; Antigravity's effort split from its
// slugs, Claude Code's from its flag; a chat continues an agent's own session only while no other agent answered since.
import { describe, expect, it } from "vitest";
import type { ProviderInfo, UsageInfo } from "@shared/agents/types";
import { mergeUsage, sessionOf, type Chat } from "../agents/service";
import { currentOf, effortMenu, modelMenu, modelOptions, pickModel, shortModelName } from "../agents/models";
import { addTokens, formatTokens, relevantWindows, resetLabel, ringOf } from "../agents/usage";

const p = (id: string, label: string, available: boolean, models: string[], more: Partial<ProviderInfo> = {}): ProviderInfo => ({ id, kind: id === "ollama" ? "openai-compatible" : (id as ProviderInfo["kind"]), label, available, models, ...more });

const AGY_LABELS = {
  "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
  "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
  "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
  "claude-opus-5-5-high": "Claude Opus 5.5 (High)",
  "claude-opus-5-5-medium": "Claude Opus 5.5 (Medium)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
};
// As `agy models` lists them, its default first.
const agy = p("antigravity", "Antigravity (Google AI)", true, ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "claude-opus-5-5-high", "claude-opus-5-5-medium", "gpt-oss-120b-medium"], { modelLabels: AGY_LABELS });
const claude = p("claude-code", "Claude Code", true, ["default", "opus", "sonnet", "haiku"], { efforts: ["high", "low", "medium", "xhigh", "max"] });

describe("short model names", () => {
  it("drops the vendor from an agent's label and reads an id's version", () => {
    expect(shortModelName("Gemini 3.8 Flash")).toBe("3.8 Flash");
    expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortModelName("GPT-OSS 120B")).toBe("GPT-OSS 120B");
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("claude-sonnet-5-5-20261001")).toBe("Sonnet 5.5");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(shortModelName("gemini-3.1-pro")).toBe("3.1 Pro");
    expect(shortModelName("qwen2.5-coder-14b")).toBe("qwen2.5-coder-14b");
  });
});

describe("the model menu", () => {
  it("lists the connected agents only, each as a heading over its models' short names", () => {
    const menu = modelMenu([claude, p("codex", "Codex", false, ["default"]), agy, p("ollama", "Ollama", true, ["qwen3"])]);
    expect(menu).toEqual([
      { header: "Claude Code" },
      { value: "claude-code\u0000default", label: "Default" },
      { value: "claude-code\u0000opus", label: "Opus" },
      { value: "claude-code\u0000sonnet", label: "Sonnet" },
      { value: "claude-code\u0000haiku", label: "Haiku" },
      { header: "Antigravity (Google AI)" },
      { value: "antigravity\u0000gemini-3.8-flash", label: "3.8 Flash" },
      { value: "antigravity\u0000gemini-3.1-pro", label: "3.1 Pro" },
      { value: "antigravity\u0000claude-opus-5-5", label: "Opus 5.5" },
      { value: "antigravity\u0000gpt-oss-120b", label: "GPT-OSS 120B" },
      { header: "Ollama" },
      { value: "ollama\u0000qwen3", label: "qwen3" },
    ]);
  });

  it("names Claude Code's aliases by the models they ran as", () => {
    const labels = modelOptions(claude, { "claude-code": { default: "claude-fable-1-0", opus: "claude-opus-5-5-20261001" } }).map((o) => o.label);
    expect(labels).toEqual(["Fable 1.0", "Opus 5.5", "Sonnet", "Haiku"]);
  });

  it("splits Antigravity's slugs into a model and its efforts (Low, Medium, High in order; only the ones it has)", () => {
    const [flash, pro, opus, oss] = modelOptions(agy);
    expect(flash.efforts.map((e) => [e.label, e.model])).toEqual([
      ["Low", "gemini-3.8-flash-low"],
      ["Medium", "gemini-3.8-flash-medium"],
      ["High", "gemini-3.8-flash-high"],
    ]);
    expect(pro.efforts.map((e) => e.label)).toEqual(["Low", "High"]);
    expect(opus.efforts.map((e) => e.label)).toEqual(["Medium", "High"]);
    expect(oss.efforts.map((e) => e.label)).toEqual(["Medium"]);
    expect(currentOf(agy, "gemini-3.1-pro-high", undefined)).toMatchObject({ option: { key: "gemini-3.1-pro", label: "3.1 Pro" }, effort: { id: "high" } });
    // No model picked yet: the agent's default slug.
    expect(currentOf(agy, undefined, undefined)).toMatchObject({ option: { label: "3.8 Flash" }, effort: { id: "medium" } });
  });

  it("keeps the effort when switching models when the new one has it, else the agent's default for it", () => {
    expect(pickModel(agy, "gemini-3.1-pro", "high")).toEqual({ model: "gemini-3.1-pro-high", effort: "high" });
    // 3.1 Pro has no Medium: its first (Low).
    expect(pickModel(agy, "gemini-3.1-pro", "medium")).toEqual({ model: "gemini-3.1-pro-low", effort: "low" });
    expect(pickModel(agy, "gemini-3.8-flash", "max")).toEqual({ model: "gemini-3.8-flash-medium", effort: "medium" });
    expect(pickModel(claude, "opus", "low")).toEqual({ model: "opus", effort: "low" });
    expect(pickModel(claude, "haiku", undefined)).toEqual({ model: "haiku", effort: "high" });
  });

  it("offers Claude Code's --effort levels, its default (High) when none was picked; none for an agent without", () => {
    const { option, effort } = currentOf(claude, "opus", undefined);
    expect(effortMenu(option).map((o) => o.label)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    expect(effort?.label).toBe("High");
    expect(currentOf(claude, "opus", "max").effort?.label).toBe("Max");
    expect(effortMenu(currentOf(p("cursor-agent", "Cursor Agent", true, ["auto"]), "auto", undefined).option)).toEqual([]);
    expect(effortMenu(currentOf(p("ollama", "Ollama", true, ["qwen3"]), "qwen3", undefined).option)).toEqual([]);
  });
});

describe("the usage ring", () => {
  const agyUsage: UsageInfo = {
    providerId: "antigravity",
    at: 0,
    windows: [
      { label: "Weekly limit", group: "Gemini Models", usedPct: 0.5 },
      { label: "5-hour limit", group: "Gemini Models", usedPct: 5.4 },
      { label: "Weekly limit", group: "Claude and GPT models", usedPct: 80 },
    ],
  };

  it("reads the most used limit of the model's group: ok, warn from 75 %, full from 95 %; none without limits", () => {
    expect(ringOf(relevantWindows(agyUsage, "gemini-3.8-flash-medium"))).toEqual({ state: "ok", pct: 5.4 });
    expect(ringOf(relevantWindows(agyUsage, "claude-opus-5-5-high"))).toEqual({ state: "warn", pct: 80 });
    expect(ringOf([{ label: "Current session", usedPct: 97 }]).state).toBe("full");
    expect(ringOf(relevantWindows(null))).toEqual({ state: "none", pct: 0 });
  });

  it("says when a limit resets and counts the chat's tokens", () => {
    expect(resetLabel({ label: "5-hour limit", usedPct: 5, resetsAt: 77 * 60_000 }, 0)).toBe("Resets in 1 h 17 min");
    expect(resetLabel({ label: "Weekly limit", usedPct: 1, resetsAt: 6.9 * 24 * 3_600_000 }, 0)).toBe("Resets in 7 days");
    expect(resetLabel({ label: "Current session", usedPct: 5, resetText: "Oct 10 at 3:59am" })).toBe("Resets Oct 10 at 3:59am");
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(31_981)).toBe("32k");
    expect(formatTokens(2_345)).toBe("2.3k");
    expect(addTokens(addTokens(undefined, { input: 100, output: 20 }), { input: 5, output: 1 })).toEqual({ input: 105, output: 21 });
  });

  it("puts a turn's limits over the last read, keeping the windows it didn't mention", () => {
    const had: UsageInfo = { providerId: "claude-code", at: 0, windows: [{ label: "Current session", usedPct: 5 }, { label: "Current week (Fable)", usedPct: 66 }] };
    expect(mergeUsage(had, { providerId: "claude-code", at: 1, windows: [{ label: "Current session", usedPct: 11 }] }).windows).toEqual([{ label: "Current session", usedPct: 11 }, { label: "Current week (Fable)", usedPct: 66 }]);
  });
});

describe("a chat's sessions", () => {
  const chat = (over: Partial<Chat>): Chat => ({ id: "c", title: "t", updatedAt: 0, providerId: "claude-code", messages: [], ...over });
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant" }));

  it("continues an agent's own session while nothing else happened since its turn", () => {
    expect(sessionOf(chat({ messages: msgs(2), sessions: { "claude-code": { id: "s1", upTo: 2 } } }), "claude-code")).toBe("s1");
    // Antigravity answered after it: Claude Code starts a new session with the conversation so far.
    expect(sessionOf(chat({ messages: msgs(4), sessions: { "claude-code": { id: "s1", upTo: 2 }, antigravity: { id: "g1", upTo: 4 } } }), "claude-code")).toBeUndefined();
    expect(sessionOf(chat({ messages: msgs(4), sessions: { "claude-code": { id: "s1", upTo: 2 }, antigravity: { id: "g1", upTo: 4 } } }), "antigravity")).toBe("g1");
    expect(sessionOf(chat({ messages: msgs(2) }), "codex")).toBeUndefined();
  });
});
