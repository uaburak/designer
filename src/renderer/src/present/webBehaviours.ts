/**
 * The prototype's "Website behaviours" switch and "Keep state on reload" (Wecra's, docs/engine.md §3.4 "Website
 * behaviours"; docs/research/prototype-web-behaviours.md §2): the viewer's own settings, kept in this browser
 * (localStorage) — never in the file. Every presentation reads them: the presentation tab, Present here and the inline
 * preview.
 *
 * - Website behaviours (on by default; `web-behaviours=0` in a prototype link turns it off for that view): anchored
 *   popovers, breakpoints, interruptible transitions, toast stacks (the player's `setWebBehaviours`). Off: Figma's.
 * - Keep state on reload (off by default): the prototype's runtime state (the player's `saveState`) in the page's
 *   sessionStorage, keyed by file, page and where it started, put back when that prototype starts again in this tab;
 *   Restart forgets it.
 */
import type { MenuEntry } from "@/ds";
import { t } from "@/i18n";
import type { Engine, PresentState } from "@/engine/Engine";

export interface WebOptions {
  websiteBehaviours: boolean;
  keepState: boolean;
}

const KEY = "designer.present.web";
const STATE_PREFIX = "designer.present.state:";

export function readWebOptions(): WebOptions {
  const out: WebOptions = { websiteBehaviours: true, keepState: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as Partial<WebOptions>;
    if (typeof v.websiteBehaviours === "boolean") out.websiteBehaviours = v.websiteBehaviours;
    if (typeof v.keepState === "boolean") out.keepState = v.keepState;
  } catch {
    /* the defaults */
  }
  return out;
}

export function writeWebOptions(next: Partial<WebOptions>): WebOptions {
  const merged = { ...readWebOptions(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    /* not remembered */
  }
  return merged;
}

/** A prototype link's `web-behaviours=0` (Website behaviours off for that view). */
export function webBehavioursParam(params: URLSearchParams): boolean | undefined {
  const v = params.get("web-behaviours");
  return v === "0" ? false : v === "1" ? true : undefined;
}

/** The Advanced settings entries (beside Enable Figma shortcuts / Show hints on click). */
export function webMenuEntries(state: PresentState | null, options: WebOptions = readWebOptions()): MenuEntry[] {
  const on = state?.websiteBehaviours ?? options.websiteBehaviours;
  return [
    { id: "web", label: t("Website behaviours"), checked: on },
    { id: "keep-state", label: t("Keep state on reload"), checked: options.keepState, disabled: !on },
  ];
}

/** Applies "web" / "keep-state" (webMenuEntries' ids); false for any other id. */
export function applyWebOption(engine: Engine, state: PresentState | null, id: string, keyOf?: () => string | null): boolean {
  if (id === "web") {
    const on = !(state?.websiteBehaviours ?? readWebOptions().websiteBehaviours);
    writeWebOptions({ websiteBehaviours: on });
    engine.presentSetOptions({ websiteBehaviours: on });
    return true;
  }
  if (id === "keep-state") {
    const keep = !readWebOptions().keepState;
    writeWebOptions({ keepState: keep });
    const key = keyOf?.();
    if (key) {
      if (keep) saveKeptState(engine, key);
      else forgetKeptState(key);
    }
    return true;
  }
  return false;
}

/** The session storage key of a prototype: its file, page and where it started. */
export function keptStateKey(file: string, page: string | null | undefined, start: string | null | undefined): string {
  return `${STATE_PREFIX}${file}|${page ?? ""}|${start ?? ""}`;
}

export function saveKeptState(engine: Engine, key: string): void {
  if (engine.destroyed) return;
  const state = engine.presentSaveState();
  if (!state) return;
  try {
    sessionStorage.setItem(key, state);
  } catch {
    /* not kept */
  }
}

/** Puts the kept state back on the prototype just started; false when there was none (or it no longer fits). */
export function restoreKeptState(engine: Engine, key: string): boolean {
  let state: string | null = null;
  try {
    state = sessionStorage.getItem(key);
  } catch {
    return false;
  }
  return !!state && engine.presentRestoreState(state);
}

export function forgetKeptState(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* nothing kept */
  }
}
