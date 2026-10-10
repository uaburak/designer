/**
 * The user's keyboard shortcuts in this view (src/shared/shortcuts.ts): in the desktop app main keeps them
 * (settings.json, `window.designer.shortcuts` — one set for every window and tab, the menu bar's accelerators
 * included); in a browser, localStorage. A change is applied at once here (the registry's keys, the layout) and sent
 * on; one from another tab comes back as `shortcuts:changed`. Shortcuts used are marked as they happen and written
 * at most every half second.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_SHORTCUT_SETTINGS, sanitizeShortcutSettings, type ShortcutSettings } from "@shared/shortcuts";
import type { EditorApi } from "@shared/desktop";
import { setKeyLayout } from "../commands";
import { applyBindings } from "./keymap";
import { layoutMap } from "./layouts";

const STORAGE_KEY = "designer.shortcuts";

type Bridge = EditorApi["shortcuts"];

function bridge(): Bridge | null {
  const d = (globalThis as unknown as { designer?: { role?: string; shortcuts?: Bridge } }).designer;
  return d?.role === "editor" && d.shortcuts ? d.shortcuts : null;
}

/** Layouts whose shortcuts are the U.S. places (no remapping, the registry's own key names). */
const IDENTITY = new Set(["generic", "us", "zh", "ko", "ja"]);

class ShortcutPrefs {
  private state: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS;
  private listeners = new Set<() => void>();
  private usedTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUsed = false;
  private started = false;

  get = (): ShortcutSettings => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** Reads the kept settings (once per page; again after `reset`). */
  start(): void {
    if (this.started) return;
    this.started = true;
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
    if (this.pendingUsed) next.used = [...new Set([...next.used, ...this.state.used])];
    this.state = next;
    this.apply();
  }

  /** Bindings or the layout changed by the user: in force now, then kept. */
  update(patch: Partial<Pick<ShortcutSettings, "bindings" | "layout">>): void {
    this.state = { ...this.state, ...patch };
    this.apply();
    this.write(patch);
  }

  /** A shortcut used (a row's usage id): lit in the panel from now on. */
  markUsed(id: string): void {
    if (this.state.used.includes(id)) return;
    this.state = { ...this.state, used: [...this.state.used, id] };
    this.emit();
    this.pendingUsed = true;
    if (this.usedTimer) return;
    this.usedTimer = setTimeout(() => {
      this.usedTimer = null;
      this.pendingUsed = false;
      this.write({ used: this.state.used });
    }, 500);
  }

  /** Tests: back to Figma's keys, nothing used, Generic. */
  reset(): void {
    if (this.usedTimer) clearTimeout(this.usedTimer);
    this.usedTimer = null;
    this.pendingUsed = false;
    this.started = false;
    this.state = DEFAULT_SHORTCUT_SETTINGS;
    this.apply();
  }

  private apply(): void {
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
      if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Private mode or a full store: the change holds for this session.
    }
  }
}

/** This view's shortcut settings. */
export const shortcutPrefs = new ShortcutPrefs();

/** The settings, re-rendering on every change. */
export const useShortcutSettings = (): ShortcutSettings => useSyncExternalStore(shortcutPrefs.subscribe, shortcutPrefs.get, shortcutPrefs.get);
