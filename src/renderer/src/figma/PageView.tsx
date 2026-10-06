import { useMemo, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import type { DesignVariable } from "@/types/design";
import { useDesignVariables } from "@/components/project/designVariables";
import type { CSSProperties } from "react";
import { byIdMap, libraryOf, numberOf, type FigmaDocument, type FrameNode, type LangCode } from "./model";
import { MotionStyle, NodeView, PAGE_CSS, PAGE_TOP_NARROW, RenderProvider, type RenderContext } from "./NodeView";
import { isSafeHref } from "@/components/project/RichText";

/**
 * On the site, what a prototype's reaction can do there: open a link, scroll
 * to a layer of the page — the other frames aren't on it (Navigate to, Back
 * play in the editor's player only).
 */
const siteAction: NonNullable<RenderContext["onAction"]> = (reaction, _source, revert) => {
  if (revert) return;
  if (reaction.action === "url" && reaction.url && isSafeHref(reaction.url)) {
    if (/^https?:\/\//i.test(reaction.url)) window.open(reaction.url, "_blank", "noopener,noreferrer");
    else window.location.assign(reaction.url);
  }
  if (reaction.action === "scroll" && reaction.target) document.querySelector(`[data-node-id="${CSS.escape(reaction.target)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
};
import { revealPlan } from "./site";

gsap.registerPlugin(ScrollTrigger, SplitText);

/**
 * The project's page on the site: the file's page frame, drawn at its width
 * (narrower screens scale nothing — the frame's Fill children follow the
 * screen), its prototypes playing, its links and pictures working, its
 * layers coming in as they are scrolled to (the older pages' scroll effects:
 * see revealPlan). Render it inside the design scope (DesignSystemStyle puts
 * the variables there).
 */
export function PageView({ doc, lang = "tr", variables, effects = true, onAction }: {
  doc: FigmaDocument;
  lang?: LangCode;
  variables?: DesignVariable[];
  /** The scroll effects (off: everything simply there) */
  effects?: boolean;
  /** What a reaction does that isn't an instance's change (the prototype's player: another frame; see RenderContext) — else the site's: a link opened, a layer scrolled to */
  onAction?: RenderContext["onAction"];
}) {
  const fromContext = useDesignVariables();
  const byId = useMemo(() => byIdMap(variables ?? fromContext), [variables, fromContext]);
  const page = doc.nodes.find((n): n is FrameNode => n.id === doc.pageId && (n.type === "frame" || n.type === "component"));
  // Instances find their main components on any page of the file (the Bileşenler page's).
  const library = useMemo(() => libraryOf(doc), [doc]);
  const ctx = useMemo(() => ({ nodes: library, byId, lang, play: true, site: true, onAction: onAction ?? siteAction }), [library, byId, lang, onAction]);
  const plan = useMemo(() => (page && effects ? revealPlan(page, library) : null), [page, library, effects]);
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el || !plan) return;
      // Asked for less motion: everything is simply there.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const find = (id: string) => el.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
      // What scrolls it: the window on the site — a box of its own in the prototype's player (data-page-scroller).
      const scroller = el.closest<HTMLElement>("[data-page-scroller]") ?? undefined;
      const splits: { revert: () => void }[] = [];
      // Texts: their lines slide up from under their own edge, one after the other, with the scroll.
      for (const id of plan.lines) {
        const text = find(id);
        if (!text || !text.textContent?.trim()) continue;
        splits.push(
          SplitText.create(text, {
            type: "lines",
            linesClass: "line-reveal",
            autoSplit: true,
            // The lines stay what screen readers read (not hidden behind a label on the text).
            aria: "none",
            onSplit: (instance) =>
              gsap.from(instance.lines, {
                yPercent: 120,
                opacity: 0,
                stagger: 0.05,
                ease: "power2.out",
                scrollTrigger: { trigger: text, scroller, start: "top 95%", end: "top 40%", scrub: 1 },
              }),
          })
        );
      }
      // Everything else: it rises into place, as far as it has been scrolled to.
      for (const id of plan.blocks) {
        const block = find(id);
        if (!block) continue;
        gsap.from(block, {
          opacity: 0,
          y: 48,
          scale: 0.97,
          ease: "power2.out",
          scrollTrigger: { trigger: block, scroller, start: "top 90%", end: "top 40%", scrub: 1.2 },
        });
      }
      return () => {
        splits.forEach((split) => {
          try {
            split.revert();
          } catch {
            /* already gone */
          }
        });
      };
    },
    { scope: root, dependencies: [plan] }
  );

  if (!page) return null;
  // The page frame at the top of the screen: its own place on the canvas doesn't matter here.
  // (Its width follows the screen: kept proportions would make its height follow too.)
  const top: FrameNode = { ...page, x: 0, y: 0, rotation: undefined, lockAspect: undefined };
  // What a narrow screen takes off the room over the page's content (see PAGE_CSS).
  const lift = Math.max(0, numberOf(page.paddingTop, byId) - PAGE_TOP_NARROW);
  return (
    <RenderProvider value={ctx}>
      <MotionStyle />
      <style>{PAGE_CSS}</style>
      <div ref={root} data-canvas-page="" lang={lang} className="relative w-full overflow-x-clip" style={{ maxWidth: page.width, marginLeft: "auto", marginRight: "auto", "--page-lift": `${lift}px` } as CSSProperties}>
        <div data-page-lift="" style={{ position: "relative", width: "100%", minHeight: page.sizingV === "hug" ? undefined : page.height }}>
          <NodeView node={{ ...top, width: page.width, sizingH: "fill" }} parentLayout="vertical" />
        </div>
      </div>
    </RenderProvider>
  );
}
