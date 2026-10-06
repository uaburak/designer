import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DesignVariable, TextTag } from "@/types/design";
import { useTextStyles } from "@/components/project/textStyles";
import { MOTION_CSS, durationOf } from "@/components/project/interactions";
import { isSafeHref, renderRichText } from "@/components/project/RichText";
import { ZoomableImage } from "@/components/ZoomableImage";
import { colorWithAlpha, fillsCss, frameLayoutCss, nodeCss, motionCss } from "./css";
import { EmbedView } from "./EmbedView";
import { PATH_SEP, actionOf, findComponent, isFrameLike, resolveInstance, setOf, wordsIn, type FrameNode, type LangCode, type LayoutGrid, type LayoutMode, type Paint, type Reaction, type SceneNode, type ShapeNode, type TextNode } from "./model";

/**
 * The nodes drawn as DOM — the editor's canvas and the site's page share it.
 * Each element carries `data-node-id` (a layer inside an instance: the
 * instance's id, "/", the layer's name path — see NodeOverride) so the
 * canvas can find what is under the pointer and outline it.
 *
 * Instances draw their main component's layers with their overrides; with
 * prototyping on (the site, the preview) an instance turns into another
 * variant on its reactions — the same elements stay (keyed by name), so
 * Smart animate transitions them.
 *
 * On the site (`site`) the page also does what a page does: its links go
 * where they point, its pictures open larger on a click, what the site's
 * code draws (see Embed) works. A text's **bold** and [links](https://…)
 * are drawn as such everywhere but while it is typed in.
 */

export interface RenderContext {
  nodes: readonly SceneNode[];
  byId: Map<string, DesignVariable>;
  lang: LangCode;
  /** Prototypes play: reactions turn instances into other variants */
  play: boolean;
  /** The text being typed in place (the editor), and where its words go */
  editing?: { id: string; onInput: (id: string, text: string) => void; onDone: () => void } | null;
  /** The site's page: links, pictures that open larger, embeds that work */
  site?: boolean;
  /**
   * What a reaction does that isn't an instance's change (Navigate to, Back,
   * Scroll to, Open link): the prototype's player shows another frame, the
   * site follows a link — `revert`: a hover's or a press's going back
   */
  onAction?: (reaction: Reaction, sourceId: string, revert?: boolean) => void;
}

/** A grid's columns, on its element: the site's page has fewer of them on a phone (see PAGE_CSS). */
const gridOf = (node: FrameNode) => (node.layoutMode === "grid" ? Math.max(1, node.gridColumns ?? 2) : undefined);

/** The room a page keeps over its content on a screen too narrow for what stands beside it (the way back, the contents). */
export const PAGE_TOP_NARROW = 40;

/** A frame's layers stacked, one to a row, as wide as it (see FrameNode.narrow): the site's page on a narrower screen. */
const stackCss = (at: string) => `
  [data-canvas-page] [data-narrow="${at}"][data-grid] { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: none !important; }
  [data-canvas-page] [data-narrow="${at}"]:not([data-grid]) { flex-direction: column !important; flex-wrap: nowrap !important; }
  [data-canvas-page] [data-narrow="${at}"] > [data-node-id] { grid-column: auto !important; grid-row: auto !important; align-self: stretch !important; justify-self: stretch !important; width: auto !important; max-width: 100% !important; min-width: 0 !important; height: auto !important; flex: none !important; position: relative !important; left: auto !important; top: auto !important; }`;

/**
 * The site's page on narrower screens — the file itself has no breakpoints.
 * Container queries on the page (`[data-canvas-page]`, its own width — the
 * screen's on the site, the preview's in the Page Editor): under 1280px
 * (nothing stands beside the page) it keeps 40px over its content, however
 * much its frame has (`--page-lift`: what is taken off); frames marked to
 * (see FrameNode.narrow) stack their layers under 768px or 640px, or keep
 * two columns under 640px; on a phone (under 640px) an unmarked grid of
 * three columns or more has two, and what has a fixed width may shrink to
 * the screen's (rather than run off it).
 */
export const PAGE_CSS = `[data-canvas-page] { container: page / inline-size; }
@container page (max-width: 1279px) {
  [data-page-lift] { margin-top: calc(-1 * var(--page-lift, 0px)); }
}
@container page (max-width: 767px) {${stackCss("stack")}
}
@container page (max-width: 639px) {${stackCss("stack-sm")}
  [data-canvas-page] [data-narrow="two"][data-grid] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  [data-canvas-page] [data-narrow="two"] > [data-node-id] { grid-column: auto !important; grid-row: auto !important; }
  ${[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `[data-canvas-page] [data-grid="${n}"]:not([data-narrow])`).join(", ")} { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  ${[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `[data-canvas-page] [data-grid="${n}"]:not([data-narrow]) > [data-node-id]`).join(", ")} { grid-column: auto !important; grid-row: auto !important; }
  [data-canvas-page] [data-node-id] { flex-shrink: 1 !important; min-width: 0; }
}`;

/** Inside a link (on the site): no link of its own — HTML has no link inside a link. */
const InLinkCtx = createContext(false);

/** The least size (px, each way) of a picture that opens larger on the site: an avatar or an icon doesn't. */
const ZOOM_FROM = 120;

/** The picture a shape shows that opens larger on a click (the site's pages): its topmost fill, when that is an image. */
function zoomable(node: SceneNode): Paint | null {
  if (node.type !== "rectangle" && node.type !== "ellipse") return null;
  if (node.width < ZOOM_FROM || node.height < ZOOM_FROM) return null;
  const top = node.fills.find((p) => p.visible !== false);
  return top?.type === "image" && top.image?.url && top.image.fit !== "tile" ? top : null;
}

/**
 * A shape showing a picture, on the site: the picture itself (it opens
 * larger on a click) in a box clipped to the shape's corners, over the
 * shape's other fills; its shadows and strokes drawn as the shape's — those
 * inside it again over the picture.
 */
function PictureView({ node, paint, style, id }: { node: ShapeNode; paint: Paint; style: CSSProperties; id: string }) {
  const ctx = useContext(RenderContextCtx);
  const { boxShadow, backgroundColor, backgroundImage, backgroundSize, backgroundRepeat, backgroundPosition, ...box } = style;
  void backgroundColor; void backgroundImage; void backgroundSize; void backgroundRepeat; void backgroundPosition;
  const under = fillsCss(node.fills.filter((p) => p !== paint), ctx.byId);
  const image = paint.image!;
  // The project's cover (the Overview's picture) is what the page opens with: loaded at once, first; the rest when scrolled to.
  const cover = node.fixed === "image";
  return (
    <div data-node-id={id} data-node-type={node.type} data-picture="" style={{ ...box, ...under, boxShadow }}>
      <span className="absolute inset-0 block overflow-hidden" style={{ borderRadius: "inherit" }}>
        <ZoomableImage src={image.url} alt={altOf(image, ctx.lang)} loading={cover ? "eager" : "lazy"} fetchPriority={cover ? "high" : undefined} decoding="async" draggable={false} className={image.fit === "fit" ? "block w-full h-full object-contain" : "block w-full h-full object-cover"} />
        {boxShadow && <span aria-hidden className="pointer-events-none absolute inset-0" style={{ boxShadow, borderRadius: "inherit" }} />}
      </span>
    </div>
  );
}

/**
 * The render context, apart from the file's nodes: what every layer reads (the
 * variables, the language, typing…) changes seldom; the nodes change with
 * every edit — only instances read them (LibraryCtx), so an edit draws again
 * only what it changed and the instances.
 */
/** A picture's words in the language shown (Turkish's where it has none in it). */
const altOf = (image: NonNullable<Paint["image"]>, lang: LangCode) => (lang !== "tr" && image.altEn ? image.altEn : image.alt) ?? "";

export const RenderContextCtx = createContext<Omit<RenderContext, "nodes">>({ byId: new Map(), lang: "tr", play: false });
const LibraryCtx = createContext<readonly SceneNode[]>([]);

/** A text's words in the language shown (the base language's own when there are none in it). */
export const textOf = (node: TextNode, lang: LangCode) => wordsIn(node, lang) || node.characters;

/** A text typed in place: the same element, contentEditable — its words written on every keystroke (never re-seeded, so the caret stays). */
function EditableTextNode({ node, style, id }: { node: TextNode; style: CSSProperties; id: string }) {
  const ctx = useContext(RenderContextCtx);
  const ref = useRef<HTMLDivElement>(null);
  const editing = ctx.editing;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = textOf(node, ctx.lang);
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const read = () => {
    const el = ref.current;
    if (!el) return "";
    let text = el.innerText.replace(/\u00a0/g, " ");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return text;
  };
  return (
    <div
      ref={ref}
      data-node-id={id}
      data-node-type="text"
      data-text-style={node.textStyle}
      data-editing=""
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      style={{ ...style, outline: "none", cursor: "text", minWidth: 4 }}
      onInput={() => editing?.onInput(node.id, read())}
      onBlur={() => editing?.onDone()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function TextView({ node, parentLayout, id, zIndex }: { node: TextNode; parentLayout: LayoutMode; id: string; zIndex?: number }) {
  const ctx = useContext(RenderContextCtx);
  const inLink = useContext(InLinkCtx);
  const textStyles = useTextStyles();
  const acts = useLayerReactions(node, id);
  const style = { ...nodeCss(node, parentLayout, ctx.byId), zIndex, ...acts.style };
  if (ctx.editing && ctx.editing.id === id) return <EditableTextNode node={node} style={style} id={id} />;
  const words = textOf(node, ctx.lang);
  // On the site, what it is (a heading of its level, a paragraph — its own say, else its text style's); in a link a heading stays a heading,
  // a paragraph becomes a span (no block inside a link's inline flow). The editor draws every text as a block.
  const said = node.tag ?? (node.textStyle ? textStyles.find((st) => st.id === node.textStyle)?.tag : undefined);
  const Tag: TextTag = ctx.site && said ? (inLink && said === "p" ? "div" : said) : "div";
  return (
    <Tag data-node-id={id} data-node-type="text" data-text-style={node.textStyle} style={style} {...acts.props}>
      {/* Its links: to follow on the site only — the editor's canvas and its preview draw them without an anchor. */}
      {words ? renderRichText(words, { links: Boolean(ctx.site) && !inLink }) : ctx.editing !== undefined ? <span style={{ opacity: 0.3 }}>Text</span> : null}
    </Tag>
  );
}

/** Something being typed (a field): a key reaction leaves it alone. */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"));
};

/**
 * What a layer's reactions listen to, as Figma's triggers (playing only):
 * a click (and Enter / Space: it is a button), a drag, the pointer over it
 * (back when it leaves) or pressing it (back on letting go), a key, the
 * pointer coming in, going out, pressing, letting go — and a delay, once
 * it shows. `fire` does a reaction; `revert` undoes a hover's or a press's.
 */
function useTriggers(reactions: readonly Reaction[], fire: (r: Reaction) => void, revert: (r: Reaction) => void, shownKey: unknown) {
  const ctx = useContext(RenderContextCtx);
  const live = ctx.play ? reactions : [];
  const act = useRef({ fire, revert });
  useLayoutEffect(() => {
    act.current = { fire, revert };
  });
  const dragFrom = useRef<{ x: number; y: number; done: boolean } | null>(null);
  const delayed = live.find((r) => r.trigger === "delay");
  useEffect(() => {
    if (!delayed) return;
    const t = window.setTimeout(() => act.current.fire(delayed), delayed.delay ?? 800);
    return () => window.clearTimeout(t);
  }, [delayed, shownKey]);
  const keyed = live.filter((r) => r.trigger === "key" && r.key);
  const keys = keyed.map((r) => `${r.id}:${r.key}`).join("|");
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.repeat) return;
      const r = keyed.find((k) => k.key!.toLowerCase() === e.key.toLowerCase());
      if (!r) return;
      e.preventDefault();
      act.current.fire(r);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed is what `keys` says
  }, [keys, shownKey]);
  if (!live.length) return null;
  const on = (t: Reaction["trigger"]) => live.find((r) => r.trigger === t);
  const click = on("click");
  const drag = on("drag");
  const handlers: Record<string, unknown> = {
    onClick: click ? (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); if (dragFrom.current?.done) return; act.current.fire(click); } : undefined,
    onPointerEnter: () => {
      const h = on("hover");
      if (h) act.current.fire(h);
      const m = on("mouseenter");
      if (m) act.current.fire(m);
    },
    onPointerLeave: () => {
      const h = on("hover");
      if (h) act.current.revert(h);
      const m = on("mouseleave");
      if (m) act.current.fire(m);
    },
    onPointerDown: (e: React.PointerEvent) => {
      const p = on("press");
      const m = on("mousedown");
      if (p || m || drag) e.stopPropagation();
      if (p) act.current.fire(p);
      if (m) act.current.fire(m);
      dragFrom.current = drag ? { x: e.clientX, y: e.clientY, done: false } : null;
    },
    onPointerMove: drag
      ? (e: React.PointerEvent) => {
          const d = dragFrom.current;
          if (!d || d.done || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
          d.done = true;
          act.current.fire(drag);
        }
      : undefined,
    onPointerUp: () => {
      const p = on("press");
      if (p) act.current.revert(p);
      const m = on("mouseup");
      if (m) act.current.fire(m);
      window.setTimeout(() => { dragFrom.current = null; }, 0);
    },
  };
  // A click's reaction is a button's: reached with Tab, pressed with Enter or Space.
  if (click) {
    handlers.role = "button";
    handlers.tabIndex = 0;
    handlers.onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      act.current.fire(click);
    };
  }
  return { handlers, pointer: Boolean(click || drag) };
}

/** A layer's own reactions (not an instance's: see useReactions) — what they do is the player's, or the site's (see RenderContext.onAction). */
function useLayerReactions(node: SceneNode, id: string) {
  const ctx = useContext(RenderContextCtx);
  const reactions = useMemo(() => (node.reactions ?? []).filter((r) => actionOf(r) !== "change"), [node.reactions]);
  const t = useTriggers(reactions, (r) => ctx.onAction?.(r, id), (r) => ctx.onAction?.(r, id, true), node.id);
  if (!t) return { props: undefined, style: undefined };
  return { props: t.handlers, style: t.pointer ? ({ cursor: "pointer" } as CSSProperties) : undefined };
}

/**
 * One instance's prototype: the variant it shows now, its animation, and
 * the handlers its frame gets — its variant's reactions (Change to: another
 * variant of the set; the rest the player's) and its own.
 */
function useReactions(instance: FrameNode) {
  const ctx = useContext(RenderContextCtx);
  const nodes = useContext(LibraryCtx);
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [motion, setMotion] = useState<{ reaction: Reaction; key: number } | null>(null);
  const back = useRef<{ id: string; reaction: string } | null>(null);
  const currentId = shown ?? instance.mainId;
  const current = currentId ? findComponent(nodes, currentId) : null;
  const set = current ? setOf(nodes, current.id) : null;
  const reactions = useMemo(
    () => [...(current?.reactions ?? []).filter((r) => actionOf(r) !== "change" || !set || set.children.some((c) => c.id === r.target)), ...(instance.reactions ?? []).filter((r) => actionOf(r) !== "change")],
    [current, set, instance.reactions]
  );
  const fire = (r: Reaction) => {
    if (actionOf(r) !== "change") return ctx.onAction?.(r, instance.id);
    // A hover's or a press's change goes back (to the variant before) when it ends.
    back.current = (r.trigger === "hover" || r.trigger === "press") && currentId ? { id: currentId, reaction: r.id } : null;
    setShown(r.target);
    setMotion(r.animation === "instant" ? null : { reaction: r, key: Date.now() });
  };
  const revert = (r: Reaction) => {
    if (actionOf(r) !== "change") return ctx.onAction?.(r, instance.id, true);
    const b = back.current;
    if (!b || b.reaction !== r.id) return;
    back.current = null;
    setShown(b.id);
    setMotion((m) => (m ? { ...m, key: Date.now() } : m));
  };
  // An animation over, its attribute goes.
  useEffect(() => {
    if (!motion) return;
    const t = window.setTimeout(() => setMotion((m) => (m?.key === motion.key ? null : m)), durationOf(motion.reaction) + 60);
    return () => window.clearTimeout(t);
  }, [motion]);
  const t = useTriggers(reactions, fire, revert, currentId);
  const handlers = t
    ? {
        ...t.handlers,
        style: { ...(motion ? motionCss(motion.reaction) : {}), ...(t.pointer ? { cursor: "pointer" } : {}) } as CSSProperties,
        "data-variant-motion": motion?.reaction.animation,
      }
    : null;
  return { shownId: shown, handlers };
}

/** How deep instances may nest (an instance of a component holding an instance…): past it, nothing more is drawn — a cycle can't hang the page. */
const MAX_INSTANCE_DEPTH = 16;
const InstanceDepthCtx = createContext(0);

function InstanceView({ node, parentLayout, id, zIndex }: { node: FrameNode; parentLayout: LayoutMode; id: string; zIndex?: number }) {
  const ctx = useContext(RenderContextCtx);
  const nodes = useContext(LibraryCtx);
  const depth = useContext(InstanceDepthCtx);
  const { shownId, handlers } = useReactions(node);
  // Drawn again when what it draws changes — its component, the set holding its properties — not with every edit of the file.
  const main = findComponent(nodes, shownId ?? node.mainId ?? "");
  const holder = main ? setOf(nodes, main.id) ?? main : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `nodes` is read for what main and holder already say
  const resolved = useMemo(() => resolveInstance(nodes, node, shownId), [main, holder, node, shownId]);
  if (!resolved || depth >= MAX_INSTANCE_DEPTH) {
    // Its component gone: the site draws nothing; the editor, a dashed box in its place.
    if (ctx.site) return null;
    return (
      <div data-node-id={id} data-node-type="instance" style={{ ...nodeCss(node, parentLayout, ctx.byId), zIndex, outline: "1px dashed var(--edit-component, #9747ff)" }} />
    );
  }
  const { style: playStyle, ...play } = handlers ?? {};
  return (
    <InstanceDepthCtx.Provider value={depth + 1}>
      <FrameBox
        node={resolved}
        parentLayout={parentLayout}
        id={id}
        type="instance"
        extraStyle={{ ...playStyle, zIndex }}
        extraProps={play}
        childId={(child) => `${id}/${child}`}
        keyOf={(child) => child.name}
      />
    </InstanceDepthCtx.Provider>
  );
}

function FrameBox({ node, parentLayout, id, type, extraStyle, extraProps, childId, keyOf }: {
  node: FrameNode;
  parentLayout: LayoutMode;
  id: string;
  type: string;
  extraStyle?: CSSProperties;
  extraProps?: Record<string, unknown>;
  /** A child's data-node-id: its own id, or — inside an instance — the instance's id and its name path */
  childId?: (namePath: string, child: SceneNode) => string;
  keyOf?: (child: SceneNode) => string;
}) {
  const ctx = useContext(RenderContextCtx);
  const inLink = useContext(InLinkCtx);
  // A component set: Figma's dashed purple frame around its variants — the editor's mark, not the site's.
  const setMark: CSSProperties | undefined = node.type === "componentSet" && !ctx.site ? { outline: "1px dashed var(--edit-component, #9747ff)" } : undefined;
  // Its own reactions (an instance's come in extraProps, see useReactions).
  const acts = useLayerReactions(node, id);
  const style = { ...nodeCss(node, parentLayout, ctx.byId), ...setMark, ...acts.style, ...extraStyle };
  extraProps = { ...acts.props, ...extraProps };
  // What the site's code draws in its place (see Embed): as tall as it is drawn — inside a link, without links of its own (its badges).
  if (node.embed) {
    return (
      <div data-node-id={id} data-node-type={type} style={style} {...extraProps}>
        <EmbedView embed={inLink ? { ...node.embed, badges: undefined } : node.embed} id={id} site={Boolean(ctx.site) && !inLink} lang={ctx.lang} />
      </div>
    );
  }
  const content = (
    <>
      <Children parent={node} childId={childId} keyOf={keyOf} path="" />
      {ctx.editing !== undefined && node.layoutGrids?.some((g) => g.visible !== false) && <LayoutGrids grids={node.layoutGrids} />}
      {ctx.editing !== undefined && node.layoutMode === "grid" && <GridCells frame={node} byId={ctx.byId} />}
    </>
  );
  // A link, on the site: the frame itself is what is clicked (what is inside it links nowhere of its own).
  if (ctx.site && !inLink && node.href && isSafeHref(node.href)) {
    const outside = /^https?:\/\//i.test(node.href);
    return (
      <a data-node-id={id} data-node-type={type} data-grid={gridOf(node)} data-narrow={node.narrow} href={node.href} {...(outside ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="transition-[filter,scale] duration-200 hover:brightness-95 active:scale-[0.97]" style={{ ...style, color: "inherit", textDecoration: "none", cursor: "pointer" }} {...extraProps}>
        <InLinkCtx.Provider value={true}>{content}</InLinkCtx.Provider>
      </a>
    );
  }
  return (
    <div data-node-id={id} data-node-type={type} data-grid={gridOf(node)} data-narrow={node.narrow} style={style} {...extraProps}>
      {content}
    </div>
  );
}

/** A grid's cells outlined — the editor only, and only while the frame is selected (see EDITOR_CSS): its columns × rows (as many rows as its children fill, when Auto). */
function GridCells({ frame, byId }: { frame: FrameNode; byId: Map<string, DesignVariable> }) {
  const layout = frameLayoutCss(frame, byId);
  const cols = Math.max(1, frame.gridColumns ?? 2);
  const rows = frame.gridRows ?? Math.max(1, Math.ceil(frame.children.length / cols));
  return (
    <div data-grid-cells="" aria-hidden className="pointer-events-none absolute inset-0 grid" style={{ boxSizing: "border-box", paddingTop: layout.paddingTop, paddingRight: layout.paddingRight, paddingBottom: layout.paddingBottom, paddingLeft: layout.paddingLeft, columnGap: layout.columnGap, rowGap: layout.rowGap, gridTemplateColumns: layout.gridTemplateColumns ?? `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {Array.from({ length: cols * rows }).map((_, i) => <span key={i} style={{ boxShadow: "inset 0 0 0 1px var(--edit-accent, #0d99ff)", opacity: 0.5 }} />)}
    </div>
  );
}

/** Figma's layout grids over a frame — the editor only: its columns, rows or square grid, in their colour. */
function LayoutGrids({ grids }: { grids: LayoutGrid[] }) {
  return (
    <>
      {grids.filter((g) => g.visible !== false).map((g, i) => {
        const tint = colorWithAlpha(g.color, g.opacity);
        if (g.type === "grid") {
          const size = Math.max(1, g.size);
          return <div key={i} aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundImage: `linear-gradient(to right, ${tint} 1px, transparent 1px), linear-gradient(to bottom, ${tint} 1px, transparent 1px)`, backgroundSize: `${size}px ${size}px` }} />;
        }
        const cells = Array.from({ length: Math.max(1, g.count) });
        return (
          <div key={i} aria-hidden className="pointer-events-none absolute flex" style={{ inset: g.margin, gap: g.gutter, flexDirection: g.type === "columns" ? "row" : "column" }}>
            {cells.map((_, j) => <span key={j} className="flex-1" style={{ background: tint }} />)}
          </div>
        );
      })}
    </>
  );
}

function Children({ parent, childId, keyOf, path }: { parent: FrameNode; childId?: (namePath: string, child: SceneNode) => string; keyOf?: (child: SceneNode) => string; path: string }) {
  const ctx = useContext(RenderContextCtx);
  return (
    <>
      {parent.children.map((child) => {
        // A hidden layer isn't on the site at all — nor its pictures, loading for nothing.
        if (ctx.site && child.visible === false) return null;
        const namePath = path ? `${path}${PATH_SEP}${child.name}` : child.name;
        const id = childId ? childId(namePath, child) : child.id;
        const key = keyOf ? keyOf(child) : child.id;
        if (childId && isFrameLike(child) && child.type !== "instance") {
          // Inside an instance: nested frames carry the name path on.
          return <NestedFrame key={key} node={child} parentLayout={parent.layoutMode} id={id} childId={childId} keyOf={keyOf} path={namePath} />;
        }
        return <NodeView key={key} node={child} parentLayout={parent.layoutMode} id={id} zIndex={parent.firstOnTop ? parent.children.length - parent.children.indexOf(child) : undefined} />;
      })}
    </>
  );
}

function NestedFrame({ node, parentLayout, id, childId, keyOf, path }: { node: FrameNode; parentLayout: LayoutMode; id: string; childId: (namePath: string, child: SceneNode) => string; keyOf?: (child: SceneNode) => string; path: string }) {
  const ctx = useContext(RenderContextCtx);
  return (
    <div data-node-id={id} data-node-type={node.type} data-grid={gridOf(node)} data-narrow={node.narrow} style={nodeCss(node, parentLayout, ctx.byId)}>
      <Children parent={node} childId={childId} keyOf={keyOf} path={path} />
    </div>
  );
}

/** A node, drawn — `id` is what its element is found by (its own id unless it is inside an instance). */
export const NodeView = memo(function NodeView({ node, parentLayout, id, zIndex }: { node: SceneNode; parentLayout: LayoutMode; id?: string; zIndex?: number }) {
  const inLink = useContext(InLinkCtx);
  const key = id ?? node.id;
  if (node.type === "text") return <TextView node={node} parentLayout={parentLayout} id={key} zIndex={zIndex} />;
  if (node.type === "instance") return <InstanceView node={node} parentLayout={parentLayout} id={key} zIndex={zIndex} />;
  if (isFrameLike(node)) return <FrameBox node={node} parentLayout={parentLayout} id={key} type={node.type} extraStyle={zIndex !== undefined ? { zIndex } : undefined} />;
  return <ShapeView node={node} parentLayout={parentLayout} id={key} zIndex={zIndex} inLink={inLink} />;
});

/** A rectangle, an ellipse, a line — a picture, on the site, when one fills it. */
function ShapeView({ node, parentLayout, id, zIndex, inLink }: { node: ShapeNode; parentLayout: LayoutMode; id: string; zIndex?: number; inLink: boolean }) {
  const ctx = useContext(RenderContextCtx);
  const acts = useLayerReactions(node, id);
  const style = { ...nodeCss(node, parentLayout, ctx.byId), zIndex, ...acts.style };
  // Inside a link the click follows it: the picture doesn't also open larger — nor where a reaction takes the click.
  const paint = ctx.site && !inLink && !acts.props ? zoomable(node) : null;
  if (paint && (node.type === "rectangle" || node.type === "ellipse")) return <PictureView node={node} paint={paint} style={style} id={id} />;
  // A picture too small to open larger (an avatar, an icon): its words, when it has some, for screen readers.
  const picture = ctx.site ? node.fills.find((p) => p.visible !== false && p.type === "image" && p.image?.alt) : undefined;
  if (picture?.image) return <div data-node-id={id} data-node-type={node.type} role="img" aria-label={altOf(picture.image, ctx.lang)} style={style} {...acts.props} />;
  return <div data-node-id={id} data-node-type={node.type} style={style} {...acts.props} />;
}

/** The prototypes' animations, once on the page. */
export function MotionStyle() {
  return <style>{MOTION_CSS}</style>;
}

/** The context's provider, for the canvas and the page. */
export function RenderProvider({ value, children }: { value: RenderContext; children: ReactNode }) {
  const { nodes, byId, lang, play, editing, site, onAction } = value;
  const rest = useMemo(() => ({ byId, lang, play, editing, site, onAction }), [byId, lang, play, editing, site, onAction]);
  return (
    <LibraryCtx.Provider value={nodes}>
      <RenderContextCtx.Provider value={rest}>{children}</RenderContextCtx.Provider>
    </LibraryCtx.Provider>
  );
}
