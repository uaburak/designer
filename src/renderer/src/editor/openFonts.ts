/**
 * Which fonts to ask for when a file opens, and when (docs/editor.md "Opening a file"): the shown page's fonts — its
 * own text and its read dependencies' (the mains its instances use) — before `engine_load`, so they bind while the
 * document is still being handed over and the first frame's text is shaped once, and the engine's first fallback
 * family when the text holds a script Latin fonts lack. Nothing for the other pages: as Figma loads a page and its
 * dependencies on demand, the engine asks for a page's fonts itself (REQUEST_FONT) when the page is first shown.
 * `later` (the other pages' fonts) is a prefetch a caller may still ask for (`requestFonts(plan, {prefetch: true})`).
 */
import { FALLBACK_FAMILIES, fonts as fontService } from "@/engine/fonts";
import type { DocumentFacts, FontRef } from "@/store/loadDocument";

export interface FontPlan {
  /** Requested before the load: the shown page's fonts (every font when the pages aren't known), plus the fallback family */
  first: FontRef[];
  /** The other pages' fonts, in page order: requested only on a prefetch (`requestFonts(…, {prefetch: true})`) */
  later: FontRef[];
}

const key = (f: FontRef) => `${f.family}\n${f.style}`;

/**
 * The plan for `facts`: `page` is the page that will be shown (the file's saved page, else the first one); its fonts
 * come first, then every other page's in order, each font once. Without per-page knowledge every font comes first.
 */
export function planFonts(facts: Pick<DocumentFacts, "fonts" | "fontsByPage" | "needsFallbackFont">, page: string | null): FontPlan {
  const pages = Object.keys(facts.fontsByPage);
  const seen = new Set<string>();
  const first: FontRef[] = [];
  const later: FontRef[] = [];
  const take = (list: FontRef[] | undefined, into: FontRef[]) => {
    for (const f of list ?? []) {
      const k = key(f);
      if (seen.has(k)) continue;
      seen.add(k);
      into.push(f);
    }
  };
  if (!pages.length) take(facts.fonts, first);
  else {
    const shown = page && facts.fontsByPage[page] ? page : pages[0];
    take(facts.fontsByPage[shown], first);
    for (const p of pages) if (p !== shown) take(facts.fontsByPage[p], later);
    // Fonts the per-page walk missed (text under no page: none expected) still come first.
    take(facts.fonts, first);
  }
  // Text in a script the Latin fonts lack: the engine will ask for its first fallback family after the load.
  if (facts.needsFallbackFont && FALLBACK_FAMILIES[0] && !seen.has(`${FALLBACK_FAMILIES[0]}\nRegular`)) first.push({ family: FALLBACK_FAMILIES[0], style: "Regular" });
  return { first, later };
}

/**
 * Requests `plan.first` now; with `prefetch`, `plan.later` too, one family at a time on idle moments after `delayMs`.
 * Returns a cancel.
 */
export function requestFonts(plan: FontPlan, options: { delayMs?: number; prefetch?: boolean; request?: (f: FontRef) => void } = {}): () => void {
  const request = options.request ?? ((f: FontRef) => fontService.request(f.family, f.style));
  for (const f of plan.first) request(f);
  if (!options.prefetch || !plan.later.length) return () => {};
  let cancelled = false;
  let idle = 0;
  let timer = 0;
  const queue = [...plan.later];
  const next = () => {
    idle = 0;
    if (cancelled || !queue.length) return;
    // One family per idle slice: a font file is an IPC read and a copy into the engine's heap.
    const f = queue.shift()!;
    const family = f.family;
    request(f);
    while (queue.length && queue[0].family === family) request(queue.shift()!);
    schedule();
  };
  const schedule = () => {
    if (cancelled) return;
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(next, { timeout: 4000 });
    else timer = window.setTimeout(next, 250);
  };
  timer = window.setTimeout(schedule, options.delayMs ?? 2000);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idle && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
  };
}
