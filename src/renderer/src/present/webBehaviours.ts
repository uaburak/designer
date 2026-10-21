/**
 * The presentation's "Website behaviours" switch (Options › Advanced settings; docs/engine.md §3.4 "Website behaviours",
 * docs/research/prototype-web-behaviours.md §2): on, playing a prototype feels like using the site — text inputs take
 * typing, Tab / Enter / Space / Esc / arrows work, a modal keeps the focus, cursors follow the hotspots, disabled
 * instances do nothing —; off, the player is Figma's. On by default; remembered per user on this machine (never in the
 * file); a prototype link's `web-behaviours=0` turns it off for that view. Every presentation (inline preview, Present
 * here, the Present tab) reads it from here.
 */
const KEY = "designer.present.webBehaviours";

/** The remembered choice (on unless the user turned it off). */
export function readWebBehaviours(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

/** Remembers the choice for every presentation on this machine. */
export function writeWebBehaviours(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* not remembered */
  }
}

/** A prototype link's parameter: `web-behaviours=0` off, `=1` on, absent: the remembered choice. */
export function webBehavioursFromUrl(params: URLSearchParams): boolean | undefined {
  const v = params.get("web-behaviours");
  return v === "0" ? false : v === "1" ? true : undefined;
}
