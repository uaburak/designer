import { app } from "electron";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThemePreference } from "../shared/ipc";
import type { ClosedTab, TabRecord } from "../shared/tabs";
import { sanitizeShortcutSettings, type ShortcutSettings } from "../shared/shortcuts";

/**
 * What the app keeps in userData between launches (docs/desktop.md §4.4):
 * `session.json` — each window's place and its tabs — and `settings.json` —
 * the theme and the keyboard shortcuts (bindings changed, shortcuts used, layout). Written atomically (a temp file, fsync, rename), debounced
 * while running and at once on quit. The old `window.json` (place and
 * theme) is read once if there is no session yet.
 */

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowSession {
  id: string;
  bounds: WindowBounds;
  maximized: boolean;
  fullScreen: boolean;
  tabs: TabRecord[];
  activeTabId: string;
  closed: ClosedTab[];
}

export interface SessionFile {
  version: 1;
  windows: WindowSession[];
}

export interface Settings {
  theme: ThemePreference;
  /** The Keyboard shortcuts panel's (src/shared/shortcuts.ts); absent until the user changes or uses one */
  shortcuts?: ShortcutSettings;
}

const file = (name: string) => join(app.getPath("userData"), name);

function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(file(name), "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(name: string, value: unknown) {
  const path = file(name);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`${name} couldn't be written:`, err);
  }
}

// ── session.json ──────────────────────────────────────────────────────────────

export function readSession(): SessionFile {
  const saved = readJson("session.json") as Partial<SessionFile> | null;
  if (saved?.version === 1 && Array.isArray(saved.windows)) return { version: 1, windows: saved.windows.filter((w) => w && typeof w === "object") };
  // Before session.json: the window's place from window.json; the tabs were the page's (they start empty).
  const old = readJson("window.json") as (WindowBounds & { maximized?: boolean }) | null;
  if (old && typeof old.width === "number" && typeof old.height === "number") {
    return { version: 1, windows: [{ id: "main", bounds: { x: old.x, y: old.y, width: old.width, height: old.height }, maximized: Boolean(old.maximized), fullScreen: false, tabs: [], activeTabId: "home", closed: [] }] };
  }
  return { version: 1, windows: [] };
}

let pending: SessionFile | null = null;
let timer: NodeJS.Timeout | null = null;
/** What was last kept (or is about to be): an unchanged session isn't written again (a tab's title or unsaved dot isn't kept) */
let last = "";

/** Kept 500ms after the last change. */
export function writeSession(next: SessionFile) {
  const json = JSON.stringify(next);
  if (json === last) return;
  last = json;
  pending = next;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushSession, 500);
}

/** What is pending, written now (quitting). */
export function flushSession() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  writeAtomic("session.json", pending);
  pending = null;
}

// ── settings.json ─────────────────────────────────────────────────────────────

const isTheme = (t: unknown): t is ThemePreference => t === "system" || t === "light" || t === "dark";

export function readSettings(): Settings {
  const saved = readJson("settings.json") as Partial<Settings> | null;
  if (saved && isTheme(saved.theme)) return { theme: saved.theme, ...(saved.shortcuts ? { shortcuts: sanitizeShortcutSettings(saved.shortcuts) } : {}) };
  const old = readJson("window.json") as { theme?: unknown } | null;
  return { theme: isTheme(old?.theme) ? old.theme : "system" };
}


export function writeSettings(settings: Settings) {
  writeAtomic("settings.json", settings);
}
