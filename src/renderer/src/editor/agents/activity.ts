/**
 * What a running turn is doing, in the chat's words — the "Thinking…" row under the answer while the agent works
 * (Figma AI's and Claude's shimmering line): its current step ("Reading the design…", "Making an image…"), the CLI's
 * own status while it starts ("Starting Antigravity…"), else "Thinking…"; the seconds it has taken, after 5 s.
 * Pure: the chat renders it, the tests read it.
 */
import type { ChatMessage } from "./service";

/** A step while it runs, in the present tense (its finished label is service.ts's toolLabel). */
const TOOL_ACTIVE: Record<string, string> = {
  get_selection: "Looking at the selection…",
  get_metadata: "Reading the layers…",
  get_design_context: "Reading the design…",
  get_screenshot: "Taking a screenshot…",
  get_variable_defs: "Reading variables and styles…",
  create_nodes: "Creating layers…",
  update_nodes: "Editing layers…",
  delete_nodes: "Deleting layers…",
  duplicate_nodes: "Duplicating layers…",
  reparent_nodes: "Moving layers…",
  set_auto_layout: "Setting auto layout…",
  apply_variable: "Applying a variable…",
  apply_style: "Applying a style…",
  create_responsive_variant: "Making a responsive version…",
  set_selection: "Selecting the result…",
  place_image: "Placing the image…",
  generate_image: "Making an image…",
};

export const toolActiveLabel = (name: string): string => {
  const known = TOOL_ACTIVE[name];
  if (known) return known;
  const words = name.replace(/_/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}…` : "Working…";
};

export const THINKING = "Thinking…";

/** The line a running answer shows, or null when the turn is over. */
export function activityOf(m: Pick<ChatMessage, "state" | "parts">): string | null {
  if (m.state !== "running") return null;
  const parts = m.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool" && p.state === "running") return toolActiveLabel(p.name);
  }
  // An image made but not on the canvas yet: the agent is about to place it.
  if (parts.some((p) => p.kind === "image" && p.state === "ready")) return TOOL_ACTIVE.place_image;
  const status = parts.find((p) => p.kind === "status");
  if (status && status.kind === "status" && parts.every((p) => p.kind === "status")) return status.text;
  return THINKING;
}

/** The seconds a turn has taken, shown from 5 s on ("12s", "1m 05s"); empty before that. */
export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const s = Math.floor((now - startedAt) / 1000);
  if (s < 5) return "";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The aspect (width / height) an image request asks for: `aspect_ratio` "16:9", or `width` / `height`; else square. */
export function requestedAspect(args: unknown): number {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const ratio = a.aspect_ratio ?? a.aspectRatio ?? a.AspectRatio;
  let r = 1;
  if (typeof ratio === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
    if (m && +m[2] > 0) r = +m[1] / +m[2];
  } else if (typeof ratio === "number" && ratio > 0) r = ratio;
  else if (typeof a.width === "number" && typeof a.height === "number" && a.width > 0 && a.height > 0) r = a.width / a.height;
  return Math.min(4, Math.max(0.25, r));
}
