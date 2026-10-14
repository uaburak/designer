// Scenes are React islands in the static pages: `<div data-scene="name">` holds a still placeholder until its
// module is loaded — when it comes within a screen of the viewport (`data-eager`: at once) — and rendered. Scenes are
// watch-only animations (inert, hidden from assistive tech: the section's own text says what they show) except the
// one marked `data-interactive`. The app's
// tooltips (ds TooltipManager) and toasts get one host for the page.
import { startTransition, StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { ToastHost } from "@/ds/components/Toast";
import { TooltipManager } from "@/ds/overlay/TooltipManager";
import { initVisitorCursor } from "./visitorCursor";

export type SceneModule = { default: ComponentType };
export type SceneRegistry = Record<string, () => Promise<SceneModule>>;

let hosted = false;
function host(): void {
  if (hosted) return;
  hosted = true;
  const el = document.createElement("div");
  el.setAttribute("data-site-overlays", "");
  document.body.appendChild(el);
  createRoot(el).render(
    <>
      <TooltipManager />
      <ToastHost />
    </>,
  );
}

function render(el: HTMLElement, mod: SceneModule): void {
  host();
  const Scene = mod.default;
  const root = createRoot(el);
  // A transition: the first render of a scene is time-sliced, so mounting one while the page scrolls doesn't stall
  // the animations already playing
  startTransition(() =>
    root.render(
      <StrictMode>
        <Scene />
      </StrictMode>,
    ),
  );
  el.setAttribute("data-mounted", "");
}

export function mountScenes(registry: SceneRegistry): void {
  const pending = new Map<Element, () => void>();
  const observer = (rootMargin: string) => {
    if (typeof IntersectionObserver !== "function") return null;
    const o: IntersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          o.unobserve(e.target);
          pending.get(e.target)?.();
          pending.delete(e.target);
        }
      },
      { rootMargin },
    );
    return o;
  };
  const io = observer("120% 0px 120% 0px");
  // The live engine (Try it) loads only when its own tile is close, so its Wasm and first frames don't land while the
  // scene above it is animating
  const near = observer("20% 0px 20% 0px");

  // Over a watch-only tile the visitor's pointer becomes a multiplayer cursor, "You" (the live canvas keeps its own)
  const tiles = [...document.querySelectorAll<HTMLElement>("[data-scene]:not([data-interactive])")].map((el) => el.closest<HTMLElement>(".tile") ?? el);
  initVisitorCursor(tiles);

  for (const el of document.querySelectorAll<HTMLElement>("[data-scene]")) {
    const load = registry[el.dataset.scene ?? ""];
    if (!load) continue;
    // Watch-only (docs/site.md §2.2): only a scene marked `data-interactive` (the home hero) takes the visitor's input
    if (!el.hasAttribute("data-interactive")) {
      el.inert = true;
      el.setAttribute("aria-hidden", "true");
    }
    const go = () =>
      void load()
        .then((mod) => render(el, mod))
        .catch((error: unknown) => console.warn(`[scene ${el.dataset.scene}]`, error));
    const watch = el.hasAttribute("data-interactive") ? near : io;
    if (el.hasAttribute("data-eager") || !watch) go();
    else {
      pending.set(el, go);
      watch.observe(el);
    }
  }
}
