// TEMPORARY developer tool (see DevPanel.tsx): what the panel keeps — token overrides per theme and the report's items
// with their style edits — in localStorage, shared by every view of the app (Home, editors, the web app), and written
// into one <style> element so it applies everywhere, also inside portals that carry their own theme (the dark menus).

export type Theme = "light" | "dark";

export interface ReportItem {
  id: string;
  /** Which view it was picked in (files, editor, welcome …) and the address. */
  view: string;
  url: string;
  /** What it is: its ds component or CSS module class, its tag, a bit of its text. */
  label: string;
  text: string;
  /** The CSS selector its edits apply to (every match: e.g. every file card). */
  selector: string;
  /** Its size when picked, px. */
  size: [number, number];
  /** Its computed look when picked (the properties the editor shows). */
  before: Record<string, string>;
  /** Style edits: property → value (applied live to every match). */
  edits: Record<string, string>;
  note: string;
  at: number;
}

export interface DevState {
  tokens: Record<Theme, Record<string, string>>;
  report: ReportItem[];
}

const KEY = "wecra.dev.panel";
const OLD_KEY = "wecra.dev.tokens";

function load(): DevState {
  const empty: DevState = { tokens: { light: {}, dark: {} }, report: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<DevState>;
      return { tokens: { light: s.tokens?.light ?? {}, dark: s.tokens?.dark ?? {} }, report: s.report ?? [] };
    }
    // The first version kept one set for both themes
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const o = JSON.parse(old) as Record<string, string>;
      localStorage.removeItem(OLD_KEY);
      return { tokens: { light: { ...o }, dark: { ...o } }, report: [] };
    }
  } catch {
    // storage off or damaged: start empty
  }
  return empty;
}

let state = load();
const listeners = new Set<() => void>();

export const getState = (): DevState => state;

export function update(fn: (s: DevState) => DevState): void {
  state = fn(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage off: lasts until reload
  }
  render();
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Another view changed it (the desktop app's views share the storage)
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  state = load();
  render();
  for (const l of listeners) l();
});

let sheet: HTMLStyleElement | null = null;

/** The overrides as CSS: tokens per theme (every element carrying that theme, portals too), then the report's edits. */
export function css(s: DevState = state): string {
  const block = (sel: string, decls: Record<string, string>, important = false) => {
    const lines = Object.entries(decls).map(([k, v]) => `  ${k}: ${v}${important ? " !important" : ""};`);
    return lines.length ? `${sel} {\n${lines.join("\n")}\n}\n` : "";
  };
  let out = "";
  for (const theme of ["light", "dark"] as const) out += block(`[data-theme="${theme}"]`, s.tokens[theme]);
  for (const item of s.report) out += block(item.selector, item.edits, true);
  return out;
}

function render(): void {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.setAttribute("data-dev-panel", "");
    document.head.appendChild(sheet);
  }
  sheet.textContent = css();
}

render();
