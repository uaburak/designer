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
import { COMMANDS_OF_ACTION, FIGMA_ACTION } from "../shortcuts/figmaKeys";

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

/** Figma's popularity list (320 action ids, `3653.min.js` / `1540.min.js`; the score is 320 − its place). */
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
  "toggle-show-artboard-outlines", "collapse-layers", "toggle-show-slices", "toggle-show-comments", "toggle-show-annotations",
  "set-tool-default-figjam", "detach-deleted-styles", "select-same-style", "select-same-fill", "open-shortcuts", "toggle-resource-use",
  "toggle-memory-usage-indicator", "select-same-font", "select-same-text", "select-same-instance", "select-same-variant",
  "toggle-multiplayer-cursors", "toggle-show-masks", "select-all", "zoom-reset", "round-to-pixels", "toggle-navbar", "toggle-sidebar",
  "open-font-settings", "toggle-snapping-to-geometry", "toggle-snapping-to-objects", "zoom-to-fit", "pack-vertical", "open-help",
  "live-boolean-subtract", "back-to-files", "toggle-layers", "text-upper-case", "set-default-style", "toggle-keyboard-zoom-to-selection",
  "crop-image", "pack-horizontal", "open-tutorials", "live-boolean-union", "text-original-case", "toggle-bold", "rotate-90-counterclockwise",
  "zoom-to-selection", "toggle-invert-zoom", "rotate-180", "toggle-sticky-tools", "select-same-stroke", "text-toggle-underline", "unlock-all",
  "detach-all-instances", "distribute-horizontal-spacing", "text-font-size-increase", "align-horizontal-center", "select-all-text",
  "toggle-google-fonts", "set-tool-frame", "toggle-viewport-overlay-hiding", "tidy-up", "delete-and-heal-selection", "align-vertical-center",
  "rotate-90-clockwise", "text-lower-case", "toggle-publish", "toggle-layer-hover", "toggle-flip-during-resize", "select-inverse",
  "text-toggle-strikethrough", "align-left", "distribute-vertical-spacing", "text-toggle-italic", "select-same-effect", "toggle-annotations",
  "live-boolean-intersect", "set-tool-arrow", "swap-fill-and-stroke", "open-release-notes", "page-next", "resize-to-fit", "text-font-size-decrease",
  "align-top", "live-boolean-xor", "add-transform-modifier-to-selection", "set-tool-slice", "join-selection", "toggle-copy-renaming",
  "page-previous", "remove-fill", "remove-interactions-on-selection", "toggle-library", "previous-artboard", "republish-selected-components",
  "open-legal-summary", "smooth-join-selection", "distribute-horizontal-center", "set-tool-comments", "toggle-smart-quotes",
  "toggle-smart-text-substitution", "align-bottom", "set-tool-type", "set-tool-text-path", "focus-mode", "focus-mode-exit", "canvas-search",
  "canvas-search-next", "canvas-search-prev", "canvas-search-replace", "next-artboard-same-zoom", "next-artboard", "align-right",
  "text-line-height-increase", "text-bold-increase", "remove-stroke", "unhide-all", "set-tool-rectangle", "text-letter-spacing-increase",
  "distribute-vertical-center", "text-align-center", "text-line-height-decrease", "set-tool-line", "distribute-left", "text-letter-spacing-decrease",
  "text-bold-decrease", "toggle-help-widget", "hide-sibling-layers", "set-tool-star", "text-align-justified", "text-align-left", "distribute-bottom",
  "toggle-frame-clipping", "distribute-top", "text-align-middle", "distribute-right", "text-align-top", "open-support-forum", "set-tool-hand",
  "set-tool-regular-polygon", "text-align-right", "set-tool-pen", "text-align-bottom", "set-tool-pencil", "toggle-perf-hud",
  "toggle-fake-mp-activity", "toggle-tsmer-config", "set-tool-sticky", "paste-to-replace", "set-tool-paint-bucket", "set-tool-vector-lasso",
  "set-tool-offset-path", "set-tool-connector-elbowed", "set-tool-connector-straight", "set-tool-bend", "set-tool-cut",
  "set-tool-shape-whiteboard-ellipse", "set-tool-shape-whiteboard-rounded-rectangle", "set-tool-shape-whiteboard-diamond",
  "set-tool-shape-whiteboard-triangle-down", "toggle-pen-tool-avoid-single-handles", "select-next-sibling", "select-child", "set-tool-ellipse",
  "select-parent", "set-opacity-0", "set-opacity-5", "set-opacity-1", "select-previous-sibling", "set-tool-shape-whiteboard-square",
  "set-tool-shape-whiteboard-triangle-up", "select-matching", "set-tool-washi-tape", "set-tool-table", "toggle-pressure-sensitivity",
  "toggle-automatic-variable-matching", "delete-selection", "deselect-all", "previous-artboard-same-zoom", "set-tool-default", "set-tool-scale",
  "show-inspect-panel", "show-design-panel", "show-prototype-panel", "toggle-prototyping-info", "toggle-dropper", "toggle-use-numbers-for-opacity",
  "undo", "zoom-in", "zoom-out", "copy-as-local-assets", "republish-auto-layout-components", "repair-selected-instances", "repair-motion-in-file",
  "repair-breakpoint-multiedit", "remove-responsive-text-style-variants", "repair-backing-component-set", "repair-state-group-versions",
  "repair-variable-connections", "reresolve-variable-references", "relink-instances-to-local-component", "repair-duplicate-subscribed-assets",
  "repair-keyless-state-groups", "restore-autolayout-position", "find-shared-instances-need-relinking", "regenerate-all-instances",
  "regenerate-selected-instances", "regenerate-file-geometry", "regenerate-missing-thumbnails", "backup-all-overrides", "text-relayout",
  "upgrade-stack-layout-version", "upgrade-stack-layout-version-for-page", "select-broken-fixed-scrolling-nodes", "toggle-show-guids",
  "debug-toggle-figma-scope", "debug-print-as-test-code", "debug-print-vector-network-as-test-code", "force-publish-state-group",
  "toggle-layers-dom-order", "toggle-canvas-search-debug", "toggle-accessibility-dom-debug", "purge-all-memory", "toggle-debug-layout-logs",
  "debug-incremental-loading-all-pages", "debug-incremental-loading-current-only", "toggle-debug-materializer-logs",
  "calculate-deleted-components-published-version", "text-set-directionality-ltr", "text-set-directionality-rtl", "text-set-directionality-ltr-qa",
  "text-set-directionality-rtl-qa", "text-upgrade-explicit-layout-version", "text-upgrade-to-bidi", "debug-inspect-layer-figma-scope",
  "set-image-as-profile-picture", "reset-transform", "plugins-menu-use-local-related-link-plugin", "debug-toggle-diagram-layout-paused",
  "add-platform-shape-definition", "remove-platform-shape-definition", "enter-staging-mode", "commit-staged-changes", "rollback-staged-changes",
];

/** A command's popularity: 320 − its Figma action's place in the list, 0 when it isn't in it. */
export function popularity(command: string): number {
  for (let i = 0; i < POPULAR.length; i++) if (COMMANDS_OF_ACTION.get(POPULAR[i])?.includes(command)) return 320 - i;
  return 0;
}

// ---- Search synonyms (Atlas 03 §9.1) ----

/**
 * Figma's `searchSynonyms`: other words an action is found by, matched as its label is and never shown (`HIDDEN`
 * matches). By Figma action id, as the build writes them beside their action (`3653.min.js`, `1540.min.js` …); only
 * those whose action is plain in the same definition — a synonym whose action the build names indirectly isn't taken.
 */
const SYNONYMS_BY_ACTION: Record<string, readonly string[]> = {
  "break-vector-network-into-paths": ["break"],
  "combine-text-path-layers": ["combine", "path", "text"],
  "detect-violations": ["check", "check designs", "detect", "detect issues", "detect violations", "find suggestions", "lint", "linter", "linting", "suggested actions", "suggestions"],
  "enter-design-mode": ["mode", "open"],
  "enter-draw-mode": ["mode", "open"],
  "enter-inspect-mode": ["mode", "open"],
  "separate-text-path-layers": ["separate", "text"],
  "set-tool-offset-path": ["offset", "path offset", "vector offset"],
  "set-tool-simplify-vector": ["path simplify", "simplify", "smooth", "vector simplify"],
  "start-ai-assistant": ["ai", "assistant", "chat", "prompt"],
  "toggle-show-comments": ["hide comments"],
};

/** The AI actions' synonyms (Figma's AI action types, `eo.JT.*`), by our Actions row. */
const SYNONYMS_BY_AI_ROW: Record<string, readonly string[]> = {
  "ai.rename-layers": ["name layers", "rename all layers"],
  "ai.replace-content": ["content fill", "fill content", "lorem ipsum", "replace duplicates", "rewrite duplicates", "rewrite placeholder text"],
  "ai.make-image": ["create image", "generate graphic", "generate illustration", "generate image", "generate picture", "make a picture"],
  "ai.add-interactions": ["add interactions", "add prototype connections", "add prototype links", "connect prototype", "magic link", "make prototype"],
  "ai.remove-background": ["clean up image", "clean up picture", "delete background", "eliminate background", "erase background", "isolate subject", "make transparent"],
  "ai.rewrite": ["adjust tone", "modify this", "revise this"],
  "ai.shorten": ["abbreviate", "condense", "make concise", "reduce", "shorter"],
  "ai.translate": ["change language"],
  "ai.boost-resolution": ["boost resolution", "crisp", "enhance clarity", "enlarge image", "improve image", "increase quality", "increase size", "reduce blur"],
};

/** The other words a command is found by in Actions (English, as Figma has them in every language). */
export function synonymsOf(command: string): readonly string[] {
  const action = FIGMA_ACTION[command];
  return SYNONYMS_BY_AI_ROW[command] ?? (action ? SYNONYMS_BY_ACTION[action] : undefined) ?? [];
}
