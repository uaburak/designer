/**
 * The AI actions' names as Figma's UI writes them (docs/ai.md §1: the Actions panel, the image toolbar), for
 * Settings › AI's per-action routes and the AI balance's usage history. "Agents" (our chat) and "Search" are ours.
 */
import type { AiAction } from "./types";

export const AI_ACTION_LABEL: Record<AiAction, string> = {
  "rename-layers": "Rename layers",
  rewrite: "Rewrite this...",
  translate: "Translate to...",
  shorten: "Shorten",
  "replace-content": "Replace content",
  "add-interactions": "Add interactions",
  "first-draft": "First Draft",
  "make-image": "Make an image",
  "edit-image": "Edit image with prompt",
  "remove-background": "Remove background",
  "boost-resolution": "Boost resolution",
  "expand-image": "Expand",
  "erase-object": "Erase",
  "isolate-object": "Isolate",
  vectorize: "Vectorize",
  "visual-search": "Visual search",
  search: "Search",
  agent: "Agents",
};

/** Actions that run on the text route (Settings › AI › Text), in the Actions panel's order */
export const AI_TEXT_ACTIONS: readonly AiAction[] = ["rename-layers", "rewrite", "shorten", "translate", "replace-content", "add-interactions", "first-draft"];
/** Actions that run on the image route (Settings › AI › Images) */
export const AI_IMAGE_ACTIONS: readonly AiAction[] = ["make-image", "edit-image", "expand-image"];
/** Image tools that run on this computer (docs/ai.md §2.6) */
export const AI_LOCAL_ACTIONS: readonly AiAction[] = ["remove-background", "boost-resolution", "erase-object", "isolate-object"];

/** "1,250" */
export const formatCredits = (n: number): string => (Math.round(n * 100) / 100).toLocaleString("en-US");
