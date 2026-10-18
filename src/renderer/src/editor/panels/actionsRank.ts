/**
 * How Actions (⌘K) ranks what it finds (Atlas 03 §9.1, §9.2): a weighted score — how well the text matches 0.4,
 * whether the action can run now 0.3, how often and lately it was run (frecency) 0.2, an AI action 0.1 — then the
 * ones that can run first. The match is the better of a fuzzy match on the label (the query's letters in order,
 * divided by the label's own perfect score) and a substring match (on the label and its other wording: the English
 * label under Turkish). Figma's matchers' own scores weren't read (Atlas 03 open question 7): these are ours, in their
 * shape. Frecency is Figma's: per action (its label cut to 20), the last 10 runs and a count; a run scores 100 within
 * half an hour … 0 after 90 days; an action's frecency is its count × its runs' mean score; 5 000 actions at most.
 * Clicked open with nothing typed, Actions lists every action by Figma's popularity order.
 */
import { COMMANDS_OF_ACTION } from "../shortcuts/figmaKeys";

/** Atlas 03 §9.1: the weights (they sum to 1). */
export const RANK_WEIGHTS = { match: 0.4, enabled: 0.3, frecency: 0.2, ai: 0.1 } as const;

const wordStart = (s: string, i: number) => i === 0 || /[\s/(▸\-_.…]/.test(s[i - 1]);

/**
 * The fuzzy matcher: the query's letters found in order — one at a word's start 3, right after the last matched 4, any
 * other 0 (found, but no evidence: "sel" in "Same fill" is barely a match).
 */
function fuzzyRaw(text: string, query: string): number {
  const s = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let at = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = s.indexOf(ch, at + 1);
    if (i < 0) return 0;
    score += i === at + 1 && at >= 0 ? 4 : wordStart(s, i) ? 3 : 0;
    at = i;
  }
  return score;
}

/** A label's own perfect score (Figma caches them, 1 000 at most). */
const perfect = new Map<string, number>();
function perfectOf(text: string): number {
  let p = perfect.get(text);
  if (p === undefined) {
    p = fuzzyRaw(text, text) || 1;
    if (perfect.size >= 1000) perfect.delete(perfect.keys().next().value!);
    perfect.set(text, p);
  }
  return p;
}

/** 0…1: the query's letters in order through the label. */
export const fuzzyScore = (text: string, query: string): number => fuzzyRaw(text, query) / perfectOf(text);

/** 0…1: the query inside the text — its share of the text, halved when it starts mid-word. */
export function substringScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return 0;
  return (q.length / text.length) * (wordStart(text, i) ? 1 : 0.5);
}

/** How well a label (and its other wordings) answers a query: the better matcher's. */
export const matchScore = (label: string, query: string, synonyms: readonly string[] = []): number =>
  Math.max(fuzzyScore(label, query), substringScore(label, query), ...synonyms.map((s) => Math.max(fuzzyScore(s, query), substringScore(s, query))));

/** The weighted score (Atlas 03 §9.1). */
export function rankScore(r: { match: number; enabled: boolean; frecency: number; ai: boolean }): number {
  return RANK_WEIGHTS.match * r.match + RANK_WEIGHTS.enabled * (r.enabled ? 1 : 0) + RANK_WEIGHTS.frecency * (r.frecency / (r.frecency + 1000)) + RANK_WEIGHTS.ai * (r.ai ? 1 : 0);
}

// ---- Frecency (Atlas 03 §9.2) ----

interface Runs {
  /** Newest first, 10 at most */
  timestamps: number[];
  count: number;
}
export type FrecencyHistory = Record<string, Runs>;

const FRECENCY_KEY = "designer.actions.frecency";
const MAX_TIMESTAMPS = 10;
const MAX_ACTIONS = 5000;
const HOUR = 3_600_000;

/** An action's key: its label cut to 20 characters (Figma's). */
export const frecencyKey = (label: string) => label.slice(0, 20);

/** One run's score by its age: < ½ h 100, < 4 h 70, < 1 day 50, < 7 days 30, < 30 days 20, < 90 days 10, older 0. */
export function bucketScore(age: number): number {
  if (age < HOUR / 2) return 100;
  if (age < 4 * HOUR) return 70;
  if (age < 24 * HOUR) return 50;
  if (age < 7 * 24 * HOUR) return 30;
  if (age < 30 * 24 * HOUR) return 20;
  if (age < 90 * 24 * HOUR) return 10;
  return 0;
}

/** An action's frecency: its count × its runs' mean score. */
export function frecencyOf(history: FrecencyHistory, label: string, now: number): number {
  const r = history[frecencyKey(label)];
  if (!r?.timestamps.length) return 0;
  return r.count * (r.timestamps.reduce((sum, t) => sum + bucketScore(now - t), 0) / r.timestamps.length);
}

/** The history with one more run of an action (the least recently run dropped past 5 000). */
export function withRun(history: FrecencyHistory, label: string, now: number): FrecencyHistory {
  const key = frecencyKey(label);
  const was = history[key];
  const next: FrecencyHistory = { ...history, [key]: { timestamps: [now, ...(was?.timestamps ?? [])].slice(0, MAX_TIMESTAMPS), count: (was?.count ?? 0) + 1 } };
  const keys = Object.keys(next);
  if (keys.length > MAX_ACTIONS) {
    keys.sort((a, b) => (next[a].timestamps[0] ?? 0) - (next[b].timestamps[0] ?? 0));
    for (const k of keys.slice(0, keys.length - MAX_ACTIONS)) delete next[k];
  }
  return next;
}

export function loadFrecency(): FrecencyHistory {
  try {
    const raw = localStorage.getItem(FRECENCY_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!v || typeof v !== "object") return {};
    const out: FrecencyHistory = {};
    for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
      const runs = r as Partial<Runs> | null;
      if (runs && Array.isArray(runs.timestamps) && typeof runs.count === "number")
        out[k] = { timestamps: runs.timestamps.filter((t): t is number => typeof t === "number").slice(0, MAX_TIMESTAMPS), count: runs.count };
    }
    return out;
  } catch {
    return {};
  }
}

/** A run from Actions remembered (kept per machine). */
export function rememberRun(label: string, now = Date.now()): void {
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(withRun(loadFrecency(), label, now)));
  } catch {
    // Private mode or a full store: no frecency.
  }
}

// ---- Popularity (Atlas 03 §9.2: the unsearched list) ----

/** Figma's popularity list's first 80 action ids (of 320; the score is 320 − its place). */
const POPULAR: readonly string[] = [
  "ungroup-selection", "group-selection", "create-section-from-selection", "replace-selected-frame-with-section", "convert-selected-nodes-to-frame",
  "bring-to-front", "send-to-back", "create-webpage", "detach-instance", "frame-selection", "create-symbol", "edit-code", "create-code-layer-from-design",
  "create-make-from-design", "restore-design-in-place-from-code", "copy-out-design-from-code", "flip-horizontal", "find-symbol", "publish-selection",
  "publish-changes-to-library", "copy-text", "mask-selection", "place", "send-backward", "paste-properties", "toggle-locked-for-selected-nodes",
  "copy-as-svg", "bring-forward", "flatten-selection", "outline-stroke", "toggle-ui", "copy-properties", "copy-as-png", "stack-selection",
  "run-multi-stack-auto-layout", "rename-selection", "flip-vertical", "find-inspiration", "inspect-fragment", "reset-symbol", "reset-fauxverride",
  "toggle-variables", "detach-deleted-variables", "reset-variable-modes", "export-all-frames-to-pdf", "export-slides-to-pdf", "export-selected-exportables",
  "export-selected-video", "export-selection-or-current-page", "enter-inspect-mode", "enter-design-mode", "enter-slides-mode", "enter-slides-design-mode",
  "unstack-selection", "open-preferences-modal", "copy-as-css", "copy-as-css-recursive", "toggle-shown-for-selected-nodes", "toggle-shown-layout-grids",
  "toggle-rulers", "toggle-stack-shadows", "toggle-dynamic-insertion-points", "toggle-auto-fill-full-width-children", "toggle-version-history",
  "publish-template", "convert-to-raster", "create-savepoint", "restore-symbol-or-state-group", "toggle-snapping-to-pixels", "open-account-settings",
  "toggle-menu", "push-changes-to-main", "show-nudge-amount-picker", "redo", "duplicate-in-place", "toggle-outlines", "toggle-outline-mode-hidden-layers",
  "toggle-outline-mode-object-bounds", "toggle-grid", "toggle-pixel-preview",
];

/** A command's popularity: 320 − its Figma action's place in the list, 0 when it isn't in the 80 read. */
export function popularity(command: string): number {
  for (let i = 0; i < POPULAR.length; i++) if (COMMANDS_OF_ACTION.get(POPULAR[i])?.includes(command)) return 320 - i;
  return 0;
}
