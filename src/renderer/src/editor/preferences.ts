/**
 * The Figma menu › Preferences (live menus/main-preferences.txt): the checks in live Figma's order with live Figma's
 * defaults, kept per machine (localStorage, like Nudge amount); four of them also go with the account, as Figma's user
 * record keeps them (atlas 21 §2, `ROAMING`), and the Accessibility settings dialog's own switches are kept beside them
 * (atlas 21 §4.1). The ones the canvas acts on reach the engine as view flags (canvasTools.ts viewOptionsOf →
 * Engine.setViewOptions): Snap to geometry / objects / pixel grid, Keep tool selected after use, Show dimensions on
 * objects, Flip objects while resizing, Keyboard zooms into selection, Invert zoom direction, Use scroll wheel zoom,
 * Right-click and drag to pan. Highlight layers on hover and Use number keys for opacity are the editor's own
 * (Layers.tsx, keyboard.ts); the rest are kept and shown checked as Figma has them (AI chat, agents, suggestions and
 * the desktop app's links aren't part of this app).
 */
import type { AccountPrefs, AccountProfile } from "@shared/account";
import { accountCall } from "../settings/bridge";
import type { EditorController } from "./controller";
import type { UIState } from "./uiStore";

export interface PreferenceDef {
  key: PreferenceKey;
  /** The command's id (commands.ts) */
  id: string;
  /** Figma's wording */
  label: string;
  /** Live Figma's default (a fresh account, main-preferences.txt's CHECKED rows) */
  on: boolean;
}

export type PreferenceKey =
  | "snapToGeometry"
  | "snapToObjects"
  | "snapToPixelGrid"
  | "keepToolSelected"
  | "highlightOnHover"
  | "renameDuplicatedLayers"
  | "showDimensions"
  | "hideCanvasUI"
  | "smartQuotes"
  | "flipWhileResizing"
  | "keyboardZoomsIntoSelection"
  | "invertZoom"
  | "ctrlClickMenus"
  | "numberKeysOpacity"
  | "oldOutlineShortcuts"
  | "rotateWithArrows"
  | "aiChatAudio"
  | "openLinksInDesktop"
  | "showTextSuggestions"
  | "showToolSuggestions"
  | "showAgents"
  | "scrollWheelZoom"
  | "rightDragPan"
  // Preferences › Accessibility settings… (AccessibilityDialog.tsx), not in the menu
  | "screenReader"
  | "actionsTabFocus"
  | "textInputShortcutBlocking"
  | "spotlightAutoFollow";

/** Live Figma's Preferences checks, in its order (the lines after Snap to pixel grid and Show Agents on canvas). */
export const PREFERENCES: readonly PreferenceDef[] = [
  { key: "snapToGeometry", id: "prefs.snap-to-geometry", label: "Snap to geometry", on: true },
  { key: "snapToObjects", id: "prefs.snap-to-objects", label: "Snap to objects", on: true },
  { key: "snapToPixelGrid", id: "view.snap-pixel-grid", label: "Snap to pixel grid", on: true },
  { key: "keepToolSelected", id: "prefs.keep-tool-selected", label: "Keep tool selected after use", on: false },
  { key: "highlightOnHover", id: "prefs.highlight-on-hover", label: "Highlight layers on hover", on: true },
  { key: "renameDuplicatedLayers", id: "prefs.rename-duplicated-layers", label: "Rename duplicated layers", on: true },
  { key: "showDimensions", id: "prefs.show-dimensions", label: "Show dimensions on objects", on: true },
  { key: "hideCanvasUI", id: "prefs.hide-canvas-ui", label: "Hide canvas UI during changes", on: true },
  { key: "smartQuotes", id: "prefs.smart-quotes", label: "Use smart quotes/symbols", on: true },
  { key: "flipWhileResizing", id: "prefs.flip-while-resizing", label: "Flip objects while resizing", on: true },
  { key: "keyboardZoomsIntoSelection", id: "prefs.keyboard-zooms-into-selection", label: "Keyboard zooms into selection", on: false },
  { key: "invertZoom", id: "prefs.invert-zoom", label: "Invert zoom direction", on: false },
  { key: "ctrlClickMenus", id: "prefs.ctrl-click-menus", label: "Ctrl+click opens right click menus", on: false },
  { key: "numberKeysOpacity", id: "prefs.number-keys-opacity", label: "Use number keys for opacity", on: true },
  { key: "oldOutlineShortcuts", id: "prefs.old-outline-shortcuts", label: "Use old shortcuts for outlines", on: false },
  { key: "rotateWithArrows", id: "prefs.rotate-with-arrows", label: "Use ⌘⌥↑/↓ to rotate layers", on: false },
  { key: "aiChatAudio", id: "prefs.ai-chat-audio", label: "Play audio notifications in AI chat", on: true },
  { key: "openLinksInDesktop", id: "prefs.open-links-in-desktop", label: "Open links in desktop app", on: true },
  { key: "showTextSuggestions", id: "prefs.show-text-suggestions", label: "Show text suggestions", on: true },
  { key: "showToolSuggestions", id: "prefs.show-tool-suggestions", label: "Show tool suggestions", on: true },
  { key: "showAgents", id: "prefs.show-agents", label: "Show Agents on canvas", on: true },
  { key: "scrollWheelZoom", id: "prefs.scroll-wheel-zoom", label: "Use scroll wheel zoom", on: false },
  // Figma's code default is off (atlas 21 §3, `rightClickPan`: C); the live capture's check was the owner's own choice.
  { key: "rightDragPan", id: "prefs.right-drag-pan", label: "Right-click and drag to pan", on: false },
];

/**
 * The Accessibility settings dialog's switches that are the editor's (atlas 21 §4.1; Underline links and Enhanced
 * contrast are the whole app's — ds/theme.ts — and Rotation shortcuts is Preferences' `rotateWithArrows`). Defaults:
 * Figma's code for the screen reader and text-input shortcut blocking (off); Tab in the Actions menu off (inferred);
 * spotlight auto-follow wasn't read in the build — on, unverified (atlas 21 §12).
 */
export const ACCESSIBILITY_PREFERENCES: readonly { key: PreferenceKey; on: boolean }[] = [
  { key: "screenReader", on: false },
  { key: "actionsTabFocus", on: false },
  { key: "textInputShortcutBlocking", on: false },
  { key: "spotlightAutoFollow", on: true },
];

const DEFAULTS = new Map<PreferenceKey, boolean>([...PREFERENCES, ...ACCESSIBILITY_PREFERENCES].map((p) => [p.key, p.on]));

/** A preference's value as the UI holds it (unset: Figma's default). */
export function pref(ui: Pick<UIState, PreferenceKey>, key: PreferenceKey): boolean {
  return ui[key] ?? DEFAULTS.get(key)!;
}

export const STORAGE_KEY = "designer.preferences";

/**
 * The store's version: 2 since 2026-10-18, when Right-click and drag to pan's default turned off. A store from before
 * (or, without one, a machine the editor already ran on: another `designer` key) had it on by default: that is written
 * down as the user's own choice, so nobody's canvas changes under them.
 */
const VERSION = 2;

/** A stored blob brought to this version: the values to keep, and whether it changed. */
export function migratePreferences(saved: Record<string, unknown> | null, usedBefore: boolean): { values: Record<string, unknown>; changed: boolean } {
  const values = { ...(saved ?? {}) };
  if (values.v === VERSION) return { values, changed: false };
  if ((saved || usedBefore) && typeof values.rightDragPan !== "boolean") values.rightDragPan = true;
  values.v = VERSION;
  return { values, changed: true };
}

/**
 * Another of the app's keys on this machine: the app ran here before the version-2 store. Not the browser build's
 * stand-in workspace (`designer.devStore.*`): Home writes it before any editor opens.
 */
function usedBefore(): boolean {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k !== STORAGE_KEY && !k.startsWith("designer.devStore.") && (k.startsWith("designer.") || k.startsWith("designer-"))) return true;
  }
  return false;
}

function readStore(): Record<string, unknown> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The preferences this machine keeps (only valid booleans; a broken or missing store reads as Figma's defaults). */
export function loadPreferences(): Partial<Record<PreferenceKey, boolean>> {
  try {
    if (typeof localStorage === "undefined") return {};
    const saved = readStore();
    const { values, changed } = migratePreferences(saved, !saved && usedBefore());
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    const out: Partial<Record<PreferenceKey, boolean>> = {};
    for (const key of DEFAULTS.keys()) if (typeof values[key] === "boolean") out[key] = values[key] as boolean;
    return out;
  } catch {
    return {};
  }
}

/** The one key the user set, beside the others kept (what the account handed over stays the account's). */
function savePreference(key: PreferenceKey, on: boolean): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStore(), [key]: on, v: VERSION }));
  } catch {
    // Private mode or a full store: the change holds for this session.
  }
}

// ---- With the account (atlas 21 §2) ----

type RoamingField = "numberKeysOpacity" | "scrollWheelZoom" | "rightDragPan" | "screenReader";

/**
 * What Figma keeps on the user record, by its `AccountPrefs` name: Use number keys for opacity
 * (`use_numbers_for_opacity`, the account's alone), Use scroll wheel zoom, Right-click and drag to pan and the screen
 * reader (`mouse_scroll_to_zoom`, `right_click_drag_to_pan`, `screenreader_enabled`: this machine's value first).
 */
export const ROAMING: readonly { key: PreferenceKey; field: RoamingField; accountOnly?: boolean }[] = [
  { key: "numberKeysOpacity", field: "numberKeysOpacity", accountOnly: true },
  { key: "scrollWheelZoom", field: "scrollWheelZoom" },
  { key: "rightDragPan", field: "rightDragPan" },
  { key: "screenReader", field: "screenReader" },
];

/** How the editor reaches the account (settings/bridge.ts; a test's stand-in). */
export type AccountCall = <T>(method: "GET" | "PATCH", path: string, body?: unknown) => Promise<T>;
let account: AccountCall = (method, path, body) => accountCall(method, path, body);
export function setPreferencesAccount(call: AccountCall): void {
  account = call;
}

/**
 * Figma's two layers (atlas 21 §2, `v(e,t=!1)`): this machine's value, else the account's, else the default — and the
 * account told when it holds something else. The account-only one is the account's whenever it has one.
 */
export function reconcileRoaming(local: Partial<Record<PreferenceKey, boolean>>, theirs: AccountPrefs): { adopt: Partial<Record<PreferenceKey, boolean>>; push: AccountPrefs } {
  const adopt: Partial<Record<PreferenceKey, boolean>> = {};
  const push: AccountPrefs = {};
  for (const r of ROAMING) {
    const held = typeof theirs[r.field] === "boolean" ? theirs[r.field] : undefined;
    if (r.accountOnly) {
      // The account's when it has one; else what this machine kept before it roamed is handed over (Figma writes it
      // only on a change: an untouched default stays unwritten).
      if (held !== undefined && local[r.key] !== held) adopt[r.key] = held;
      else if (held === undefined && local[r.key] !== undefined) push[r.field] = local[r.key];
      continue;
    }
    const value = local[r.key] ?? held ?? DEFAULTS.get(r.key)!;
    if (local[r.key] === undefined && held !== undefined) adopt[r.key] = held;
    if (held !== value) push[r.field] = value;
  }
  return { adopt, push };
}

/** Once the editor is up: the account's preferences taken in, this machine's handed back. Signed out (or a server that
 *  drops the fields): nothing changes. */
export async function syncRoamingPreferences(ed: EditorController): Promise<void> {
  let theirs: AccountPrefs;
  try {
    theirs = (await account<AccountProfile>("GET", "/me/profile")).prefs ?? {};
  } catch {
    return;
  }
  const { adopt, push } = reconcileRoaming(loadPreferences(), theirs);
  if (Object.keys(adopt).length) ed.ui.set(adopt as Partial<UIState>);
  if (Object.keys(push).length) await account("PATCH", "/me/profile", { prefs: push }).catch(() => {});
}

/** Figma tells the machine's other tabs (`sendToOtherTabs`); here each file tab is a page, and `storage` brings a
 *  change made in another one. */
export function followOtherTabs(ed: EditorController): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    const ui = ed.ui.get();
    const patch: Partial<Record<PreferenceKey, boolean>> = {};
    for (const [key, value] of Object.entries(loadPreferences()) as [PreferenceKey, boolean][]) if (ui[key] !== value) patch[key] = value;
    if (Object.keys(patch).length) ed.ui.set(patch as Partial<UIState>);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Sets a preference (the view flags follow through canvasTools' UI subscription) and keeps it, with the account too. */
export function setPreference(ed: EditorController, key: PreferenceKey, on: boolean): void {
  ed.ui.set({ [key]: on } as Partial<UIState>);
  savePreference(key, on);
  const roams = ROAMING.find((r) => r.key === key);
  if (roams) void account("PATCH", "/me/profile", { prefs: { [roams.field]: on } }).catch(() => {});
}

/** Turns a preference over. */
export function togglePreference(ed: EditorController, key: PreferenceKey): void {
  setPreference(ed, key, !pref(ed.ui.get(), key));
}
