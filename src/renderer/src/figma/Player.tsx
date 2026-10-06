import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesignVariable, InteractionAnimation, InteractionDirection } from "@/types/design";
import { DesignSystemStyle } from "@/components/project/designSystem";
import { durationOf, easingCss } from "@/components/project/interactions";
import { isSafeHref } from "@/components/project/RichText";
import { PATH_SEP, actionOf, isFrameLike, walk, type FigmaDocument, type LangCode, type Reaction, type SceneNode } from "./model";
import { PageView } from "./PageView";

/**
 * The prototype played, as Figma's Present — each frame drawn as the site
 * draws a page (PageView: its width, its fonts and colours, its layers
 * coming in as they scroll in, its instances' variants changing), over the
 * site's own background. Its reactions take it from frame to frame:
 * Navigate to (with its animation — instant, dissolve, Smart animate, move
 * or slide in or out, push — its easing and duration), Back (the way it
 * came, reversed), Scroll to, Open link (in a tab of its own).
 *
 * Esc closes it; R starts it again.
 */

interface Screen {
  id: string;
  /** What brought it on (Back plays it reversed) */
  via?: Reaction;
}

interface Transition {
  from: string;
  to: string;
  reaction: Reaction;
  key: number;
}

const OPPOSITE: Record<InteractionDirection, InteractionDirection> = { left: "right", right: "left", up: "down", down: "up" };
const INVERSE: Partial<Record<InteractionAnimation, InteractionAnimation>> = { "move-in": "move-out", "move-out": "move-in", "slide-in": "slide-out", "slide-out": "slide-in" };

/** The reaction Back plays: the one that came, the other way. */
const reversed = (r: Reaction): Reaction => ({ ...r, animation: INVERSE[r.animation] ?? r.animation, direction: OPPOSITE[r.direction ?? "left"] });

/** A move's vector (in %): which way the direction points. */
const vector = (d: InteractionDirection | undefined) => {
  switch (d ?? "left") {
    case "left": return [-100, 0];
    case "right": return [100, 0];
    case "up": return [0, -100];
    default: return [0, 100];
  }
};
const shift = (v: number[], k: number) => `translate(${v[0] * k}%, ${v[1] * k}%)`;

/** Each layer of a frame by its name path (an instance's layers through it): what Smart animate matches across frames. */
function namePaths(frame: SceneNode): Map<string, string> {
  const paths = new Map<string, string>();
  if (!isFrameLike(frame)) return paths;
  const visit = (list: readonly SceneNode[], path: string) => {
    for (const n of list) {
      const key = path ? `${path}${PATH_SEP}${n.name}` : n.name;
      paths.set(n.id, key);
      if (isFrameLike(n) && n.type !== "instance") visit(n.children, key);
    }
  };
  visit(frame.children, "");
  return paths;
}

/** An element's name path in its frame (a layer inside an instance: the instance's path, then its own). */
const keyOf = (id: string, paths: Map<string, string>) => {
  const slash = id.indexOf("/");
  if (slash < 0) return paths.get(id);
  const inst = paths.get(id.slice(0, slash));
  return inst ? `${inst}${PATH_SEP}${id.slice(slash + 1).replace(/\//g, PATH_SEP)}` : undefined;
};

export function Player({ file, pageNodes, start, variables, lang, onClose }: {
  /** The file (its library: the instances' components) */
  file: FigmaDocument;
  /** The open page's top-level layers: the frames it plays */
  pageNodes: readonly SceneNode[];
  /** The frame it starts on */
  start: string;
  variables: DesignVariable[];
  lang: LangCode;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<Screen[]>([{ id: start }]);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [run, setRun] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const current = stack[stack.length - 1];
  const frameOf = useCallback((id: string) => pageNodes.find((n) => n.id === id && isFrameLike(n)) ?? null, [pageNodes]);
  const latest = useRef({ stack, transition });
  useLayoutEffect(() => {
    latest.current = { stack, transition };
  });

  const go = useCallback((to: string, reaction: Reaction, back: boolean) => {
    const { stack: s, transition: t } = latest.current;
    const from = s[s.length - 1];
    if (t || from.id === to) return;
    setStack(back ? s.slice(0, -1) : [...s, { id: to, via: reaction }]);
    if (reaction.animation !== "instant") setTransition({ from: from.id, to, reaction, key: Date.now() });
  }, []);

  const onAction = useCallback((r: Reaction, _source: string, revert?: boolean) => {
    const action = actionOf(r);
    const s = latest.current.stack;
    // Back — or a hover's, a press's navigation ending: the frame before, the way it came reversed.
    if (action === "back" || (revert && action === "navigate")) {
      if (s.length < 2) return;
      const here = s[s.length - 1];
      return go(s[s.length - 2].id, here.via ? reversed(here.via) : { ...r, animation: "instant" }, true);
    }
    if (revert) return;
    if (action === "navigate") {
      if (!frameOf(r.target)) return;
      return go(r.target, r, false);
    }
    if (action === "scroll") {
      const el = stage.current?.querySelector(`[data-screen="${CSS.escape(s[s.length - 1].id)}"] [data-node-id="${CSS.escape(r.target)}"]`);
      el?.scrollIntoView({ behavior: r.animation === "instant" ? "auto" : "smooth", block: "start" });
      return;
    }
    if (action === "url" && r.url && isSafeHref(r.url)) window.open(r.url, "_blank", "noopener,noreferrer");
  }, [frameOf, go]);

  // The animation between two frames: the screens moved, faded — their matching layers (Smart animate) from where they were.
  useLayoutEffect(() => {
    if (!transition) return;
    const root = stage.current;
    const fromEl = root?.querySelector<HTMLElement>(`[data-screen="${CSS.escape(transition.from)}"]`);
    const toEl = root?.querySelector<HTMLElement>(`[data-screen="${CSS.escape(transition.to)}"]`);
    if (!fromEl || !toEl) return setTransition(null);
    const r = transition.reaction;
    const timing: KeyframeAnimationOptions = { duration: durationOf(r), easing: easingCss(r), fill: "both" };
    const v = vector(r.direction);
    const anims: Animation[] = [];
    const animate = (el: Element, frames: Keyframe[]) => anims.push(el.animate(frames, timing));
    // Which screen is over the other: the one coming in, but for a move or slide out (the leaving one goes off over it).
    const leavingOnTop = r.animation === "move-out" || r.animation === "slide-out";
    fromEl.style.zIndex = leavingOnTop ? "2" : "1";
    toEl.style.zIndex = leavingOnTop ? "1" : "2";
    switch (r.animation) {
      case "dissolve":
        animate(toEl, [{ opacity: 0 }, { opacity: 1 }]);
        break;
      case "move-in":
        animate(toEl, [{ transform: shift(v, -1) }, { transform: "none" }]);
        break;
      case "move-out":
        animate(fromEl, [{ transform: "none" }, { transform: shift(v, 1) }]);
        break;
      case "push":
        animate(toEl, [{ transform: shift(v, -1) }, { transform: "none" }]);
        animate(fromEl, [{ transform: "none" }, { transform: shift(v, 1) }]);
        break;
      case "slide-in":
        animate(toEl, [{ transform: shift(v, -1) }, { transform: "none" }]);
        animate(fromEl, [{ transform: "none" }, { transform: shift(v, 0.3) }]);
        break;
      case "slide-out":
        animate(fromEl, [{ transform: "none" }, { transform: shift(v, 1) }]);
        animate(toEl, [{ transform: shift(v, -0.3) }, { transform: "none" }]);
        break;
      default: {
        // Smart animate: the frames cross-fade; each layer both have goes from where (and how big) it was to where it is.
        animate(fromEl, [{ opacity: 1 }, { opacity: 0 }]);
        animate(toEl, [{ opacity: 0 }, { opacity: 1 }]);
        const fromFrame = frameOf(transition.from);
        const toFrame = frameOf(transition.to);
        if (!fromFrame || !toFrame) break;
        const fromPaths = namePaths(fromFrame);
        const toPaths = namePaths(toFrame);
        const before = new Map<string, DOMRect>();
        const fromBox = fromEl.getBoundingClientRect();
        fromEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
          const key = keyOf(el.dataset.nodeId!, fromPaths);
          if (key && !before.has(key)) before.set(key, el.getBoundingClientRect());
        });
        const toBox = toEl.getBoundingClientRect();
        toEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
          const key = keyOf(el.dataset.nodeId!, toPaths);
          const was = key ? before.get(key) : undefined;
          if (!was) return;
          const now = el.getBoundingClientRect();
          const dx = was.left - fromBox.left - (now.left - toBox.left);
          const dy = was.top - fromBox.top - (now.top - toBox.top);
          const sx = now.width ? was.width / now.width : 1;
          const sy = now.height ? was.height / now.height : 1;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
          el.style.transformOrigin = "0 0";
          anims.push(el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: "none" }], { ...timing, composite: "add" }));
        });
      }
    }
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      anims.forEach((a) => a.cancel());
      setTransition((t) => (t?.key === transition.key ? null : t));
    };
    Promise.all(anims.map((a) => a.finished)).then(end, end);
    // Nothing animated (no matching layers): over at once — and over when its time is up, whatever the animations do (a tab out of sight holds them).
    if (!anims.length) end();
    const timeout = window.setTimeout(end, durationOf(r) + 250);
    return () => {
      window.clearTimeout(timeout);
      anims.forEach((a) => a.cancel());
    };
  }, [transition, frameOf]);

  // Esc closes; R starts again.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        setTransition(null);
        setStack([{ id: start }]);
        setRun((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, start]);

  const shown = transition ? [transition.from, transition.to] : [current.id];
  const docOf = useMemo(() => (id: string): FigmaDocument => ({ ...file, nodes: [...pageNodes], pageId: id }), [file, pageNodes]);
  const name = frameOf(current.id)?.name ?? "";

  // The frames it can reach, for the restart's menu (Figma's flows): every top-level frame with a flow starting point.
  const flows = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    walk([...pageNodes], (n, parent) => {
      if (!parent && isFrameLike(n) && n.flowStart) out.push({ id: n.id, name: n.flowStart });
    });
    return out;
  }, [pageNodes]);

  return (
    <div role="dialog" aria-label="Prototype" className="fixed inset-0 z-50 flex flex-col" data-design-scope="" style={{ background: "var(--bg-1)" }}>
      <DesignSystemStyle />
      <div ref={stage} className="relative flex-1 min-h-0 overflow-hidden" onClickCapture={(e) => {
        // A link in it: another site's opens in a tab of its own; the site's own goes nowhere (leaving would lose what isn't saved).
        const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
        if (!a) return;
        e.preventDefault();
        if (/^https?:\/\//i.test(a.getAttribute("href") ?? "")) window.open(a.href, "_blank", "noopener,noreferrer");
      }}>
        {shown.map((id) => (
          <div key={`${id}:${run}`} data-screen={id} data-page-scroller="" className="absolute inset-0 overflow-y-auto overflow-x-hidden" style={{ background: "var(--bg-1)" }}>
            <PageView doc={docOf(id)} lang={lang} variables={variables} onAction={onAction} />
          </div>
        ))}
      </div>
      {/* The player's controls, out of the way: where it is, start again, close. */}
      <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-1">
        <div className="pointer-events-auto flex items-center gap-1 h-8 pl-3 pr-1 rounded-full bg-black/70 text-[11px] text-white backdrop-blur">
          <span className="max-w-[200px] truncate">{name}</span>
          {flows.length > 1 && (
            <select aria-label="Flow" className="h-6 ml-1 rounded-full bg-white/10 px-2 text-[11px] text-white outline-none cursor-pointer" value={flows.find((f) => f.id === stack[0].id)?.id ?? ""} onChange={(e) => { setTransition(null); setStack([{ id: e.target.value }]); setRun((n) => n + 1); }}>
              {flows.map((f) => <option key={f.id} value={f.id} className="text-black">{f.name}</option>)}
            </select>
          )}
          <button type="button" onClick={() => { setTransition(null); setStack([{ id: start }]); setRun((n) => n + 1); }} className="h-6 px-2 rounded-full hover:bg-white/15 cursor-pointer" title="Restart (R)">Restart</button>
          <button type="button" onClick={onClose} className="h-6 px-2 rounded-full hover:bg-white/15 cursor-pointer" title="Close (Esc)">Close</button>
        </div>
      </div>
    </div>
  );
}
