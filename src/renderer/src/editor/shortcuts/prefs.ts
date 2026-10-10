/**
 * The user's keyboard shortcuts in this view (src/shared/shortcuts.ts): in the desktop app main keeps them
 * (settings.json, `window.designer.shortcuts` — one set for every window and tab, the menu bar's accelerators
 * included); in a browser, localStorage. A change is applied at once here (the registry's keys, the layout) and sent
 * on; one from another tab comes back as `shortcuts:changed`. Shortcuts used are marked as they happen and written
 * at most every half second. Until the user picks a layout, the system's is in force when it is one of the Layout
 * tab's (`navigator.keyboard.getLayoutMap()`, read at start and whenever the window comes to the front again — the
 * input source may have changed): preselected there, never written.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_SHORTCUT_SETTINGS, sanitizeShortcutSettings, type KeyboardLayoutId, type ShortcutSettings } from "@shared/shortcuts";
import type { EditorApi } from "@shared/desktop";
import { setKeyLayout } from "../commands";
import { applyBindings } from "./keymap";
import { detectLayout, layoutMap } from "./layouts";

const STORAGE_KEY = "designer.shortcuts";

type Bridge = EditorApi["shortcuts"];

function bridge(): Bridge | null {
  const d = (globalThis as unknown as { designer?: { role?: string; shortcuts?: Bridge } }).designer;
  return d?.role === "editor" && d.shortcuts ? d.shortcuts : null;
}

/** Layouts whose shortcuts are the U.S. places (no remapping, the registry's own key names). */
const IDENTITY = new Set(["generic", "us", "zh", "ko", "ja"]);

/** The Keyboard API's part we read (Chromium; not in TypeScript's DOM types). */
interface KeyboardApi {
  getLayoutMap?: () => Promise<{ forEach(cb: (value: string, key: string) => void): void }>;
}

/** The system's layout, if it is one of the Layout tab's (null: unknown, or a U.S. keyboard). */
async function systemLayout(): Promise<KeyboardLayoutId | null> {
  const kb = (globalThis.navigator as (Navigator & { keyboard?: KeyboardApi }) | undefined)?.keyboard;
  if (!kb?.getLayoutMap) return null;
  try {
    const map = new Map<string, string>();
    (await kb.getLayoutMap()).forEach((value, key) => map.set(key, value));
    return detectLayout(map);
  } catch {
    return null;
  }
}

class ShortcutPrefs {
  /** What is kept (main's settings.json, localStorage) */
  private kept: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS;
  /** What is in force: the kept settings, with the system's layout while the user hasn't picked one */
  private state: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS;
  private detected: KeyboardLayoutId | null = null;
  private listeners = new Set<() => void>();
  private usedTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUsed = false;
  private started = false;

  get = (): ShortcutSettings => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** Reads the kept settings and the system's layout (once per page; again after `reset`). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.detect();
    if (typeof window !== "undefined") window.addEventListener("focus", this.onFocus);
    const b = bridge();
    if (b) {
      void b.get().then((s) => this.replace(s), () => {});
      b.onChanged((s) => this.replace(s));
      return;
    }
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) this.replace(JSON.parse(raw));
    } catch {
      // A broken store reads as the defaults.
    }
  }

  /** Settings that came from main or the store: in force here. */
  replace(raw: unknown): void {
    const next = sanitizeShortcutSettings(raw);
    // Shortcuts used here and not yet written stay used.
    if (this.pendingUsed) next.used = [...new Set([...next.used, ...this.kept.used])];
    this.kept = next;
    this.apply();
  }

  /** Bindings or the layout changed by the user (a layout given is picked): in force now, then kept. */
  update(patch: Partial<Pick<ShortcutSettings, "bindings" | "layout">>): void {
    const full: Partial<ShortcutSettings> = "layout" in patch ? { ...patch, layoutPicked: true } : patch;
    this.kept = { ...this.kept, ...full };
    this.apply();
    this.write(full);
  }

  /** Reads the system's layout again: in force while the user hasn't picked one. */
  async detect(): Promise<void> {
    const id = await systemLayout();
    if (id === this.detected) return;
    this.detected = id;
    if (!this.kept.layoutPicked) this.apply();
  }

  private onFocus = (): void => void this.detect();

  /** A shortcut used (a row's usage id): lit in the panel from now on. */
  markUsed(id: string): void {
    if (this.kept.used.includes(id)) return;
    this.kept = { ...this.kept, used: [...this.kept.used, id] };
    this.state = { ...this.state, used: this.kept.used };
    this.emit();
    this.pendingUsed = true;
    if (this.usedTimer) return;
    this.usedTimer = setTimeout(() => {
      this.usedTimer = null;
      this.pendingUsed = false;
      this.write({ used: this.kept.used });
    }, 500);
  }

  /** Tests: back to Figma's keys, nothing used, Generic, no system layout. */
  reset(): void {
    if (this.usedTimer) clearTimeout(this.usedTimer);
    this.usedTimer = null;
    this.pendingUsed = false;
    this.started = false;
    this.detected = null;
    if (typeof window !== "undefined") window.removeEventListener("focus", this.onFocus);
    this.kept = DEFAULT_SHORTCUT_SETTINGS;
    this.apply();
  }

  private apply(): void {
    this.state = this.kept.layoutPicked || !this.detected ? this.kept : { ...this.kept, layout: this.detected };
    applyBindings(this.state.bindings);
    setKeyLayout(IDENTITY.has(this.state.layout) ? null : layoutMap(this.state.layout));
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  private write(patch: Partial<ShortcutSettings>): void {
    const b = bridge();
    if (b) {
      void b.set(patch).catch(() => {});
      return;
    }
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(this.kept));
    } catch {
      // Private mode or a full store: the change holds for this session.
    }
  }
}

/** This view's shortcut settings. */
export const shortcutPrefs = new ShortcutPrefs();

/** The settings, re-rendering on every change. */
export const useShortcutSettings = (): ShortcutSettings => useSyncExternalStore(shortcutPrefs.subscribe, shortcutPrefs.get, shortcutPrefs.get);
