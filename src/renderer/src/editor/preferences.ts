/**
 * The Figma menu › Preferences (live menus/main-preferences.txt): the checks in live Figma's order with live Figma's
 * defaults, kept per machine (localStorage, like Nudge amount). The ones the canvas acts on reach the engine as view
 * flags (canvasTools.ts viewOptionsOf → Engine.setViewOptions): Snap to geometry / objects / pixel grid, Keep tool
 * selected after use, Show dimensions on objects, Flip objects while resizing, Keyboard zooms into selection, Invert
 * zoom direction, Use scroll wheel zoom, Right-click and drag to pan. Highlight layers on hover and Use number keys
 * for opacity are the editor's own (Layers.tsx, keyboard.ts); the rest are kept and shown checked as Figma has them
 * (AI chat, agents, suggestions and the desktop app's links aren't part of this app).
 */
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
  | "rightDragPan";

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
  { key: "rightDragPan", id: "prefs.right-drag-pan", label: "Right-click and drag to pan", on: true },
];

const BY_KEY = new Map(PREFERENCES.map((p) => [p.key, p]));

/** A preference's value as the UI holds it (unset: Figma's default). */
export function pref(ui: Pick<UIState, PreferenceKey>, key: PreferenceKey): boolean {
  return ui[key] ?? BY_KEY.get(key)!.on;
}

const STORAGE_KEY = "designer.preferences";

/** The preferences this machine keeps (only valid booleans; a broken or missing store reads as Figma's defaults). */
export function loadPreferences(): Partial<Record<PreferenceKey, boolean>> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<PreferenceKey, boolean>> = {};
    for (const p of PREFERENCES) if (typeof saved[p.key] === "boolean") out[p.key] = saved[p.key] as boolean;
    return out;
  } catch {
    return {};
  }
}

function savePreferences(ui: Pick<UIState, PreferenceKey>): void {
  const out: Partial<Record<PreferenceKey, boolean>> = {};
  for (const p of PREFERENCES) if (ui[p.key] !== undefined) out[p.key] = ui[p.key];
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Private mode or a full store: the change holds for this session.
  }
}

/** Sets a preference (the view flags follow through canvasTools' UI subscription) and keeps it. */
export function setPreference(ed: EditorController, key: PreferenceKey, on: boolean): void {
  ed.ui.set({ [key]: on } as Partial<UIState>);
  savePreferences(ed.ui.get());
}

/** Turns a preference over. */
export function togglePreference(ed: EditorController, key: PreferenceKey): void {
  setPreference(ed, key, !pref(ed.ui.get(), key));
}
