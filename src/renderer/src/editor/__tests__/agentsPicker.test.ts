// The chat's agent picker and sessions: only connected agents, grouped under their names; a chat continues an agent's
// own session only while no other agent answered since.
import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@shared/agents/types";
import { pickerOptions, sessionOf, type Chat } from "../agents/service";

const p = (id: string, label: string, available: boolean, models: string[]): ProviderInfo => ({ id, kind: id === "ollama" ? "openai-compatible" : (id as ProviderInfo["kind"]), label, available, models });

describe("the agent picker", () => {
  it("lists the connected agents only, each under its heading with its models; the field names agent and model", () => {
    const options = pickerOptions([p("claude-code", "Claude Code", true, ["default", "haiku"]), p("codex", "Codex", false, ["default"]), p("gemini", "Antigravity / Gemini CLI", true, ["auto", "flash"]), p("ollama", "Ollama", true, ["qwen3"])]);
    expect(options).toEqual([
      { header: "Claude Code" },
      { value: "claude-code\u0000default", label: "Default", valueLabel: "Claude Code · Default" },
      { value: "claude-code\u0000haiku", label: "haiku", valueLabel: "Claude Code · haiku" },
      { header: "Antigravity / Gemini CLI" },
      { value: "gemini\u0000auto", label: "Auto", valueLabel: "Antigravity / Gemini CLI · Auto" },
      { value: "gemini\u0000flash", label: "flash", valueLabel: "Antigravity / Gemini CLI · flash" },
      { header: "Ollama" },
      { value: "ollama\u0000qwen3", label: "qwen3", valueLabel: "Ollama" },
    ]);
  });
});

describe("a chat's sessions", () => {
  const chat = (over: Partial<Chat>): Chat => ({ id: "c", title: "t", updatedAt: 0, providerId: "claude-code", messages: [], ...over });
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant" }));

  it("continues an agent's own session while nothing else happened since its turn", () => {
    expect(sessionOf(chat({ messages: msgs(2), sessions: { "claude-code": { id: "s1", upTo: 2 } } }), "claude-code")).toBe("s1");
    // Gemini answered after it: Claude Code starts a new session with the conversation so far.
    expect(sessionOf(chat({ messages: msgs(4), sessions: { "claude-code": { id: "s1", upTo: 2 }, gemini: { id: "g1", upTo: 4 } } }), "claude-code")).toBeUndefined();
    expect(sessionOf(chat({ messages: msgs(4), sessions: { "claude-code": { id: "s1", upTo: 2 }, gemini: { id: "g1", upTo: 4 } } }), "gemini")).toBe("g1");
    expect(sessionOf(chat({ messages: msgs(2) }), "codex")).toBeUndefined();
  });
});
