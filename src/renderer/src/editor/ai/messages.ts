/**
 * How the AI actions say what went wrong (docs/ai.md §8.1 `AiErrorCode`), in Figma's voice: short, what happened and
 * what to do. Figma's own strings for most of these aren't published [unverified]; over-limit keeps main's sentence
 * (it names the reset date). The editor's own refusals (nothing to act on, missing fonts) are here too.
 */
import type { AiErrorCode } from "@shared/ai/types";

export type AiProblem = AiErrorCode | "nothing-selected" | "missing-fonts" | "busy" | "apply";

export const AI_MESSAGES: Record<AiProblem, string> = {
  "no-provider": "Connect an AI provider in Settings › AI to use AI features.",
  "signed-out": "You're signed out of your AI provider. Sign in and try again.",
  "rate-limited": "Too many requests right now. Try again in a moment.",
  refused: "This request can't be completed. Try rephrasing it.",
  "bad-output": "Something went wrong. Try again.",
  network: "Couldn't connect to your AI provider. Check your connection and try again.",
  timeout: "This is taking longer than expected. Try again.",
  cancelled: "Stopped.",
  disabled: "AI features are turned off. Turn them on in Settings › AI.",
  "over-limit": "You've used all your AI credits for this month.",
  "too-large": "Your selection is too large. Try selecting fewer layers.",
  unsupported: "This AI provider can't do this. Pick another one in Settings › AI.",
  "no-model": "Pick a model for your AI provider in Settings › AI.",
  "nothing-selected": "Select something first.",
  "missing-fonts": "Some text layers use missing fonts. Replace the missing fonts to edit them.",
  busy: "Finish what you're doing on the canvas, then try again.",
  apply: "The changes couldn't be applied.",
};

/** The message for a failure: main's own words for over-limit and refusals, ours otherwise. */
export function aiMessage(code: AiProblem, own?: string): string {
  if ((code === "over-limit" || code === "nothing-selected") && own) return own;
  return AI_MESSAGES[code];
}
