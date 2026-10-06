import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/context/ThemeContext";
import { SITE_URL } from "@/lib/siteConfig";
import { shellBridge } from "@/app/bridge";
import { openExternal } from "@/app/native";
import { FigmaIcon, fi } from "@/components/admin/figmaIcons";
import { ScrollArea } from "@/components/ScrollArea";
import { ContextMenu, keys, type MenuEntry } from "@/components/admin/ContextMenu";
import { createViewStore, type CanvasTool, type CanvasView, type ViewStore, type ZoomActions } from "./view";
import { useView } from "./useView";
import type { DesignSystem } from "./designSystem";
import type { EditSession } from "./session";
import { VersionsWindow } from "./VersionsWindow";
import { componentIds, instancesOf } from "./systemLibrary";
import type { MenuItem } from "./popover";
import { Canvas, type Rect } from "./Canvas";
import { VariablesTable } from "./VariablesTable";
import { colorsIn } from "./ColorPicker";
import { copyElementAs, exportElement } from "./exportNode";
import { nodeCss } from "./css";
import { uploadMedia } from "@/lib/storage";
import { Inspector, type EditorOps } from "./Inspector";
import { Layers, layerIcon, requestRename, type TreePlace } from "./Layers";
import { BrandButton, CollapseHeader, EDITOR_CSS, IconButton, Tab } from "./ui";
import type { RenderContext } from "./NodeView";
import { fixedIds, withSitePage } from "./overview";
import { inPageColumn, isOverviewNode } from "./page";
import { COMPONENTS_PAGE_ID } from "./library";
import { ImagesPanel } from "./ImagesPanel";
import { SettingsWindow } from "./SettingsWindow";
import { useEditorSettings } from "./settings";
import { FindPanel, type FindPage } from "./FindPanel";
import { useAccount } from "./account";
import { AccountButton, FIGMA_TOKENS, ModeTab, NavTab, PublishButton, SaveButton, SaveProblem, Tool, ZoomPercent } from "./chrome";
import { IS_MAC, domRect, isTyping, rectOf } from "./dom";
import { Player } from "./Player";
import {
  allComponents,
  applyPropertyValue,
  changesAt,
  BASE_LANGUAGE,
  byIdMap,
  cloneNode,
  componentAround,
  findComponent,
  findNode,
  freePropertyName,
  getNode,
  insertNode,
  isFrameLike,
  languagesOf,
  PATH_SEP,
  layerAt,
  layerName,
  libraryOf,
  makeFrame,
  makeInstance,
  makeShape,
  makeText,
  nextName,
  nid,
  numberOf,
  overrideAt,
  pageOfNode,
  pickVariant,
  propsPatch,
  pruneBindings,
  removeNodes,
  resolveInstance,
  setOf,
  updateAnywhere,
  walk,
  withOverride,
  withRenamedLayer,
  withoutLanguage,
  withVariantName,
  parseVariantName,
  withoutChange,
  withPushedOverrides,
  withResetAt,
  writtenLanguages,
  wordsPatch,
  topmost,
  updateNode,
  updateNodes,
  variantProperties,
  variantsOf,
  EMBED_LABEL,
  type EmbedKind,
  type FigmaDocument,
  type FrameNode,
  type LangCode,
  type NodeOverride,
  type Paint,
  type Reaction,
  type SceneNode,
  type TextNode,
} from "./model";


/**
 * Where a picture goes in an instance (`list`: its layers, as drawn): the
 * first layer in sight showing one (the Overview's cover) — else the first
 * shape in sight, a picture's placeholder (an Image's grey box). Its key: its
 * name path. An instance's own layers only, not a nested instance's.
 */
function pictureIn(list: readonly SceneNode[]): { key: string; fills: Paint[] } | null {
  const layers: { key: string; node: SceneNode }[] = [];
  const visit = (nodes: readonly SceneNode[], path: string) => {
    for (const child of nodes) {
      if (child.visible === false) continue;
      const key = path ? `${path}${PATH_SEP}${child.name}` : child.name;
      layers.push({ key, node: child });
      if (isFrameLike(child) && child.type !== "instance") visit(child.children, key);
    }
  };
  visit(list, "");
  const found = layers.find(({ node }) => node.type !== "text" && node.type !== "instance" && node.fills.some((p) => p.type === "image")) ??
    layers.find(({ node }) => node.type === "rectangle" || node.type === "ellipse");
  return found && found.node.type !== "text" ? { key: found.key, fills: found.node.fills } : null;
}

/** Is it the page's Overview (the instance — not its component)? */
const isPageOverview = (node: SceneNode | undefined) => node?.fixed === "overview" && node.type === "instance";
/** Do `siblings` start with the page's Overview (the page frame's)? */
const leadsWithOverview = (siblings: readonly SceneNode[]) => isPageOverview(siblings[0]);

/**
 * The editor — Figma, for the project's page: the navigation bar (the
 * menu; File, Assets, Variables), the left sidebar (the file, its
 * page, the layers), the canvas, the right sidebar (Design / Prototype,
 * Save), the toolbar. Everything edits `doc`; Save writes it with the
 * project. Undo is the project's (see AdminEditorClient).
 */

type LeftTab = "file" | "components" | "assets" | "images" | "variables";

/**
 * The editor's three views of the same file, switched at the toolbar's end:
 * the canvas (Figma's, endless), the page (the site's page as a page: at
 * its own width, scrolled up and down — the same panels, menus and
 * components around it), the code (to come).
 */
type EditorMode = "canvas" | "page" | "code";
const EDITOR_MODES: { id: EditorMode; label: string }[] = [
  { id: "canvas", label: "Canvas Editor" },
  { id: "page", label: "Page Editor" },
  { id: "code", label: "Code" },
];
const EDITOR_MODE_KEY = "figma-editor-mode";

/** The Page Editor's preview widths: the page's own (the desktop's), a tablet's, a phone's. */
const PREVIEW_WIDTHS: { label: string; width: number | null }[] = [{ label: "Desktop", width: null }, { label: "Tablet", width: 768 }, { label: "Phone", width: 375 }];

/** What marks the editor's layers on the system's clipboard (a paste in another tab finds them). */
const CLIPBOARD_MARK = "figma-layers:";

/** The embeds Assets offers, in its order. */
const EMBED_KINDS: EmbedKind[] = ["video", "code", "figma", "iframe", "compare", "devices", "image"];

/** The navigation bar's width (w-12). */
const NAV_WIDTH = 48;
const PANEL_WIDTHS_KEY = "figma-panel-widths";

/** What only a text, a shape or frame, or only a frame can take — for edits made to several layers at once. */
const TEXT_ONLY = new Set(["characters", "charactersEn", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textAutoResize", "textStyle", "textCase", "textDecoration", "verticalAlign", "paragraphSpacing"]);
const GEOMETRY_ONLY = new Set(["strokes", "cornerRadius", "corners", "effects", "effectStyle"]);
const FRAME_ONLY = new Set(["children", "clipsContent", "layoutMode", "itemSpacing", "counterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAlign", "counterAlign", "layoutWrap", "gridColumns", "gridRows", "layoutGrids", "strokesInLayout", "firstOnTop", "baselineAlign", "variant", "reactions", "mainId", "overrides"]);

const KIND_HINT: Record<SceneNode["type"], string> = { frame: "frame", rectangle: "rectangle", ellipse: "ellipse", line: "line", text: "text", component: "component", componentSet: "component set", instance: "instance" };

export function FigmaEditor({ doc: file, onDoc, title, slug, system, session, undo, redo }: {
  doc: FigmaDocument;
  onDoc: (update: (doc: FigmaDocument) => FigmaDocument) => void;
  title: string;
  slug: string;
  system: DesignSystem;
  /** The project open: its save, its publishing, its versions (see useEditSession) */
  session: EditSession;
  undo: () => void;
  redo: () => void;
}) {
  const isPublished = Boolean(session.meta?.published);
  const { theme, toggle: toggleTheme } = useTheme();
  // The language edited: the file's languages are its own (Turkish, English and what was added); one that is gone falls back to the base.
  const [langPicked, setLangPicked] = useState<LangCode>(BASE_LANGUAGE);
  const languages = useMemo(() => languagesOf(file), [file]);
  const lang = languages.some((l) => l.code === langPicked) ? langPicked : BASE_LANGUAGE;
  const account = useAccount();
  const [selection, setSelectionState] = useState<string[]>([]);
  // The view picked at the toolbar's end, kept in the browser. Only the project's own page is a page: the file's other pages always open on the canvas.
  const [pickedMode, setPickedMode] = useState<EditorMode>(() => {
    try { const saved = localStorage.getItem(EDITOR_MODE_KEY); if (saved === "canvas" || saved === "page" || saved === "code") return saved; } catch { /* the canvas */ }
    return "canvas";
  });
  /**
   * A component edited on its own (Assets › Edit component, Go to main
   * component): the canvas shows it alone — a variant's whole set — and edits
   * go to the page it sits on (the file's Components page, out of the list),
   * the open page staying as it was. Its holder's id and that page ("": the
   * project's); it ends when the component is gone (an undo).
   */
  const [isolation, setIsolation] = useState<{ id: string; page: string } | null>(null);
  const isolatedPage = isolation ? (isolation.page ? file.pages?.find((x) => x.id === isolation.page)?.nodes : file.nodes) : undefined;
  const isolatedNode = isolation && isolatedPage ? getNode(isolatedPage, isolation.id) : null;
  const iso = isolatedNode ? isolation : null;
  const mode: EditorMode = iso ? "canvas" : pickedMode === "page" && file.currentPage ? "canvas" : pickedMode;
  const paged = mode === "page";
  // Each view keeps its own place: the canvas its pan and zoom, the page its scroll — in stores of their own, so a wheel tick draws only
  // the canvas again (and the zoom's label), not the whole editor. What places things by the view reads it when it acts (viewNow).
  const [canvasStore] = useState(() => createViewStore({ x: 120, y: 80, zoom: 0.5 }));
  const [pageStore] = useState(() => createViewStore({ x: 0, y: 0, zoom: 1 }));
  const viewStore = paged ? pageStore : canvasStore;
  const viewNow = () => viewStore.get();
  const [tool, setTool] = useState<CanvasTool>("move");
  const [leftTab, setLeftTab] = useState<LeftTab>("file");
  // The Components tab is the site's library page open on the canvas: the tab follows the page (Images stays beside either).
  const inLibrary = file.currentPage === COMPONENTS_PAGE_ID;
  const tab: LeftTab = inLibrary ? (leftTab === "images" ? "images" : "components") : leftTab === "components" ? "file" : leftTab;
  // Where the canvas was (its page, its pan and zoom) when the library page was opened: back there when it is left.
  const libraryReturn = useRef<{ page: string; view: CanvasView } | null>(null);
  const [rightTab, setRightTab] = useState<"design" | "prototype">("design");
  const [open, setOpen] = useState<Set<string>>(() => new Set([file.pageId]));
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  // The interaction whose window is open (its row, or its noodle on the canvas, clicked).
  const [reactionOpen, setReactionOpen] = useState<string | null>(null);
  const [variablesOpen, setVariablesOpen] = useState(false);
  // The Page Editor's preview width: the page as the site lays it out on a tablet or a phone (its own width when unset).
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  // A word for the user that goes on its own (what an export left out, an upload that failed…).
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // The editor's settings (the mouse), kept in the browser; their window.
  const [settings, changeSetting] = useEditorSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The Images panel, mounted the first time it is opened and kept: its pictures load once (see ImagesPanel).
  const [imagesOpened, setImagesOpened] = useState(false);
  // A padding / gap field focused in the panel: what the canvas highlights.
  const [layoutFocus, setLayoutFocus] = useState<{ pads?: ("top" | "right" | "bottom" | "left")[]; gap?: boolean } | null>(null);
  // The sidebars' widths: dragged at their inner edge (Figma lets both be resized), kept in the browser.
  const [panelWidths, setPanelWidths] = useState<{ left: number; right: number }>(() => {
    try { const saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? ""); if (saved && typeof saved.left === "number" && typeof saved.right === "number") return saved; } catch { /* the defaults */ }
    return { left: 240, right: 240 };
  });
  // Hide UI: the canvas spans the window, but nothing on it moves. The left side's room is taken off the view's x (the canvas content
  // stays where it was on the screen), and the bars centred on the canvas keep their centre — what the panels took from each side.
  const hiddenShift = minimized ? (NAV_WIDTH + panelWidths.left - panelWidths.right) / 2 : 0;
  const wasMinimized = useRef(false);
  useLayoutEffect(() => {
    if (wasMinimized.current === minimized) return;
    wasMinimized.current = minimized;
    const left = NAV_WIDTH + panelWidths.left;
    canvasStore.set((v) => ({ ...v, x: v.x + (minimized ? left : -left) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the toggle moves the view (the widths are fixed while the panels are hidden)
  }, [minimized]);
  const resizePanel = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidths[side];
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.max(200, Math.min(480, side === "left" ? startW + ev.clientX - startX : startW - (ev.clientX - startX))));
      setPanelWidths((p) => (p[side] === w ? p : { ...p, [side]: w }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanelWidths((p) => { try { localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(p)); } catch { /* ignore */ } return p; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Figma's Find in the layers: the rows whose names match.
  const [query, setQuery] = useState<string | null>(null);
  const clipboard = useRef<SceneNode[]>([]);
  const zoomActions = useRef<ZoomActions | null>(null);
  const { variables, textStyles } = system;
  const byId = useMemo(() => byIdMap(variables), [variables]);
  // The open page: the file itself (the project's page) or one of its other pages — `doc` is what the editor draws and edits;
  // a component edited on its own, it alone of its page.
  const doc = useMemo<FigmaDocument>(() => {
    const at = iso ? iso.page : file.currentPage;
    const pg = at ? file.pages?.find((x) => x.id === at) : undefined;
    const open = pg ? { ...file, nodes: pg.nodes, background: pg.background } : file;
    return isolatedNode ? { ...open, nodes: [isolatedNode] } : open;
  }, [file, iso, isolatedNode]);
  const nodes = doc.nodes;
  // The Page Editor's page: the frame the site shows. It stays whole and in its place there — it can't be deleted, moved, grouped or copied.
  const pageRoot = paged ? doc.pageId : null;
  // The root of what is shown — the Page Editor's page, a component edited on its own: it stays (not deleted, copied, grouped, unwrapped).
  const isRoot = (id: string) => id === pageRoot || id === iso?.id;
  const notRoot = (id: string) => !id.includes("/") && !isRoot(id);
  // Where a layer goes with no frame to go into: the Page Editor's page; the component edited on its own (a set's first variant) — never
  // beside it, out of sight.
  const insertRoot = pageRoot ?? (isolatedNode ? (isolatedNode.type === "componentSet" ? variantsOf(isolatedNode)[0]?.id ?? isolatedNode.id : isolatedNode.id) : null);
  // The project's own layers — the site's page frame, its Overview and the Overview's component (see overview.ts): never deleted, wrapped,
  // unwrapped, detached or moved off.
  const stays = useMemo(() => fixedIds(file), [file]);
  const removable = (id: string) => notRoot(id) && !stays.has(id);
  /** Where a layer may go among `siblings`: never before the page's Overview, its first. */
  const fromIndex = (siblings: readonly SceneNode[], index?: number) => (index !== undefined && index < 1 && leadsWithOverview(siblings) ? 1 : index);
  // Every page's nodes: where instances find their main components (the Components page's too).
  const library = useMemo(() => libraryOf(file), [file]);
  /**
   * Would putting `inserted` into `into` make a component draw itself — an
   * instance in it (or in what its instances draw, all the way down) of the
   * component `into` is in, or of a variant of its set? Such a component
   * would draw without end (and the tab with it).
   */
  const createsCycle = (into: string | null, inserted: readonly SceneNode[]) => {
    if (!into) return false;
    const holders = new Set<string>();
    for (const id of findNode(library, into)?.path ?? []) {
      const n = getNode(library, id);
      if (n?.type === "component") {
        holders.add(n.id);
        const set = setOf(library, n.id);
        if (set) variantsOf(set).forEach((v) => holders.add(v.id));
      } else if (n?.type === "componentSet") variantsOf(n).forEach((v) => holders.add(v.id));
    }
    if (!holders.size) return false;
    const seen = new Set<string>();
    const draws = (componentId: string): boolean => {
      if (holders.has(componentId)) return true;
      if (seen.has(componentId)) return false;
      seen.add(componentId);
      const main = findComponent(library, componentId);
      if (!main) return false;
      let hit = false;
      walk(main.children, (n) => {
        if (hit || n.type !== "instance") return;
        // Its component — and what an instance swap property may show instead.
        const shown = [n.mainId, ...Object.values(n.props ?? {})].filter((v): v is string => typeof v === "string" && Boolean(findComponent(library, v)));
        if (shown.some(draws)) hit = true;
      });
      return hit;
    };
    let hit = false;
    walk(inserted, (n) => {
      if (hit) return;
      if (n.type === "instance" && n.mainId && draws(n.mainId)) hit = true;
      else if (n.type === "component" && holders.has(n.id)) hit = true;
    });
    return hit;
  };
  /** What an instance swap would put in: an instance of `componentId` (for createsCycle). */
  const swapProbe = (componentId: string): SceneNode => ({ ...makeFrame("Swap", 0, 0, 1, 1), type: "instance", mainId: componentId });
  // The page edits go to: a component edited on its own, its page; else the open one.
  const editedPage = useRef<string | null>(null);
  useLayoutEffect(() => {
    editedPage.current = iso ? iso.page : null;
  });
  const pageOf = (d: FigmaDocument) => editedPage.current ?? d.currentPage ?? "";
  const setNodes = useCallback((update: (nodes: SceneNode[]) => SceneNode[]) => onDoc((d) => {
    const at = editedPage.current ?? d.currentPage;
    const pg = at ? d.pages?.find((x) => x.id === at) : undefined;
    if (pg) {
      const next = update(pg.nodes);
      return next === pg.nodes ? d : { ...d, pages: d.pages!.map((x) => (x.id === pg.id ? { ...x, nodes: next } : x)) };
    }
    const next = update(d.nodes);
    return next === d.nodes ? d : { ...d, nodes: next };
  }), [onDoc]);
  const pages = useMemo(() => [{ id: "", name: file.pageName ?? getNode(file.nodes, file.pageId)?.name ?? title ?? "Page 1" }, ...(file.pages ?? []).map((pg) => ({ id: pg.id, name: pg.name }))], [file, title]);
  const [renamingPage, setRenamingPage] = useState<string | null>(null);
  const openTab = (next: LeftTab) => {
    if (next === "components") {
      setLeftTab("components");
      if (!inLibrary) switchPage(COMPONENTS_PAGE_ID);
      return;
    }
    setLeftTab(next);
    if (next === "images") setImagesOpened(true);
    // The file and the assets are the project's: the library page is left for the page it was opened from.
    if (inLibrary && next !== "images") switchPage(libraryReturn.current?.page ?? "");
  };
  const switchPage = (id: string) => {
    const from = file.currentPage ?? "";
    setSelectionState([]);
    setEditing(null);
    // Another page: no component edited on its own any more (nor one that went, to come back with a redo).
    setIsolation(null);
    if (id === COMPONENTS_PAGE_ID && from !== id) {
      libraryReturn.current = { page: from, view: canvasStore.get() };
      requestAnimationFrame(() => requestAnimationFrame(() => zoomActions.current?.fitAll()));
    } else if (from === COMPONENTS_PAGE_ID && id !== from && libraryReturn.current) {
      const { view } = libraryReturn.current;
      libraryReturn.current = null;
      canvasStore.set(() => view);
    }
    onDoc((d) => ({ ...d, currentPage: id || undefined }));
  };

  // ── A component edited on its own ──
  // The canvas's pan and zoom before: back as it ends.
  const viewBefore = useRef<CanvasView | null>(null);
  const editComponent = (id: string) => {
    const own = getNode(library, id);
    const holder = setOf(library, id) ?? findComponent(library, id) ?? (own?.type === "componentSet" ? own : null);
    const page = holder ? pageOfNode(file, holder.id) : null;
    if (!holder || page === null) return;
    // The component on the library page, selected and in view (the Components tab).
    if (iso) endIsolation();
    setLeftTab("components");
    if (page !== (file.currentPage ?? "")) switchPage(page);
    setSelectionState([id]);
    setEditing(null);
    setTool("move");
    const its = page ? file.pages?.find((x) => x.id === page)?.nodes ?? [] : file.nodes;
    const holders = findNode(its, id)?.path ?? [];
    setOpen((prev) => new Set([...prev, ...holders]));
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => zoomActions.current?.fitSelection())));
  };
  /**
   * A component taken out of the site's library (Assets › Delete component):
   * a variant from its set — the set itself when it is its only one; the
   * project's own (the Overview's) stays. Its instances — on this project's
   * pages, in other components, in the projects opened later — become
   * frames of their own, looking as they did (one undo brings it back).
   */
  const deleteComponent = (id: string) => {
    const set = setOf(library, id);
    const holder = set && variantsOf(set).length === 1 ? set.id : id;
    const node = getNode(library, holder);
    if (!node || stays.has(id) || stays.has(holder)) return;
    const count = instancesOf(library, new Set(componentIds(node)));
    const used = count ? `${count} instance${count === 1 ? "" : "s"} of it here will become frames of their own (other projects' too, when they are opened).` : "No instance of it is used in this project (other projects' become frames of their own when they are opened).";
    if (!window.confirm(`Delete “${node.name}” from the site's components?\n\n${used}\n\nUndo brings it back until you leave.`)) return;
    if (iso && (iso.id === holder || iso.id === id)) endIsolation();
    system.deleteComponent(holder);
  };
  const endIsolation = () => {
    setIsolation(null);
    setSelectionState([]);
    setEditing(null);
    const before = viewBefore.current;
    if (before) canvasStore.set(() => before);
    viewBefore.current = null;
  };

  /**
   * A layer picked from Find: selected on its page, in view — one of the
   * file's components (their page isn't one of the list) edited on its own.
   */
  const openNode = (page: string, id: string) => {
    const list = page ? file.pages?.find((x) => x.id === page)?.nodes ?? [] : file.nodes;
    const found = findNode(list, id);
    if (!found) return;
    const top = found.path[0];
    if (iso && !(iso.page === page && found.path.includes(iso.id))) endIsolation();
    if (!(iso && iso.page === page && found.path.includes(iso.id)) && (file.currentPage ?? "") !== page) switchPage(page);
    // In the Page Editor, a layer beside the page frame is on the canvas.
    if (!iso && paged && page === "" && top !== file.pageId) setMode("canvas");
    setSelectionState([id]);
    setEditing(null);
    setOpen((prev) => new Set([...prev, ...found.path.slice(0, -1)]));
    requestAnimationFrame(() => requestAnimationFrame(() => zoomActions.current?.fitSelection()));
  };

  const setMode = (next: EditorMode) => {
    // Another view picked: the component edited on its own is done.
    if (isolation && next !== "canvas") endIsolation();
    setPickedMode(next);
    try { localStorage.setItem(EDITOR_MODE_KEY, next); } catch { /* ignore */ }
    setEditing(null);
    setTool("move");
    if (next !== "page") return;
    // The Page Editor shows the project's page: it opens it — on it, what sits beside the page frame (not shown there) leaves the selection.
    if (file.currentPage) switchPage("");
    else setSelectionState((sel) => sel.filter((id) => findNode(file.nodes, id.split("/")[0])?.path[0] === file.pageId));
  };
  const addPage = () => {
    const id = nid("p");
    // Numbered after the pages listed (the file's Components page isn't one).
    let n = pages.filter((pg) => pg.id !== COMPONENTS_PAGE_ID).length + 1;
    while (pages.some((pg) => pg.name === `Page ${n}`)) n++;
    onDoc((d) => ({ ...d, pages: [...(d.pages ?? []), { id, name: `Page ${n}`, nodes: [] }], currentPage: id }));
    setSelectionState([]);
  };
  const renamePage = (id: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    onDoc((d) => (id ? { ...d, pages: d.pages?.map((pg) => (pg.id === id ? { ...pg, name: clean } : pg)) } : { ...d, pageName: clean }));
  };
  const removePage = (id: string) => {
    if (!id) return;
    onDoc((d) => ({ ...d, pages: d.pages?.filter((pg) => pg.id !== id), currentPage: d.currentPage === id ? undefined : d.currentPage }));
    setSelectionState([]);
  };

  // A gone node leaves the selection.
  const selected = useMemo(() => selection.filter((id) => (id.includes("/") ? getNode(nodes, id.split("/")[0]) : getNode(nodes, id))), [selection, nodes]);
  const setSelection = useCallback((ids: string[]) => {
    setSelectionState(ids);
    setEditing(null);
    // The layers holding it open — inside an instance, the instance and every holder down to it too.
    setOpen((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        const slash = id.indexOf("/");
        const own = slash < 0 ? id : id.slice(0, slash);
        findNode(nodes, own)?.path.slice(0, -1).forEach((p) => next.add(p));
        if (slash < 0) continue;
        next.add(own);
        const rest = id.slice(slash + 1);
        for (let i = 0; i < rest.length; i++) if (rest[i] === "/" || rest[i] === PATH_SEP) next.add(`${own}/${rest.slice(0, i)}`);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]);

  // The selected row stays in sight in the layers — when the selection changes (not on every edit of the file).
  const selectedKey = selected.join(" ");
  useEffect(() => {
    requestAnimationFrame(() => document.querySelector("[data-left-panel] [data-selected-row]")?.scrollIntoView({ block: "nearest" }));
  }, [selectedKey]);

  const latest = useRef({ selected, nodes, doc, tool, editing, lang, previewing, mode, pageRoot, isolated: Boolean(iso), library, viewStore });
  useEffect(() => {
    latest.current = { selected, nodes, doc, tool, editing, lang, previewing, mode, pageRoot, isolated: Boolean(iso), library, viewStore };
  });

  // ── Editing ──
  // A node changed wherever it sits — a main component on the Components page from an instance's panel too.
  const patch = useCallback((id: string, p: Partial<SceneNode>) => {
    if (id.includes("/")) return;
    onDoc((d) => updateAnywhere(d, id, (n) => ({ ...n, ...p } as SceneNode)));
  }, [onDoc]);
  const override = useCallback((compositeId: string, p: NodeOverride) => {
    const slash = compositeId.indexOf("/");
    const instanceId = compositeId.slice(0, slash);
    const keys = compositeId.slice(slash + 1).split("/");
    setNodes((list) => updateNode(list, instanceId, (n) => (n.type !== "instance" ? n : { ...n, overrides: withOverride(n.overrides, keys, p) })));
  }, [setNodes]);

  /**
   * Typing a text inside an instance: its words — the instance's value of the
   * text property they come from, as Figma's (an override of them, which
   * would hide the property's, taken off) — or else the instance's override.
   */
  const typeInInstance = useCallback((compositeId: string, text: string, lang: LangCode) => onDoc((d) => {
    const at = layerAt(libraryOf(d), compositeId);
    if (!at) return d;
    const prop = at.keys.length === 1 && at.node.type === "text" ? at.node.charactersProp : undefined;
    return updateAnywhere(d, at.instance.id, (n) => {
      if (n.type !== "instance") return n;
      if (!prop) return { ...n, overrides: withOverride(n.overrides, at.keys, wordsPatch(overrideAt(n.overrides, at.keys) ?? {}, lang, text)) };
      // Bound to a text property: the words are the instance's value of it — what it overrode of the layer itself, in this language, comes off.
      const key = at.keys[0];
      const overrides = { ...n.overrides };
      const own = overrides[key] ? { ...overrides[key] } : undefined;
      if (own) {
        if (lang === BASE_LANGUAGE) delete own.characters;
        else if (lang === "en") delete own.charactersEn;
        else if (own.translations) {
          const { [lang]: gone, ...rest } = own.translations;
          void gone;
          if (Object.keys(rest).length) own.translations = rest;
          else delete own.translations;
        }
        if (Object.keys(own).length) overrides[key] = own;
        else delete overrides[key];
      }
      return { ...n, ...(lang === BASE_LANGUAGE ? { props: { ...n.props, [prop]: text } } : propsPatch(n, lang, prop, text)), overrides: Object.keys(overrides).length ? overrides : undefined };
    });
  }), [onDoc]);

  const deleteSelection = () => {
    const ids = new Set(latest.current.selected.filter(removable));
    if (!ids.size) return;
    // A main component (a set, a variant) goes as Assets' Delete component does: its instances keep how they look, as frames of their own.
    const mains = [...ids].filter((id) => { const n = getNode(nodes, id); return n?.type === "component" || n?.type === "componentSet"; });
    if (mains.length) {
      const count = instancesOf(library, new Set(mains.flatMap((id) => { const n = getNode(library, id); return n ? componentIds(n) : []; })));
      const names = mains.map((id) => `“${getNode(nodes, id)?.name}”`).join(", ");
      if (!window.confirm(`Delete ${names} from the site's components?\n\n${count ? `${count} instance${count === 1 ? "" : "s"} of ${mains.length === 1 ? "it" : "them"} here will become frames of their own (other projects' too, when they are opened).` : "No instance is used in this project (other projects' become frames of their own when they are opened)."}\n\nUndo brings ${mains.length === 1 ? "it" : "them"} back until you leave.`)) return;
      for (const id of mains) {
        const set = setOf(library, id);
        system.deleteComponent(set && variantsOf(set).length === 1 ? set.id : id);
        ids.delete(id);
      }
    }
    if (ids.size) setNodes((list) => removeNodes(list, ids));
    setSelection([]);
  };

  /** A copy of each selected top, right after it — a main component's copy is an instance (as Figma's ⌘D). */
  const duplicateSelection = () => {
    const tops = topmost(nodes, latest.current.selected.filter(notRoot));
    if (!tops.length) return;
    const made: string[] = [];
    setNodes((list) => {
      let next = list;
      for (const t of tops) {
        const found = findNode(next, t.node.id);
        if (!found) continue;
        // A variant: another variant of its set, right after it (its first property's value a new one), as Figma's.
        if (found.node.type === "component" && found.parent?.type === "componentSet") {
          const set = found.parent;
          const variant = cloneNode(found.node, true);
          variant.reactions = undefined;
          const first = found.node.variant?.[0];
          if (first) variant.variant = (found.node.variant ?? []).map((v, i) => (i === 0 ? { ...v, value: nextValue(set, first.property) } : v));
          made.push(variant.id);
          next = insertNode(next, set.id, variant, found.index + 1);
          continue;
        }
        const copy = found.node.type === "component" ? makeInstance(found.node, found.node.x, found.node.y + found.node.height + 24) : cloneNode(found.node);
        made.push(copy.id);
        next = insertNode(next, found.parent?.id ?? null, copy, found.index + 1);
      }
      return next;
    });
    if (made.length) setSelection(made);
  };

  /** Copy: the selected layers kept here — and on the system's clipboard too (as a marked text), so another tab or project pastes them. */
  const copySelection = (data?: DataTransfer | null) => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
    // Nothing of its own selected (a layer inside an instance): the clipboard stays as it was.
    if (!tops.length) return false;
    clipboard.current = tops.map((t) => structuredClone(t.node));
    const text = CLIPBOARD_MARK + JSON.stringify(clipboard.current);
    if (data) data.setData("text/plain", text);
    else navigator.clipboard?.writeText(text).catch(() => { /* this tab's copy serves */ });
    return true;
  };
  /**
   * A copy of a layer as Figma makes one (a paste, a ⌥-drag): a main
   * component of the file gives an instance of it — a set's, of its default
   * (first) variant; anything else a copy of its own.
   */
  const copyOf = (n: SceneNode): SceneNode => {
    const real = getNode(library, n.id);
    const main = real?.type === "component" ? real : real?.type === "componentSet" ? variantsOf(real)[0] : undefined;
    if (main && real && real.type === n.type) return { ...makeInstance(main, n.x, n.y), name: real.type === "componentSet" ? real.name : main.name };
    return cloneNode(n);
  };
  const paste = (from?: SceneNode[]) => {
    const source = from ?? clipboard.current;
    if (!source.length) return;
    const target = selected[0] && !selected[0].includes("/") ? findNode(nodes, selected[0]) : null;
    const into = target && (target.node.type === "frame" || target.node.type === "component") ? target.node.id : target?.parent?.id ?? insertRoot;
    const copies = source.map(copyOf);
    if (createsCycle(into, copies)) return;
    setNodes((list) => copies.reduce((acc, c) => insertNode(acc, into, c), list));
    setSelection(copies.map((c) => c.id));
  };
  /** A paste from the system's clipboard: layers copied in another tab, a picture (uploaded, placed), or words (a new text). */
  const pasteFrom = (data: DataTransfer) => {
    const text = data.getData("text/plain");
    if (text.startsWith(CLIPBOARD_MARK)) {
      try {
        const list = JSON.parse(text.slice(CLIPBOARD_MARK.length)) as SceneNode[];
        if (Array.isArray(list) && list.every((n) => n && typeof n.id === "string" && typeof n.type === "string")) {
          clipboard.current = list;
          return paste(list);
        }
      } catch { /* not ours after all */ }
    }
    const picture = [...data.files].find((f) => f.type.startsWith("image/"));
    if (picture) return void placeFile(picture);
    if (text.trim()) {
      const node = makeText(0, 0, text.trim());
      node.name = layerName(text.trim().slice(0, 40));
      if (text.trim().length > 40) { node.width = 320; node.textAutoResize = "height"; }
      return paste([node]);
    }
    paste();
  };

  /** ⌘G a group, ⌥⌘G a frame — or ⇧A: a frame with auto layout inferred from how the layers sit (their direction and gaps), hugging them, as Figma's. Its id — null when nothing was grouped. */
  const groupSelection = (kind: "group" | "frame" | "auto"): string | null => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
    if (!tops.length || tops.some((t) => isRoot(t.node.id) || stays.has(t.node.id))) return null;
    const parentId = tops[0].parent?.id ?? null;
    if (tops.some((t) => (t.parent?.id ?? null) !== parentId)) return null;
    const parentRect = parentId ? domRect(parentId) : { x: 0, y: 0, w: 0, h: 0 };
    // In their order in the parent (the group keeps how they stack), each as drawn — a hidden one at its own place.
    const rects: { t: (typeof tops)[number]; r: Rect }[] = [...tops].sort((a, b) => a.index - b.index).map((t) => ({ t, r: rectOf(t.node, parentRect) }));
    if (!rects.length) return null;
    const x = Math.min(...rects.map((x) => x.r.x));
    const y = Math.min(...rects.map((x) => x.r.y));
    const right = Math.max(...rects.map((x) => x.r.x + x.r.w));
    const bottom = Math.max(...rects.map((x) => x.r.y + x.r.h));
    const frame = makeFrame(kind === "group" ? nextName(nodes, "Group") : nextName(nodes, "Frame"), x - (parentRect?.x ?? 0), y - (parentRect?.y ?? 0), right - x, bottom - y);
    if (kind !== "frame") frame.fills = [];
    frame.clipsContent = false;
    frame.children = rects.map(({ t, r }) => ({ ...t.node, x: Math.round(r.x - x), y: Math.round(r.y - y), sizingH: undefined, sizingV: undefined }));
    if (kind === "auto") {
      // The direction the layers spread in; the gap as the mean space between them along it.
      const mode: "horizontal" | "vertical" = right - x >= bottom - y || rects.length === 1 ? "horizontal" : "vertical";
      const sorted = [...frame.children].sort((a, b) => (mode === "vertical" ? a.y - b.y : a.x - b.x));
      const gaps = sorted.slice(1).map((c, i) => (mode === "vertical" ? c.y - (sorted[i].y + sorted[i].height) : c.x - (sorted[i].x + sorted[i].width)));
      const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 10;
      frame.children = sorted;
      frame.layoutMode = mode;
      frame.itemSpacing = { value: gap };
      frame.sizingH = "hug";
      frame.sizingV = "hug";
    }
    const ids = new Set(tops.map((t) => t.node.id));
    // Where the topmost of them was (as Figma's): its place once they are all taken out.
    const index = Math.max(...tops.map((t) => t.index)) - (tops.length - 1);
    setNodes((list) => insertNode(removeNodes(list, ids), parentId, frame, index));
    setSelection([frame.id]);
    return frame.id;
  };

  const ungroup = () => {
    const id = selected[0];
    const found = id && !id.includes("/") ? findNode(nodes, id) : null;
    if (!found || !isFrameLike(found.node) || found.node.type === "instance" || isRoot(id) || stays.has(id)) return;
    const parentRect = found.parent ? domRect(found.parent.id) : { x: 0, y: 0, w: 0, h: 0 };
    const frameRect = rectOf(found.node, parentRect);
    // Each child where it was drawn, now in the frame's parent — a hidden one at its own place in the frame, its own size.
    const children = found.node.children.map((c) => {
      const r = rectOf(c, frameRect);
      const origin = parentRect ?? { x: 0, y: 0 };
      return { ...c, x: Math.round(r.x - origin.x), y: Math.round(r.y - origin.y), width: Math.round(r.w), height: Math.round(r.h), sizingH: undefined, sizingV: undefined };
    });
    setNodes((list) => children.reduce((acc, c, i) => insertNode(acc, found.parent?.id ?? null, c, found.index + i), removeNodes(list, new Set([id]))));
    setSelection(children.map((c) => c.id));
  };

  const createComponent = () => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
    if (!tops.length || tops.some((t) => stays.has(t.node.id))) return;
    // A set or one of its variants selected: ⌥⌘K adds a variant (as Figma's).
    if (tops.length === 1 && (tops[0].node.type === "componentSet" || (tops[0].node.type === "component" && tops[0].parent?.type === "componentSet"))) return addVariant(tops[0].node.id);
    if (tops.some((t) => t.node.type === "component" || t.node.type === "componentSet")) return;
    if (tops.length === 1 && tops[0].node.type === "frame") {
      patch(tops[0].node.id, { type: "component" } as Partial<SceneNode>);
      return;
    }
    // The frame just made (none: nothing becomes a component) is the component.
    const made = groupSelection("frame");
    if (made) requestAnimationFrame(() => patch(made, { type: "component" } as Partial<SceneNode>));
  };

  /** Figma's Create multiple components: each selected layer a component of its own — a frame in place, anything else in a component frame of its size. */
  const createMultipleComponents = () => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/"))).filter((t) => !stays.has(t.node.id) && !isRoot(t.node.id) && t.node.type !== "component" && t.node.type !== "componentSet" && t.node.type !== "instance");
    if (!tops.length) return;
    setNodes((list) => tops.reduce((acc, t) => updateNode(acc, t.node.id, (n) => {
      if (n.type === "frame") return { ...n, type: "component" } as SceneNode;
      const holder = makeFrame(n.name, n.x, n.y, n.width, n.height);
      return { ...holder, type: "component", fills: [], clipsContent: false, sizingH: n.sizingH, sizingV: n.sizingV, children: [{ ...n, x: 0, y: 0, sizingH: undefined, sizingV: undefined }] } as SceneNode;
    }), list));
  };

  const detach = () => {
    const id = selected[0];
    const node = id && !id.includes("/") ? getNode(nodes, id) : null;
    if (!node || node.type !== "instance" || stays.has(id)) return;
    const resolved = resolveInstance(library, node);
    if (!resolved) return patch(id, { type: "frame", mainId: undefined, overrides: undefined } as Partial<SceneNode>);
    const detached = cloneNode({ ...resolved, type: "frame", mainId: undefined, overrides: undefined, props: undefined, propsEn: undefined, propsI18n: undefined, mainProp: undefined } as FrameNode);
    detached.id = node.id;
    setNodes((list) => updateNode(list, id, () => detached));
  };

  const addVariant = (id: string) => {
    const found = findNode(nodes, id);
    if (!found) return;
    const node = found.node;
    if (node.type === "componentSet") {
      const last = variantsOf(node).at(-1);
      if (!last) return;
      // The Overview's parts stay its in a new variant (see overview.ts).
      const copy = cloneNode(last, true);
      copy.variant = (last.variant ?? []).map((v, i) => (i === 0 ? { ...v, value: nextValue(node, v.property) } : v));
      copy.reactions = undefined;
      setNodes((list) => insertNode(list, node.id, copy));
      setSelection([copy.id]);
      return;
    }
    if (node.type !== "component") return;
    if (found.parent?.type === "componentSet") return addVariant(found.parent.id);
    // A component on its own: it becomes the first variant of a new set, with a copy as the second.
    const set = makeFrame(node.name, node.x, node.y, node.width + 32, node.height * 2 + 48);
    set.type = "componentSet";
    set.fills = [];
    set.clipsContent = false;
    set.layoutMode = "vertical";
    set.itemSpacing = { value: 16 };
    set.paddingTop = set.paddingRight = set.paddingBottom = set.paddingLeft = { value: 16 };
    set.sizingH = "hug";
    set.sizingV = "hug";
    // Its properties become the set's: what every variant's instances are set by (see propertyHolder).
    if (node.properties?.length) set.properties = node.properties;
    const first: FrameNode = { ...node, x: 0, y: 0, properties: undefined, variant: [{ property: "Property 1", value: "Default" }] };
    const second = cloneNode(first, true);
    second.variant = [{ property: "Property 1", value: "Variant 2" }];
    set.children = [first, second];
    // Where it sits, on the page as it is (what is shown may be it alone).
    setNodes((list) => {
      const f = findNode(list, node.id);
      return f ? insertNode(removeNodes(list, new Set([node.id])), f.parent?.id ?? null, set, f.index) : list;
    });
    // Edited on its own: the set is now what is shown.
    if (iso?.id === node.id) setIsolation({ id: set.id, page: iso.page });
    setSelection([second.id]);
  };
  const nextValue = (set: FrameNode, property: string) => {
    const values = variantProperties(set).find((p) => p.name === property)?.values ?? [];
    let n = values.length + 1;
    while (values.includes(`Variant ${n}`)) n++;
    return `Variant ${n}`;
  };

  const combineAsVariants = () => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/"))).filter((t) => t.node.type === "component" && t.parent?.type !== "componentSet");
    if (tops.length < 2) return;
    const parentId = tops[0].parent?.id ?? null;
    const x = Math.min(...tops.map((t) => t.node.x));
    const y = Math.min(...tops.map((t) => t.node.y));
    const set = makeFrame(tops[0].node.name, x, y, 100, 100);
    set.type = "componentSet";
    set.fills = [];
    set.clipsContent = false;
    set.layoutMode = "vertical";
    set.itemSpacing = { value: 16 };
    set.paddingTop = set.paddingRight = set.paddingBottom = set.paddingLeft = { value: 16 };
    set.sizingH = "hug";
    set.sizingV = "hug";
    // The components' properties, each once, become the set's (see propertyHolder).
    const properties = tops.flatMap((t) => (t.node as FrameNode).properties ?? []).filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
    if (properties.length) set.properties = properties;
    const parts = tops.map((t) => t.node.name.split("/").map((p) => p.trim()));
    const slashed = parts.every((p) => p.length > 1 && p.length === parts[0].length && p[0] === parts[0][0]);
    if (slashed) set.name = parts[0][0];
    set.children = tops.map((t, i) => ({
      ...(t.node as FrameNode),
      x: 0,
      y: 0,
      properties: undefined,
      variant: slashed ? parts[i].slice(1).map((value, k) => ({ property: `Property ${k + 1}`, value })) : [{ property: "Property 1", value: t.node.name }],
    }));
    setNodes((list) => {
      const real = tops.map((t) => findNode(list, t.node.id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
      if (!real.length) return list;
      return insertNode(removeNodes(list, new Set(real.map((f) => f.node.id))), real[0].parent?.id ?? parentId, set, Math.min(...real.map((f) => f.index)));
    });
    setSelection([set.id]);
  };

  const pageColors = useMemo(() => colorsIn(nodes).slice(0, 32), [nodes]);
  const ops: EditorOps = {
    patch,
    // Several layers at once: each takes what applies to its kind (a text no strokes, a shape no typography, a shape no layout).
    patchMany: (ids, p) => setNodes((list) => updateNodes(list, ids.filter((id) => !id.includes("/")), (n) => {
      const next: Record<string, unknown> = { ...n };
      for (const [k, v] of Object.entries(p)) {
        if (n.type === "text" ? TEXT_ONLY.has(k) || !(GEOMETRY_ONLY.has(k) || FRAME_ONLY.has(k)) : !TEXT_ONLY.has(k) && (isFrameLike(n) || !FRAME_ONLY.has(k))) next[k] = v;
      }
      return next as unknown as SceneNode;
    })),
    updateMany: (ids, update) => setNodes((list) => updateNodes(list, ids.filter((id) => !id.includes("/")), update)),
    override,
    align: (kind) => {
      const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
      if (!tops.length) return;
      // Layers of different parents: lined up as drawn on the canvas, each placed back in its own parent.
      if (tops.some((t) => (t.parent?.id ?? null) !== (tops[0].parent?.id ?? null))) {
        const placed = tops.map((t) => {
          const parentRect = t.parent ? domRect(t.parent.id) : { x: 0, y: 0, w: 0, h: 0 };
          return { t, parentRect, r: rectOf(t.node, parentRect) };
        });
        const left = Math.min(...placed.map((p) => p.r.x));
        const top = Math.min(...placed.map((p) => p.r.y));
        const right = Math.max(...placed.map((p) => p.r.x + p.r.w));
        const bottom = Math.max(...placed.map((p) => p.r.y + p.r.h));
        const moves = new Map<string, Partial<SceneNode>>();
        for (const { t, parentRect, r } of placed) {
          // One in an auto layout has no place of its own to change.
          if (t.parent && t.parent.layoutMode !== "none" && !t.node.absolute) continue;
          const o = parentRect ?? { x: 0, y: 0 };
          const p: Partial<SceneNode> = {};
          if (kind === "left") p.x = Math.round(left - o.x);
          if (kind === "hcenter") p.x = Math.round(left + (right - left - r.w) / 2 - o.x);
          if (kind === "right") p.x = Math.round(right - r.w - o.x);
          if (kind === "top") p.y = Math.round(top - o.y);
          if (kind === "vcenter") p.y = Math.round(top + (bottom - top - r.h) / 2 - o.y);
          if (kind === "bottom") p.y = Math.round(bottom - r.h - o.y);
          moves.set(t.node.id, p);
        }
        setNodes((list) => updateNodes(list, [...moves.keys()], (n) => ({ ...n, ...moves.get(n.id) } as SceneNode)));
        return;
      }
      const parent = tops[0].parent;
      const bounds = tops.length > 1
        ? { x: Math.min(...tops.map((t) => t.node.x)), y: Math.min(...tops.map((t) => t.node.y)), w: Math.max(...tops.map((t) => t.node.x + t.node.width)) - Math.min(...tops.map((t) => t.node.x)), h: Math.max(...tops.map((t) => t.node.y + t.node.height)) - Math.min(...tops.map((t) => t.node.y)) }
        : parent ? { x: 0, y: 0, w: parent.width, h: parent.height } : null;
      if (!bounds) return;
      setNodes((list) => tops.reduce((acc, t) => updateNode(acc, t.node.id, (n) => {
        const p: Partial<SceneNode> = {};
        if (kind === "left") p.x = bounds.x;
        if (kind === "hcenter") p.x = Math.round(bounds.x + (bounds.w - n.width) / 2);
        if (kind === "right") p.x = bounds.x + bounds.w - n.width;
        if (kind === "top") p.y = bounds.y;
        if (kind === "vcenter") p.y = Math.round(bounds.y + (bounds.h - n.height) / 2);
        if (kind === "bottom") p.y = bounds.y + bounds.h - n.height;
        return { ...n, ...p } as SceneNode;
      }), list));
    },
    setAutoLayout: (id, mode) => {
      const found = findNode(nodes, id);
      if (!found || !isFrameLike(found.node)) return;
      const frame = found.node;
      if (mode === "none") {
        // Their places as drawn stay.
        const frameRect = domRect(id);
        const pad = { l: numberOf(frame.paddingLeft, byId), t: numberOf(frame.paddingTop, byId) };
        void pad;
        const children = frame.children.map((c) => {
          const r = domRect(c.id);
          return r && frameRect ? { ...c, x: Math.round(r.x - frameRect.x), y: Math.round(r.y - frameRect.y), width: Math.round(r.w), height: Math.round(r.h), sizingH: c.sizingH === "fill" ? undefined : c.sizingH, sizingV: c.sizingV === "fill" ? undefined : c.sizingV } : c;
        });
        const r = domRect(id);
        patch(id, { layoutMode: "none", children, sizingH: frame.sizingH === "hug" ? undefined : frame.sizingH, sizingV: frame.sizingV === "hug" ? undefined : frame.sizingV, width: r ? Math.round(r.w) : frame.width, height: r ? Math.round(r.h) : frame.height } as Partial<SceneNode>);
        return;
      }
      // In the order they sit — the page's Overview kept first.
      const head = leadsWithOverview(frame.children) ? frame.children.slice(0, 1) : [];
      const sorted = [...head, ...frame.children.slice(head.length).sort((a, b) => (mode === "vertical" ? a.y - b.y : a.x - b.x))];
      const gap = sorted.length > 1 ? Math.max(0, Math.round(sorted.slice(1).reduce((sum, c, i) => sum + (mode === "vertical" ? c.y - (sorted[i].y + sorted[i].height) : c.x - (sorted[i].x + sorted[i].width)), 0) / (sorted.length - 1))) : 10;
      const minX = sorted.length ? Math.min(...sorted.map((c) => c.x)) : 0;
      const minY = sorted.length ? Math.min(...sorted.map((c) => c.y)) : 0;
      patch(id, { layoutMode: mode, children: sorted, itemSpacing: { value: gap }, paddingLeft: { value: Math.max(0, minX) }, paddingTop: { value: Math.max(0, minY) }, paddingRight: { value: Math.max(0, minX) }, paddingBottom: { value: Math.max(0, minY) } } as Partial<SceneNode>);
    },
    createComponent,
    detach,
    resetOverrides: () => {
      const id = selected[0];
      if (!id) return;
      // The Overview's changes are the project's title, description and cover: asked first.
      if (isOverviewNode(getNode(nodes, id) ?? undefined) && !window.confirm("Reset the Overview? The project's title, category, year, description and cover go back to the component's sample text.\n\nUndo brings them back.")) return;
      patch(id, { overrides: undefined, props: undefined, propsEn: undefined, propsI18n: undefined } as Partial<SceneNode>);
    },
    resetChange: (id, key) => {
      if (id.includes("/")) {
        const at = layerAt(library, id);
        if (!at) return;
        return patch(at.instance.id, { overrides: withResetAt(at.instance.overrides, at.keys, key) } as Partial<SceneNode>);
      }
      const node = getNode(nodes, id);
      if (node?.type !== "instance") return;
      if (!key && isOverviewNode(node) && !window.confirm("Reset the Overview? The project's title, category, year, description and cover go back to the component's sample text.\n\nUndo brings them back.")) return;
      setNodes((list) => updateNode(list, id, (n) => (n.type === "instance" ? withoutChange(n, key) : n)));
    },
    pushToMain: () => {
      const id = selected[0];
      const node = id && !id.includes("/") ? getNode(nodes, id) : null;
      if (node?.type !== "instance" || !node.mainId || stays.has(node.mainId)) return;
      const main = findComponent(library, node.mainId);
      if (!main) return;
      const holder = setOf(library, main.id) ?? main;
      const props = node.props ?? {};
      onDoc((d) => {
        // The look and words into the main; the property values it set, the properties' defaults (each bound layer then shows it).
        let next = updateAnywhere(d, main.id, (m) => (isFrameLike(m) && node.overrides ? withPushedOverrides(m, node.overrides) : m));
        if (Object.keys(props).length) {
          next = updateAnywhere(next, holder.id, (h) => {
            if (!isFrameLike(h)) return h;
            let out: FrameNode = { ...h, properties: (h.properties ?? []).map((p) => (p.id in props ? { ...p, value: props[p.id] } : p)) };
            for (const [pid, value] of Object.entries(props)) out = applyPropertyValue(out, pid, value);
            return out;
          });
        }
        return updateAnywhere(next, node.id, (n) => (n.type === "instance" ? { ...n, overrides: undefined, props: undefined } : n));
      });
    },
    swapInstance: (id, componentId) => {
      const node = getNode(nodes, id);
      if (node?.type !== "instance" || stays.has(id) || !findComponent(library, componentId) || createsCycle(id, [swapProbe(componentId)])) return;
      // As Figma's swap to another component: only the text changes stay (another variant of the same set keeps them all: swapVariant).
      const textOnly = (o: Record<string, NodeOverride> | undefined): Record<string, NodeOverride> | undefined => {
        if (!o) return undefined;
        const out = Object.fromEntries(Object.entries(o).map(([k, v]) => {
          const kept: NodeOverride = {};
          if (v.characters !== undefined) kept.characters = v.characters;
          if (v.charactersEn !== undefined) kept.charactersEn = v.charactersEn;
          if (v.translations) kept.translations = v.translations;
          const nested = textOnly(v.overrides);
          if (nested) kept.overrides = nested;
          return [k, kept];
        }).filter(([, v]) => Object.keys(v as object).length));
        return Object.keys(out).length ? out : undefined;
      };
      const sameSet = node.mainId && setOf(library, node.mainId) && setOf(library, node.mainId) === setOf(library, componentId);
      patch(id, { mainId: componentId, ...(sameSet ? {} : { overrides: textOnly(node.overrides), props: undefined, propsEn: undefined, propsI18n: undefined }) } as Partial<SceneNode>);
    },
    selectMatching: () => {
      const first = selected[0];
      const target = first ? (first.includes("/") ? layerAt(library, first)?.node : getNode(nodes, first)) : null;
      if (!target) return;
      // Its likes on this page: the same name and kind — inside instances too (as their composite ids).
      const out: string[] = [];
      walk(nodes, (n) => {
        if (n.name === target.name && n.type === target.type) out.push(n.id);
        if (n.type !== "instance") return;
        const resolved = resolveInstance(library, n);
        const visit = (list: SceneNode[], path: string) => {
          for (const c of list) {
            const key = path ? `${path}${PATH_SEP}${c.name}` : c.name;
            if (c.name === target.name && c.type === target.type) out.push(`${n.id}/${key}`);
            if (isFrameLike(c) && c.type !== "instance") visit(c.children, key);
          }
        };
        if (resolved) visit(resolved.children, "");
      });
      if (out.length) setSelection([...new Set(out)]);
    },
    instanceActions: (id) => instanceActions(id),
    select: (ids) => setSelection(ids),
    // The main component, edited on its own (wherever it sits).
    goToMain: () => {
      const node = selected[0] ? getNode(nodes, selected[0].split("/")[0]) : null;
      if (node?.type === "instance" && node.mainId && findComponent(library, node.mainId)) editComponent(node.mainId);
    },
    addVariant,
    combineAsVariants,
    // A variant's values: never the same as another variant's (two variants of one combination — instances could reach only one).
    setVariantValue: (variantId, property, value) => {
      const set = setOf(library, variantId);
      const variant = getNode(nodes, variantId) as FrameNode | null;
      if (!variant) return;
      const combo = (v: FrameNode, override?: string) => JSON.stringify((v.variant ?? []).map((x) => [x.property, x.property === property && override !== undefined ? override : x.value]));
      const others = set ? variantsOf(set).filter((v) => v.id !== variantId).map((v) => combo(v)) : [];
      let next = value.trim() || "Default";
      for (let n = 2; others.includes(combo(variant, next)); n++) next = `${value.trim() || "Default"} ${n}`;
      patch(variantId, { variant: variant.variant?.map((v) => (v.property === property ? { ...v, value: next } : v)) } as Partial<SceneNode>);
    },
    // A property's name: none of the set's others (variant and component properties alike).
    renameProperty: (setId, from, to) => setNodes((list) => updateNode(list, setId, (set) => {
      if (set.type !== "componentSet" || !to.trim() || to.trim() === from) return set;
      const name = freePropertyName({ ...set, children: set.children.map((c) => (c.type === "component" ? { ...c, variant: c.variant?.filter((v) => v.property !== from) } : c)) } as FrameNode, to.trim());
      return { ...set, children: set.children.map((c) => (c.type === "component" ? { ...c, variant: c.variant?.map((v) => (v.property === from ? { ...v, property: name } : v)) } : c)) };
    })),
    // A value's name: one the property already has would make two variants one — numbered instead.
    renameValue: (setId, property, from, to) => setNodes((list) => updateNode(list, setId, (set) => {
      if (set.type !== "componentSet" || !to.trim() || to.trim() === from) return set;
      const values = variantProperties(set).find((p) => p.name === property)?.values ?? [];
      let value = to.trim();
      for (let n = 2; values.includes(value); n++) value = `${to.trim()} ${n}`;
      return { ...set, children: set.children.map((c) => (c.type === "component" ? { ...c, variant: c.variant?.map((v) => (v.property === property && v.value === from ? { ...v, value } : v)) } : c)) };
    })),
    addProperty: (setId) => setNodes((list) => updateNode(list, setId, (set) => {
      if (set.type !== "componentSet") return set;
      const name = freePropertyName(set, `Property ${variantProperties(set).length + 1}`);
      return { ...set, children: set.children.map((c) => (c.type === "component" ? { ...c, variant: [...(c.variant ?? []), { property: name, value: "Default" }] } : c)) };
    })),
    removeProperty: (setId, name) => setNodes((list) => updateNode(list, setId, (set) => (set.type === "componentSet" ? { ...set, children: set.children.map((c) => (c.type === "component" ? { ...c, variant: c.variant?.filter((v) => v.property !== name) } : c)) } : set))),
    // Component properties (booleans, texts, instance swaps): defined on the main component or its set, bound to its layers, valued on each instance.
    setComponentProperties: (holderId, properties) => onDoc((d) => updateAnywhere(d, holderId, (n) => {
      if (!isFrameLike(n)) return n;
      return { ...pruneBindings(n, new Set(properties.map((p) => p.id))), properties: properties.length ? properties : undefined };
    })),
    setPropertyValue: (holderId, propId, value) => {
      // An instance swap's default that would draw the component itself (its own instance, all the way down) is refused: it would draw without end.
      if (typeof value === "string" && findComponent(library, value) && createsCycle(holderId, [swapProbe(value)])) return;
      onDoc((d) => updateAnywhere(d, holderId, (n) => {
        if (!isFrameLike(n)) return n;
        return { ...applyPropertyValue(n, propId, value), properties: (n.properties ?? []).map((p) => (p.id === propId ? { ...p, value } : p)) };
      }));
    },
    bindProperty: (nodeId, kind, propId) => patch(nodeId, { [kind === "visible" ? "visibleProp" : kind === "text" ? "charactersProp" : "mainProp"]: propId } as Partial<SceneNode>),
    typeInInstance,
    languages,
    setLanguage: setLangPicked,
    addLanguage: (language) => {
      onDoc((d) => (languagesOf(d).some((l) => l.code === language.code) ? d : { ...d, languages: [...languagesOf(d), language] }));
      setLangPicked(language.code);
    },
    // Back to the base language; its words in this project go with it — asked first when it has some (undo brings them back). The library's stay: they are every project's.
    removeLanguage: (code) => {
      if (code === BASE_LANGUAGE) return;
      const own = { ...file, nodes: [...file.nodes, ...(file.pages ?? []).filter((pg) => pg.id !== COMPONENTS_PAGE_ID).flatMap((pg) => pg.nodes)] };
      const name = languages.find((l) => l.code === code)?.name ?? code;
      if (writtenLanguages(own).some((l) => l.code === code) && !window.confirm(`Remove ${name}? Its words in this project go with it.\n\nUndo brings them back.`)) return;
      onDoc((d) => withoutLanguage(d, code, COMPONENTS_PAGE_ID));
      setLangPicked(BASE_LANGUAGE);
    },
    setInstanceProp: (instanceId, propId, value, language) => {
      // An instance swap to a component that draws this instance's component (or the one it sits in) is refused: it would draw without end.
      if (typeof value === "string" && findComponent(library, value)) {
        const inst = getNode(library, instanceId);
        if (createsCycle(instanceId, [swapProbe(value)]) || (inst?.type === "instance" && inst.mainId && createsCycle(inst.mainId, [swapProbe(value)]))) return;
      }
      onDoc((d) => updateAnywhere(d, instanceId, (n) => {
        if (n.type !== "instance") return n;
        if (language && language !== BASE_LANGUAGE && typeof value === "string") return { ...n, ...propsPatch(n, language, propId, value) };
        return { ...n, props: { ...n.props, [propId]: value } };
      }));
    },
    swapVariant: (instanceId, property, value) => {
      const instance = getNode(nodes, instanceId);
      const main = instance?.type === "instance" && instance.mainId ? findComponent(library, instance.mainId) : null;
      const set = main ? setOf(library, main.id) : null;
      if (!main || !set) return;
      patch(instanceId, { mainId: pickVariant(set, main, property, value).id } as Partial<SceneNode>);
    },
    setReactions: (nodeId, reactions) => patch(nodeId, { reactions: reactions.length ? reactions : undefined } as Partial<SceneNode>),
    reactionOpen,
    openReaction: setReactionOpen,
    setLayoutFocus,
    preview: (id) => startPreview(id),
    openVariables: () => setVariablesOpen(true),
    setBackground: (color) => onDoc((d) => {
      const at = pageOf(d);
      const pg = at ? d.pages?.find((x) => x.id === at) : undefined;
      return pg ? { ...d, pages: d.pages!.map((x) => (x.id === pg.id ? { ...x, background: color || undefined } : x)) } : { ...d, background: color || undefined };
    }),
    fitToContent: (id) => {
      const f = getNode(nodes, id);
      if (!f || !isFrameLike(f) || !f.children.length) return;
      const kids = f.children;
      const minX = Math.min(...kids.map((c) => c.x));
      const minY = Math.min(...kids.map((c) => c.y));
      const maxX = Math.max(...kids.map((c) => c.x + c.width));
      const maxY = Math.max(...kids.map((c) => c.y + c.height));
      setNodes((list) => updateNode(list, id, (n) => (isFrameLike(n) ? { ...n, x: n.x + minX, y: n.y + minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), children: n.children.map((c) => ({ ...c, x: c.x - minX, y: c.y - minY })) } : n)));
    },
    distribute: (axis) => {
      const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
      if (tops.length < 3) return;
      const sorted = [...tops].sort((a, b) => (axis === "h" ? a.node.x - b.node.x : a.node.y - b.node.y));
      const size = (n: SceneNode) => (axis === "h" ? n.width : n.height);
      const first = sorted[0].node;
      const last = sorted[sorted.length - 1].node;
      const span = (axis === "h" ? last.x + last.width - first.x : last.y + last.height - first.y) - sorted.reduce((sum, t) => sum + size(t.node), 0);
      const gap = span / (sorted.length - 1);
      let at = axis === "h" ? first.x : first.y;
      const places = new Map<string, number>();
      for (const t of sorted) { places.set(t.node.id, Math.round(at)); at += size(t.node) + gap; }
      setNodes((list) => updateNodes(list, sorted.map((t) => t.node.id), (n) => ({ ...n, [axis === "h" ? "x" : "y"]: places.get(n.id) ?? (axis === "h" ? n.x : n.y) })));
    },
    tidy: () => {
      const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
      if (tops.length < 2) return;
      const cols = Math.ceil(Math.sqrt(tops.length));
      const cellW = Math.max(...tops.map((t) => t.node.width)) + 16;
      const cellH = Math.max(...tops.map((t) => t.node.height)) + 16;
      const x0 = Math.min(...tops.map((t) => t.node.x));
      const y0 = Math.min(...tops.map((t) => t.node.y));
      const sorted = [...tops].sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x);
      const places = new Map(sorted.map((t, i) => [t.node.id, { x: x0 + (i % cols) * cellW, y: y0 + Math.floor(i / cols) * cellH }]));
      setNodes((list) => updateNodes(list, sorted.map((t) => t.node.id), (n) => ({ ...n, ...places.get(n.id) })));
    },
    effectStyles: file.effectStyles ?? [],
    createEffectStyle: (nodeId) => {
      const n = getNode(nodes, nodeId);
      if (!n || n.type === "text" || !n.effects?.length) return;
      const id = nid("es");
      const taken = file.effectStyles ?? [];
      let k = taken.length + 1;
      while (taken.some((st) => st.name === `Effect style ${k}`)) k++;
      onDoc((d) => ({ ...d, effectStyles: [...(d.effectStyles ?? []), { id, name: `Effect style ${k}`, effects: n.effects! }] }));
      patch(nodeId, { effectStyle: id } as Partial<SceneNode>);
    },
    applyEffectStyle: (nodeId, styleId) => {
      const st = file.effectStyles?.find((x) => x.id === styleId);
      if (st) patch(nodeId, { effects: st.effects, effectStyle: st.id } as Partial<SceneNode>);
    },
    detachEffectStyle: (nodeId) => patch(nodeId, { effectStyle: undefined } as Partial<SceneNode>),
    removeEffectStyle: (styleId) => onDoc((d) => ({ ...d, effectStyles: d.effectStyles?.filter((x) => x.id !== styleId) })),
    createTextStyle: (nodeId) => {
      const id = system.addTextStyle();
      const n = nodeId ? getNode(nodes, nodeId) : null;
      if (n && n.type === "text") {
        const size = numberOf(n.fontSize, byId, 16);
        let k = textStyles.length + 1;
        while (textStyles.some((st) => st.name === `${n.name} ${k}`)) k++;
        system.setTextStyle({ id, name: `${n.name} ${k}`, fontSize: n.fontSize, fontWeight: n.fontWeight, lineHeight: n.lineHeight ?? { value: Math.round(size * 1.25) }, letterSpacing: n.letterSpacing, color: n.fills[0]?.color ?? { value: "#000000" } });
        patch(n.id, { textStyle: id } as Partial<SceneNode>);
      }
    },
    setTextStyle: (st) => system.setTextStyle(st),
    removeTextStyle: (id) => system.removeTextStyle(id),
    createColorStyle: (hex) => {
      const id = system.addVariable("color");
      let k = variables.filter((v) => v.kind === "color").length + 1;
      while (variables.some((v) => v.name === `Color ${k}`)) k++;
      system.setVariable({ id, name: `Color ${k}`, kind: "color", light: { value: hex } });
      setVariablesOpen(true);
    },
    exportNode: (id, setting) => {
      const el = document.querySelector<HTMLElement>(`[data-figma-canvas] [data-node-id="${CSS.escape(id)}"]`);
      const n = getNode(nodes, id);
      if (!el || !n) return setNotice("Nothing to export: the layer isn't drawn on this page.");
      exportElement(el, n.name, setting)
        .then((missing) => missing.length && setNotice(`Exported — ${missing.length} picture${missing.length === 1 ? "" : "s"} ${setting.format === "svg" ? "linked by address, not inside the file" : "left blank"}: the bucket doesn't allow reading them here (see cors.json).`))
        .catch((err) => setNotice(`Couldn't export: ${(err as Error).message}`));
    },
    upload: (f) => uploadMedia(f),
    pageId: doc.pageId,
    addAutoLayout: () => autoLayout(),
    lockProportions: (id, on) => {
      if (!on) return patch(id, { lockAspect: undefined });
      // Its size as drawn (a Fill or Hug side's stored size may be an old one): the ratio kept is the one seen.
      const r = domRect(id);
      patch(id, { lockAspect: true, ...(r && r.w > 0 && r.h > 0 ? { width: Math.round(r.w), height: Math.round(r.h) } : {}) });
    },
    more: (el) => openMenuUnder(el, nodeMenu(selected[0] ?? null), "right"),
    maskWith: (id) => maskWith(id),
    // Several layers put at their places at once (the panel's spacing between selected layers).
    placeMany: (moves) => setNodes((list) => moves.reduce((l, m) => updateNode(l, m.id, (n) => ({ ...n, ...(m.x !== undefined ? { x: m.x } : {}), ...(m.y !== undefined ? { y: m.y } : {}) })), list)),
    menu: (el, entries) => openMenuUnder(el, entries, "right"),
    replaceColor: (from, to, opacity) => {
      const ids = latest.current.selected.filter((id) => !id.includes("/"));
      const swap = <P extends Paint>(p: P): P =>
        !("alias" in p.color) && String(p.color.value).toLowerCase() === from.toLowerCase() ? { ...p, color: { value: to }, ...(opacity !== undefined ? { opacity: opacity >= 100 ? undefined : opacity } : {}) } : p;
      const fix = (n: SceneNode): SceneNode => {
        const next = { ...n, fills: n.fills?.map(swap) } as SceneNode;
        if (next.type !== "text") (next as FrameNode).strokes = (next as FrameNode).strokes?.map(swap);
        return isFrameLike(next) ? { ...next, children: next.children.map(fix) } : next;
      };
      setNodes((list) => updateNodes(list, ids, fix));
    },
    pageColors: pageColors,
  };

  /** What the preview plays: the selected top-level frame, else the component edited on its own, else the page — a frame of the open page, or nothing. */
  const previewTarget = () => {
    const id = latest.current.selected[0]?.split("/")[0];
    const top = id ? findNode(nodes, id)?.path[0] : undefined;
    for (const candidate of [top, iso?.id, doc.pageId]) {
      const n = candidate ? getNode(nodes, candidate) : null;
      if (n && isFrameLike(n)) return n.id;
    }
    return null;
  };
  /** Present: the preview opens on what it plays — with nothing to play, it doesn't (nor does it take the editor's keys). */
  const startPreview = (id?: string | null) => {
    const target = id ?? previewTarget();
    const n = target ? getNode(nodes, target) : null;
    if (n && isFrameLike(n)) setPreviewing(n.id);
  };

  // ── The prototype on the canvas (Figma's noodles) ──
  /**
   * A connection drawn from a layer: to another variant of its set, a Change
   * to on the variant it is in (Smart animate, as Figma's); to a frame, a
   * Navigate to on the layer itself (instant) — the page's first connection
   * starts its first flow, at the layer's frame. Its interaction opens.
   */
  const connect = (sourceId: string, targetId: string) => {
    const source = findNode(nodes, sourceId);
    const target = getNode(nodes, targetId);
    if (!source || !target) return;
    const set = target.type === "component" ? setOf(library, targetId) : null;
    const variant = set ? source.path.map((id) => getNode(nodes, id)).find((n): n is FrameNode => n?.type === "component" && setOf(library, n.id)?.id === set.id) : undefined;
    const holder = variant ?? source.node;
    const reaction: Reaction = variant
      ? { id: nid("r"), trigger: "click", action: "change", target: targetId, animation: "smart", easing: "ease-out", duration: 300 }
      : { id: nid("r"), trigger: "click", action: "navigate", target: targetId, animation: "instant", direction: "left", easing: "ease-out", duration: 300 };
    setNodes((list) => {
      let next = updateNode(list, holder.id, (n) => ({ ...n, reactions: [...(n.reactions ?? []), reaction] }));
      if (!variant && !next.some((n) => isFrameLike(n) && n.flowStart)) next = updateNode(next, source.path[0], (n) => (isFrameLike(n) ? { ...n, flowStart: "Flow 1" } : n));
      return next;
    });
    setSelection([holder.id]);
    setReactionOpen(reaction.id);
  };
  /** A connection's end moved: to another frame (or variant) — or off any, the connection gone. */
  const retarget = (sourceId: string, reactionId: string, targetId: string | null) => {
    setNodes((list) => updateNode(list, sourceId, (n) => {
      const reactions = (n.reactions ?? []).flatMap((r) => (r.id !== reactionId ? [r] : targetId ? [{ ...r, target: targetId }] : []));
      return { ...n, reactions: reactions.length ? reactions : undefined };
    }));
    if (!targetId && reactionOpen === reactionId) setReactionOpen(null);
  };
  /** A noodle clicked: its layer selected, its interaction open in the Prototype tab. */
  const openConnection = (sourceId: string, reactionId: string) => {
    setSelection([sourceId]);
    setRightTab("prototype");
    setReactionOpen(reactionId);
  };

  // ── The canvas's callbacks ──
  const onMove = (moves: { id: string; x: number; y: number }[], copy = false) => {
    if (!copy) return setNodes((list) => moves.reduce((acc, m) => updateNode(acc, m.id, (n) => ({ ...n, x: m.x, y: m.y })), list));
    // Dragged with ⌥: the originals stay, their copies land where the drag ended — not a copy of the root (it would land out of sight).
    const copied = moves.filter((m) => !isRoot(m.id));
    if (!copied.length) return;
    const made: string[] = [];
    setNodes((list) =>
      copied.reduce((acc, m) => {
        const found = findNode(acc, m.id);
        if (!found) return acc;
        const clone = { ...copyOf(found.node), x: m.x, y: m.y };
        made.push(clone.id);
        return insertNode(acc, found.parent?.id ?? null, clone, found.index + 1);
      }, list)
    );
    setSelection(made);
  };
  const onReparent = (id: string, parentId: string | null, x: number, y: number, index?: number, copy = false) => {
    const found = findNode(nodes, id);
    if (!found || (!copy && isPageOverview(found.node))) return;
    // A component edited on its own: nothing leaves it for the canvas around it (out of sight there).
    if (!parentId && iso) return;
    if (createsCycle(parentId, [found.node])) return;
    const target = parentId ? getNode(nodes, parentId) : null;
    if (target && isFrameLike(target)) index = fromIndex(target.children, index);
    const auto = target && isFrameLike(target) && target.layoutMode !== "none";
    const source = copy ? copyOf(found.node) : found.node;
    const moved: SceneNode = { ...source, x, y, ...(auto ? {} : { sizingH: found.node.sizingH === "fill" ? undefined : found.node.sizingH, sizingV: found.node.sizingV === "fill" ? undefined : found.node.sizingV }) };
    setNodes((list) => insertNode(copy ? list : removeNodes(list, new Set([id])), parentId, moved, index));
    if (copy) setSelection([moved.id]);
  };
  const onReorder = (id: string, index: number) => {
    const found = findNode(nodes, id);
    if (!found || !found.parent || isPageOverview(found.node)) return;
    const parent = found.parent;
    const rest = parent.children.filter((c) => c.id !== id);
    rest.splice(Math.min(fromIndex(rest, index) ?? index, rest.length), 0, found.node);
    patch(parent.id, { children: rest } as Partial<SceneNode>);
  };
  const onResize = (id: string, rect: Rect, changed: { x: boolean; y: boolean }) => {
    const found = findNode(nodes, id);
    if (!found) return;
    // In an auto layout its place is the layout's — unless it is positioned absolutely (its x and y its own, moved by a W or N handle).
    const inAuto = found.parent && found.parent.layoutMode !== "none" && !found.node.absolute;
    const p: Partial<SceneNode> = { width: rect.w, height: rect.h };
    if (!inAuto) { p.x = rect.x; p.y = rect.y; }
    // Proportions kept: both sides change, so both become Fixed (as Figma's).
    const lock = Boolean(found.node.lockAspect);
    if (changed.x || lock) p.sizingH = found.node.sizingH === "fill" || found.node.sizingH === "hug" ? undefined : found.node.sizingH;
    if (changed.y || lock) p.sizingV = found.node.sizingV === "fill" || found.node.sizingV === "hug" ? undefined : found.node.sizingV;
    if (found.node.type === "text") {
      const t = found.node;
      (p as Partial<SceneNode> & { textAutoResize?: string }).textAutoResize = changed.y ? "none" : t.textAutoResize === "widthHeight" && changed.x ? "height" : t.textAutoResize;
    }
    patch(id, p);
  };
  const onDraw = (drawn: CanvasTool, parentId: string | null, rect: Rect, clicked: boolean, index?: number) => {
    let node: SceneNode;
    if (drawn === "frame") node = makeFrame(nextName(nodes, "Frame"), rect.x, rect.y, rect.w, rect.h);
    else if (drawn === "text") { node = makeText(rect.x, rect.y, ""); if (!clicked) { node.width = rect.w; node.textAutoResize = "height"; } }
    else if (drawn === "line" && !clicked) {
      // A line drawn from its start along its vector (rect.w, rect.h signed): its length, turned to its angle around its centre.
      const length = Math.max(1, Math.round(Math.hypot(rect.w, rect.h)));
      const angle = Math.round((Math.atan2(rect.h, rect.w) * 180) / Math.PI * 10) / 10;
      node = makeShape("line", nextName(nodes, "Line"), rect.x + rect.w / 2 - length / 2, rect.y + rect.h / 2, length, 0);
      if (angle) node.rotation = angle;
    }
    else node = makeShape(drawn === "ellipse" ? "ellipse" : drawn === "line" ? "line" : "rectangle", nextName(nodes, drawn === "ellipse" ? "Ellipse" : drawn === "line" ? "Line" : "Rectangle"), rect.x, rect.y, rect.w, rect.h);
    // Drawn on the canvas around a component edited on its own: into it (beside it, it would be out of sight) — at its place in it.
    if (!parentId && iso && insertRoot) {
      const r = domRect(insertRoot);
      rect = { ...rect, x: Math.round(rect.x - (r?.x ?? 0)), y: Math.round(rect.y - (r?.y ?? 0)) };
      parentId = insertRoot;
    }
    const parent = parentId ? getNode(nodes, parentId) : null;
    setNodes((list) => insertNode(list, parentId, node, parent && isFrameLike(parent) ? fromIndex(parent.children, index) : index));
    setTool("move");
    setSelection([node.id]);
    if (drawn === "text") setEditing(node.id);
  };
  const onDoubleClick = (id: string) => {
    const node = getNode(nodes, id.split("/")[0]);
    const target = id.includes("/") ? null : node;
    if (target?.type === "text") {
      setSelection([id]);
      setEditing(id);
      return;
    }
    if (id.includes("/")) {
      // A text inside an instance: its override typed in place.
      setSelection([id]);
      if (layerAt(library, id)?.node.type === "text") setEditing(id);
      return;
    }
    setSelection([id]);
  };

  // Typing in a text in place: its words (the instance's, when it is an instance's — see typeInInstance).
  const editingCtx = useMemo<RenderContext["editing"]>(() => editing ? {
    id: editing,
    onInput: (id, text) => {
      const typed = latest.current.lang;
      if (editing.includes("/")) typeInInstance(editing, text, typed);
      else if (typed !== BASE_LANGUAGE) { const node = getNode(latest.current.nodes, id); patch(id, wordsPatch(node?.type === "text" ? node : {}, typed, text) as Partial<SceneNode>); }
      else {
        // A text is named after its words, as Figma's — while its name is still its words (a name given to it stays), and never inside a
        // main component (its instances' overrides go by its name) nor the project's own (the Overview's).
        const node = getNode(latest.current.nodes, id);
        const auto = node?.type === "text" && !node.fixed && (node.name === "Text" || node.name === layerName(node.characters.trim().slice(0, 40))) && !componentAround(latest.current.library, id);
        patch(id, (auto ? { characters: text, name: layerName(text.trim().slice(0, 40)) || "Text" } : { characters: text }) as Partial<SceneNode>);
      }
    },
    onDone: () => {
      setEditing(null);
      // A text left empty goes, as Figma's (the project's own stay, as does one inside an instance: its words are the instance's).
      const n = !editing.includes("/") ? getNode(latest.current.nodes, editing) : null;
      if (n?.type === "text" && !n.fixed && !n.characters.trim() && !n.charactersEn?.trim()) setNodes((list) => removeNodes(list, new Set([n.id])));
    },
  } : null, [editing, typeInInstance, patch, setNodes]);
  const render = useMemo<RenderContext>(() => ({ nodes: library, byId, lang, play: false, editing: editingCtx }), [library, byId, lang, editingCtx]);

  // ── Layers ──
  const moveInTree = (id: string, targetId: string, where: TreePlace) => {
    // The Page Editor: nothing lands beside the page — above or below its row is into it.
    // (A component edited on its own, too: nothing lands beside it, out of sight.)
    const place: TreePlace = isRoot(targetId) ? "inside" : where;
    const found = findNode(nodes, id);
    const target = findNode(nodes, targetId);
    if (!found || !target || target.path.includes(id) || isPageOverview(found.node) || isRoot(id)) return;
    if (createsCycle(place === "inside" ? targetId : target.parent?.id ?? null, [found.node])) return;
    // Worked out on the page as it is (what is shown may be a part of it: a component edited on its own).
    setNodes((list) => {
      const f = findNode(list, id);
      if (!f) return list;
      const without = removeNodes(list, new Set([id]));
      if (place === "inside") return insertNode(without, targetId, f.node);
      const t2 = findNode(without, targetId);
      if (!t2) return list;
      // The tree lists front first: "before" a row is after it in the list.
      const index = fromIndex(t2.parent ? t2.parent.children : without, place === "before" ? t2.index + 1 : t2.index);
      return insertNode(without, t2.parent?.id ?? null, f.node, index);
    });
    if (place === "inside") setOpen((prev) => new Set([...prev, targetId]));
  };

  const reorder = (dir: "forward" | "backward" | "front" | "back") => {
    const id = selected[0];
    const found = id && !id.includes("/") ? findNode(nodes, id) : null;
    if (!found || isPageOverview(found.node) || isRoot(found.node.id)) return;
    const siblings = found.parent ? found.parent.children : nodes;
    const first = fromIndex(siblings, 0) ?? 0;
    const to = dir === "front" ? siblings.length - 1 : dir === "back" ? first : Math.max(first, Math.min(siblings.length - 1, found.index + (dir === "forward" ? 1 : -1)));
    if (to === found.index) return;
    setNodes((list) => insertNode(removeNodes(list, new Set([id])), found.parent?.id ?? null, found.node, to));
  };

  // ── Menus ──
  const openMenu = (e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    if (entries.length) setMenu({ x: e.clientX, y: e.clientY, entries });
  };
  const openMenuUnder = (el: HTMLElement, entries: MenuEntry[], align: "left" | "right" = "left") => {
    const r = el.getBoundingClientRect();
    setMenu({ x: align === "left" ? r.left : r.right - 200, y: r.bottom + 4, entries });
  };
  /**
   * A layer renamed from the layers. A variant's name is its properties, as
   * Figma's ("State=active, Size=lg" — or its values alone): typing it sets
   * them; a name that isn't one is refused with Figma's words.
   */
  const renameLayer = (id: string, name: string) => {
    const set = setOf(library, id);
    const variant = set ? findComponent(library, id) : null;
    if (!set || !variant?.variant?.length) return onDoc((d) => withRenamedLayer(d, id, name));
    const pairs = parseVariantName(name, variantProperties(set).map((p) => p.name));
    if (!pairs) return setNotice("This layer has an invalid name — a variant is named by its properties: Property=Value, Property 2=Value.");
    onDoc((d) => updateAnywhere(d, set.id, (n) => (n.type === "componentSet" ? withVariantName(n, id, pairs) : n)));
  };
  /** Swap instance's list, as Figma's: each component once — a set as its default (first) variant. */
  const swapEntries = (node: FrameNode): MenuEntry[] => {
    const seen = new Set<string>();
    const out: MenuEntry[] = [];
    for (const { component, set } of components) {
      const key = set?.id ?? component.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = set ? variantsOf(set)[0] ?? component : component;
      const current = set ? Boolean(node.mainId && setOf(library, node.mainId)?.id === set.id) : node.mainId === component.id;
      out.push({ label: (set ?? component).name, icon: fi("16.component"), checked: current, disabled: current, onSelect: () => ops.swapInstance(node.id, target.id) });
    }
    return out;
  };
  /**
   * An instance's actions, as Figma's ⋯ (and its right-click menu): swap,
   * reset one change or all, push the changes to the main component, go to
   * it, select the likes, detach. For a layer inside an instance: its reset
   * and select matching.
   */
  const instanceActions = (id: string): MenuEntry[] => {
    const changes = changesAt(library, id);
    const reset: MenuEntry = {
      label: "Reset",
      disabled: !changes.length,
      items: [...changes.map((c) => ({ label: `Reset ${c.label}`, onSelect: () => ops.resetChange(id, c.key) })), "-", { label: "Reset all changes", onSelect: () => ops.resetChange(id) }],
    };
    const matching: MenuEntry = { label: "Select matching layers", shortcut: keys("alt", "mod", "a"), onSelect: ops.selectMatching };
    if (id.includes("/")) return [reset, matching];
    const node = getNode(nodes, id);
    if (node?.type !== "instance") return [];
    const fixed = stays.has(id);
    return [
      { label: "Swap instance", disabled: fixed, items: swapEntries(node) },
      reset,
      { label: "Push changes to main component", disabled: fixed || !changes.length, onSelect: ops.pushToMain },
      "-",
      { label: "Go to main component", disabled: !node.mainId, onSelect: ops.goToMain },
      matching,
      { label: "Detach instance", shortcut: keys("alt", "mod", "b"), disabled: fixed, onSelect: detach },
    ];
  };
  const nodeMenu = (id: string | null, at?: { x: number; y: number }): MenuEntry[] => {
    // What it acts on: a right click on a layer not selected selects it first — the menu is built for that selection, not the one before.
    const selected = id && !latest.current.selected.includes(id) ? [id] : latest.current.selected;
    const node = id && !id.includes("/") ? getNode(nodes, id) : null;
    const pasteHere = { label: "Paste here", disabled: !clipboard.current.length, onSelect: () => (at ? pasteAt(at.x, at.y, id) : paste()) };
    // A layer inside an instance: what Figma offers of it — its changes reset, its likes selected.
    if (id && id.includes("/")) return instanceActions(id);
    if (!node) {
      return [
        pasteHere,
        "-",
        // As Figma's: show or hide the UI — and the rulers (the Page Editor has none).
        { label: "Show/Hide UI", shortcut: keys("mod", "\\"), onSelect: () => setMinimized((m) => !m) },
        ...(mode === "canvas" ? [{ label: "Show/Hide rulers", shortcut: keys("shift", "r"), onSelect: () => setRulers((r) => !r) }] : []),
        "-",
        { label: "Undo", shortcut: keys("mod", "z"), onSelect: undo },
        { label: "Redo", shortcut: keys("shift", "mod", "z"), onSelect: redo },
        "-",
        ...(paged
          ? [{ label: "Scroll to top", shortcut: keys("shift", "1"), onSelect: () => zoomActions.current?.fitAll() }]
          : [
              { label: "Zoom to fit", shortcut: keys("shift", "1"), onSelect: () => zoomActions.current?.fitAll() },
              { label: "Zoom to 100%", shortcut: keys("shift", "0"), onSelect: () => zoomActions.current?.zoomTo(1) },
            ]),
        "-",
        { label: "Place image…", shortcut: keys("shift", "mod", "k"), onSelect: placeImage },
      ];
    }
    const found = findNode(nodes, id!);
    const top = found?.path.length === 1;
    const frame = isFrameLike(node);
    const variantSet = node.type === "component" ? setOf(nodes, node.id) : null;
    const chain = (found?.path ?? []).map((pid) => getNode(nodes, pid)).filter((n): n is SceneNode => Boolean(n));
    const otherPages = pages.filter((pg) => pg.id !== (iso ? iso.page : file.currentPage ?? "") && pg.id !== COMPONENTS_PAGE_ID);
    const many = selected.filter((s) => !s.includes("/")).length > 1;
    // The Page Editor's page stays whole and in its place; so do the project's own layers (the page frame, its Overview).
    const fixed = isRoot(node.id) || stays.has(node.id);
    const own = Boolean(node.fixed);
    const alwaysShown = node.fixed === "overview" || node.fixed === "header" || node.fixed === "title";
    return [
      { label: "Copy", shortcut: keys("mod", "c"), onSelect: copySelection },
      pasteHere,
      { label: "Paste to replace", shortcut: keys("shift", "mod", "r"), disabled: fixed || !clipboard.current.length, onSelect: pasteToReplace },
      { label: "Copy/Paste as", items: [
        { label: "Copy as CSS", onSelect: () => void copyAs("css") },
        { label: "Copy as SVG", onSelect: () => void copyAs("svg") },
        { label: "Copy as PNG", onSelect: () => void copyAs("png") },
        "-",
        { label: "Copy properties", shortcut: keys("alt", "mod", "c"), onSelect: copyProperties },
        { label: "Paste properties", shortcut: keys("alt", "mod", "v"), disabled: !propsClipboard.current, onSelect: pasteProperties },
      ] },
      { label: "Duplicate", shortcut: keys("mod", "d"), disabled: isRoot(node.id), onSelect: duplicateSelection },
      { label: "Delete", shortcut: keys("backspace"), disabled: fixed, onSelect: deleteSelection },
      { label: "Add motion", items: variantSet ? [
        { label: "On click → next variant", onSelect: () => addMotion(node.id, "click") },
        { label: "While hovering → next variant", onSelect: () => addMotion(node.id, "hover") },
        { label: "While pressing → next variant", onSelect: () => addMotion(node.id, "press") },
        "-",
        { label: "Open Prototype tab", onSelect: () => setRightTab("prototype") },
      ] : [
        { label: "Open Prototype tab", hint: "between variants", onSelect: () => setRightTab("prototype") },
      ] },
      "-",
      { label: "Select layer", items: chain.map((n) => ({ label: n.name, hint: KIND_HINT[n.type], checked: selected.includes(n.id), onSelect: () => setSelection([n.id]) })) },
      { label: "Move to page", disabled: fixed, items: otherPages.length ? otherPages.map((pg) => ({ label: pg.name, onSelect: () => moveToPage(pg.id) })) : [{ label: "No other pages", disabled: true }, { label: "Add new page", onSelect: addPage }] },
      { label: "Bring to front", shortcut: "]", disabled: isPageOverview(node), onSelect: () => reorder("front") },
      { label: "Send to back", shortcut: "[", disabled: isPageOverview(node), onSelect: () => reorder("back") },
      { label: "Bring forward", shortcut: keys("mod", "]"), disabled: isPageOverview(node), onSelect: () => reorder("forward") },
      { label: "Send backward", shortcut: keys("mod", "["), disabled: isPageOverview(node), onSelect: () => reorder("backward") },
      "-",
      { label: "Group selection", shortcut: keys("mod", "g"), disabled: fixed, onSelect: () => groupSelection("group") },
      { label: "Frame selection", shortcut: keys("alt", "mod", "g"), disabled: fixed, onSelect: () => groupSelection("frame") },
      { label: "Ungroup", shortcut: keys("mod", "backspace"), disabled: fixed || !(frame && node.type !== "instance"), onSelect: ungroup },
      { label: "Use as mask", shortcut: "^" + keys("mod", "m"), disabled: fixed || node.type === "text" || many, onSelect: () => maskWith(node.id) },
      "-",
      { label: frame && node.type !== "instance" && node.type !== "componentSet" && node.layoutMode !== "none" && !many ? "Remove auto layout" : "Add auto layout", shortcut: keys("shift", "a"), onSelect: () => autoLayout() },
      { label: "More layout options", items: [
        { label: "Width: Hug contents", checked: node.sizingH === "hug", onSelect: () => patch(node.id, { sizingH: "hug" }) },
        { label: "Width: Fill container", checked: node.sizingH === "fill", onSelect: () => patch(node.id, { sizingH: "fill" }) },
        { label: "Width: Fixed", checked: !node.sizingH, onSelect: () => patch(node.id, { sizingH: undefined }) },
        "-",
        { label: "Height: Hug contents", checked: node.sizingV === "hug", onSelect: () => patch(node.id, { sizingV: "hug" }) },
        { label: "Height: Fill container", checked: node.sizingV === "fill", onSelect: () => patch(node.id, { sizingV: "fill" }) },
        { label: "Height: Fixed", checked: !node.sizingV, onSelect: () => patch(node.id, { sizingV: undefined }) },
        ...(frame && node.layoutMode !== "none" ? ["-" as const,
          { label: "Wrap", checked: Boolean(node.layoutWrap), disabled: node.layoutMode !== "horizontal", onSelect: () => patch(node.id, { layoutWrap: node.layoutWrap ? undefined : true } as Partial<SceneNode>) },
          { label: "Clip content", checked: Boolean(node.clipsContent), onSelect: () => patch(node.id, { clipsContent: !node.clipsContent } as Partial<SceneNode>) },
        ] : []),
        ...(found?.parent && found.parent.layoutMode !== "none" ? ["-" as const, { label: "Absolute position", checked: Boolean(node.absolute), onSelect: () => patch(node.id, { absolute: node.absolute ? undefined : true }) }] : []),
      ] },
      ...(node.type === "frame" ? [{ label: "Create component", shortcut: keys("alt", "mod", "k"), disabled: fixed, onSelect: createComponent }] : []),
      ...(selected.length > 1 && node.type !== "component" && node.type !== "componentSet" ? [{ label: "Create multiple components", onSelect: createMultipleComponents }] : []),
      ...(node.type === "component" || node.type === "componentSet" ? [{ label: "Add variant", onSelect: () => addVariant(node.id) }] : []),
      ...(node.type === "component" && selected.length > 1 ? [{ label: "Combine as variants", onSelect: combineAsVariants }] : []),
      ...(node.type === "instance" ? instanceActions(node.id) : []),
      ...(top && node.type === "frame" ? [{ label: "Set as site page", hint: doc.pageId === node.id ? "current" : "shown on the site", disabled: doc.pageId === node.id, onSelect: () => onDoc((d) => withSitePage(d, node.id)) }] : []),
      "-",
      { label: node.visible === false ? "Show" : "Hide", shortcut: keys("shift", "mod", "h"), disabled: alwaysShown, onSelect: () => patch(node.id, { visible: node.visible === false ? undefined : false }) },
      { label: node.locked ? "Unlock" : "Lock", shortcut: keys("shift", "mod", "l"), onSelect: () => patch(node.id, { locked: node.locked ? undefined : true }) },
      { label: "Rename", shortcut: keys("mod", "r"), disabled: own, onSelect: () => { setLeftTab("file"); requestAnimationFrame(() => requestRename(node.id)); } },
      "-",
      { label: "Flip horizontal", shortcut: keys("shift", "h"), onSelect: () => flip("H") },
      { label: "Flip vertical", shortcut: keys("shift", "v"), onSelect: () => flip("V") },
    ];
  };
  const shellMenu = (): MenuEntry[] => [
    // Home is a tab of its own: this file stays open (and unsaved, if it is) behind it.
    { label: "Back to files", onSelect: () => shellBridge()?.goHome() },
    "-",
    { label: "Save", shortcut: keys("mod", "s"), onSelect: () => void session.save() },
    { label: session.meta?.published ? (session.meta.changedSincePublish || session.dirty ? "Update the site" : "Publish again") : "Publish", onSelect: () => void session.publish() },
    ...(session.meta?.published ? [{ label: "Unpublish", hint: "the draft stays", onSelect: () => { if (window.confirm("Take this project off the site? Its draft stays here.")) void session.unpublish(); } }] : []),
    { label: "Version history…", onSelect: () => setVersionsOpen(true) },
    "-",
    { label: "Undo", shortcut: keys("mod", "z"), onSelect: undo },
    { label: "Redo", shortcut: keys("shift", "mod", "z"), onSelect: redo },
    "-",
    { label: "View on site", disabled: !isPublished, onSelect: () => openExternal(`${SITE_URL}/projects/${slug}`) },
    { label: "Preview the saved draft", hint: session.dirty ? "save first" : undefined, onSelect: () => shellBridge()?.openPreview(slug) },
    { label: "Present", onSelect: () => startPreview() },
    "-",
    { label: "Settings…", shortcut: keys("mod", ","), onSelect: () => setSettingsOpen(true) },
    { label: theme === "dark" ? "Light theme" : "Dark theme", onSelect: toggleTheme },
    { label: minimized ? "Show UI" : "Hide UI", shortcut: keys("mod", "\\"), onSelect: () => setMinimized((m) => !m) },
    ...(mode === "canvas" ? [{ label: rulers ? "Hide rulers" : "Show rulers", shortcut: keys("shift", "r"), onSelect: () => setRulers((r) => !r) }] : []),
  ];
  const zoomMenu = (): MenuEntry[] => paged ? [
    // The page is at its own scale (100%, or what fits the view's width): its menu scrolls.
    { label: "Scroll to top", shortcut: keys("shift", "1"), onSelect: () => zoomActions.current?.fitAll() },
    { label: "Scroll to selection", shortcut: keys("shift", "2"), disabled: !selected.length, onSelect: () => zoomActions.current?.fitSelection() },
  ] : [
    { label: "Zoom in", shortcut: keys("mod", "+"), onSelect: () => zoomActions.current?.zoomTo(viewNow().zoom * 2) },
    { label: "Zoom out", shortcut: keys("mod", "-"), onSelect: () => zoomActions.current?.zoomTo(viewNow().zoom / 2) },
    "-",
    { label: "Zoom to fit", shortcut: keys("shift", "1"), onSelect: () => zoomActions.current?.fitAll() },
    { label: "Zoom to selection", shortcut: keys("shift", "2"), disabled: !selected.length, onSelect: () => zoomActions.current?.fitSelection() },
    "-",
    { label: "Zoom to 50%", onSelect: () => zoomActions.current?.zoomTo(0.5) },
    { label: "Zoom to 100%", shortcut: keys("shift", "0"), onSelect: () => zoomActions.current?.zoomTo(1) },
    { label: "Zoom to 200%", onSelect: () => zoomActions.current?.zoomTo(2) },
  ];
  const headerMenu = (node: SceneNode): MenuItem[] => {
    const found = findNode(nodes, node.id);
    return (found?.path.slice(0, -1) ?? []).map((id) => {
      const n = getNode(nodes, id)!;
      return { label: n.name, hint: n.type, onSelect: () => setSelection([id]) };
    });
  };

  // ── Keys ──
  /** Paste here: the clipboard's layers put where the pointer is (into the frame under it). */
  const pasteAt = (clientX: number, clientY: number, targetId: string | null) => {
    if (!clipboard.current.length) return;
    const canvasEl = document.querySelector<HTMLElement>("[data-figma-canvas]");
    const base = canvasEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const view = viewNow();
    const at = { x: (clientX - base.left - view.x) / view.zoom, y: (clientY - base.top - view.y) / view.zoom };
    const target = targetId ? findNode(nodes, targetId) : null;
    const into = target && (target.node.type === "frame" || target.node.type === "component") ? target.node.id : target?.parent?.id ?? insertRoot;
    const originEl = into ? document.querySelector<HTMLElement>(`[data-figma-canvas] [data-node-id="${CSS.escape(into)}"]`) : null;
    const or = originEl?.getBoundingClientRect();
    const origin = or ? { x: (or.left - base.left - view.x) / view.zoom, y: (or.top - base.top - view.y) / view.zoom } : { x: 0, y: 0 };
    const first = clipboard.current[0];
    const copies = clipboard.current.map((n) => ({ ...copyOf(n), x: Math.round(at.x - origin.x + (n.x - first.x)), y: Math.round(at.y - origin.y + (n.y - first.y)) }));
    if (createsCycle(into, copies)) return;
    setNodes((list) => copies.reduce((acc, c) => insertNode(acc, into, c), list));
    setSelection(copies.map((c) => c.id));
  };
  /** Paste to replace (⇧⌘R): each selected layer swapped for the clipboard's first, at its place. */
  const pasteToReplace = () => {
    const source = clipboard.current[0];
    if (!source) return;
    const tops = topmost(nodes, latest.current.selected.filter(removable));
    if (!tops.length || tops.some((t) => createsCycle(t.parent?.id ?? null, [source]))) return;
    const made: string[] = [];
    setNodes((list) => tops.reduce((acc, t) => {
      const found = findNode(acc, t.node.id);
      if (!found) return acc;
      const copy = { ...cloneNode(source), x: found.node.x, y: found.node.y };
      made.push(copy.id);
      return insertNode(removeNodes(acc, new Set([found.node.id])), found.parent?.id ?? null, copy, found.index);
    }, list));
    setSelection(made);
  };
  const copyAs = async (kind: "css" | "svg" | "png") => {
    const id = latest.current.selected[0]?.split("/")[0];
    const n = id ? getNode(nodes, id) : null;
    if (!id || !n) return;
    if (kind === "css") {
      const css = nodeCss(n, "none", byId);
      const text = Object.entries(css).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${typeof v === "number" && !/opacity|weight|grow|shrink|z-index/i.test(k) ? `${v}px` : v};`).join("\n");
      return navigator.clipboard.writeText(text);
    }
    const el = document.querySelector<HTMLElement>(`[data-figma-canvas] [data-node-id="${CSS.escape(id)}"]`);
    if (!el) return setNotice("Nothing to copy: the layer isn't drawn on this page.");
    await copyElementAs(el, kind)
      .then((missing) => missing.length && setNotice(`Copied — ${missing.length} picture${missing.length === 1 ? "" : "s"} ${kind === "svg" ? "linked by address, not inside it" : "left blank"} (see cors.json).`))
      .catch((err) => setNotice(`Couldn't copy: ${(err as Error).message}`));
  };
  /** Move to page: the layers taken out of this page and put on another, at their places. */
  const moveToPage = (pageId: string) => {
    const tops = topmost(nodes, latest.current.selected.filter(removable));
    if (!tops.length) return;
    const ids = new Set(tops.map((t) => t.node.id));
    const moving = tops.map((t) => t.node);
    onDoc((d) => {
      const from = pageOf(d);
      if (from === pageId) return d;
      let next = d;
      // Out of the open page…
      next = from ? { ...next, pages: next.pages?.map((pg) => (pg.id === from ? { ...pg, nodes: removeNodes(pg.nodes, ids) } : pg)) } : { ...next, nodes: removeNodes(next.nodes, ids) };
      // …and onto the other.
      next = pageId ? { ...next, pages: next.pages?.map((pg) => (pg.id === pageId ? { ...pg, nodes: [...pg.nodes, ...moving] } : pg)) } : { ...next, nodes: [...next.nodes, ...moving] };
      return next;
    });
    setSelection([]);
  };
  /** Use as mask (^⌘M): the layer becomes a clipping frame around the layers above it in its parent — Figma's mask, as the DOM can draw it. */
  const maskWith = (id: string) => {
    const found = findNode(nodes, id);
    if (!found || found.node.type === "text" || isRoot(id)) return;
    const mask = found.node;
    const siblings = found.parent ? found.parent.children : nodes;
    const above = siblings.slice(found.index + 1);
    if ([mask, ...above].some((n) => stays.has(n.id))) return;
    const frame = makeFrame(`${mask.name} (mask group)`, mask.x, mask.y, mask.width, mask.height);
    frame.fills = [];
    frame.clipsContent = true;
    if (mask.type === "ellipse") frame.cornerRadius = { value: 9999 };
    else if (mask.type !== "line" && (mask.cornerRadius || mask.corners)) { frame.cornerRadius = mask.cornerRadius; frame.corners = mask.corners; }
    frame.children = [{ ...mask, x: 0, y: 0, visible: false, name: `${mask.name} (mask)` }, ...above.map((n) => ({ ...n, x: n.x - mask.x, y: n.y - mask.y }))];
    const gone = new Set([mask.id, ...above.map((n) => n.id)]);
    setNodes((list) => insertNode(removeNodes(list, gone), found.parent?.id ?? null, frame, found.index));
    setSelection([frame.id]);
  };
  /** Add motion: a variant's reaction to its set's next variant (Figma's quick prototyping). */
  const addMotion = (id: string, trigger: "click" | "hover" | "press") => {
    const set = setOf(nodes, id);
    const node = getNode(nodes, id);
    if (!set || !node || node.type !== "component") { setRightTab("prototype"); return; }
    const variants = variantsOf(set);
    const i = variants.findIndex((v) => v.id === id);
    const target = variants[(i + 1) % variants.length];
    if (!target || target.id === id) { setRightTab("prototype"); return; }
    ops.setReactions(id, [...(node.reactions ?? []), { id: nid("r"), trigger, target: target.id, animation: "smart", easing: "ease-out", duration: 300 }]);
    setRightTab("prototype");
  };
  /** ⇧A as Figma's: one frame → its auto layout on or off (⌥⇧A: off); anything else — several layers, a shape, a text, an instance — wrapped in a new auto layout frame. */
  const autoLayout = (remove = false) => {
    const tops = topmost(nodes, latest.current.selected.filter((id) => !id.includes("/")));
    if (!tops.length) return;
    const only = tops.length === 1 ? tops[0].node : null;
    if (only && isFrameLike(only) && only.type !== "instance") return ops.setAutoLayout(only.id, remove || only.layoutMode !== "none" ? "none" : "vertical");
    if (!remove) groupSelection("auto");
  };
  const flip = (axis: "H" | "V") => {
    const ids = latest.current.selected.filter((id) => !id.includes("/"));
    if (!ids.length) return;
    setNodes((list) => updateNodes(list, ids, (n) => (axis === "H" ? { ...n, flipH: n.flipH ? undefined : true } : { ...n, flipV: n.flipV ? undefined : true })));
  };

  // ⇧⌘K: a picture from the disk, placed as a rectangle filled with it, in the middle of the view.
  /** A picture placed as a rectangle of its own proportions (800px wide at most), in the middle of the view — in the Page Editor, into the page, at its flow's end. */
  const placeImageUrl = async (url: string, name: string) => {
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = url; });
    const scale = Math.min(1, 800 / Math.max(1, img.naturalWidth || 800));
    const w = Math.round((img.naturalWidth || 400) * scale);
    const h = Math.round((img.naturalHeight || 300) * scale);
    const canvas = document.querySelector<HTMLElement>("[data-figma-canvas]");
    const view = viewNow();
    const cx = ((canvas?.clientWidth ?? 800) / 2 - view.x) / view.zoom;
    const cy = ((canvas?.clientHeight ?? 600) / 2 - view.y) / view.zoom;
    const shape = makeShape("rectangle", name || "Image", insertRoot ? 0 : cx - w / 2, insertRoot ? 0 : cy - h / 2, w, h);
    shape.fills = [{ type: "image", color: { value: "#d9d9d9" }, image: { url, fit: "fill" } }];
    setNodes((list) => insertNode(list, insertRoot, shape));
    setSelection([shape.id]);
  };
  /** A picture from the disk (or the clipboard): uploaded, then placed — where things are once it is up (the editor may have moved on meanwhile). */
  const placeFile = async (f: File) => {
    try {
      setNotice(`Uploading “${f.name || "picture"}”…`);
      const url = await uploadMedia(f);
      setNotice(null);
      await placeRef.current(url, (f.name || "Image").replace(/\.[^.]+$/, ""));
    } catch (err) {
      setNotice(`Couldn't upload the picture: ${(err as Error).message}`);
    }
  };
  const placeImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void placeFile(f);
    };
    input.click();
  };
  const placeRef = useRef(placeImageUrl);
  useEffect(() => {
    placeRef.current = placeImageUrl;
  });
  /**
   * An image of the bucket put to use (the Images panel): the picture of the
   * selected layers' fills — their image fill's, or a new one on top; inside
   * an instance, its override — or, nothing that takes a fill selected, a
   * picture placed on the canvas.
   */
  const putImage = (url: string, name: string) => {
    const paint: Paint = { type: "image", color: { value: "#d9d9d9" }, image: { url, fit: "fill" } };
    const pictured = (fills: Paint[]): Paint[] => {
      const i = fills.findIndex((p) => p.type === "image");
      return i < 0 ? [paint, ...fills] : fills.map((p, j) => (j === i ? { ...p, visible: undefined, image: { url, fit: p.image?.fit ?? "fill" } } : p));
    };
    // Where each selected layer's picture goes: its own fills — an instance's (or a layer's inside one), as an override: of the layer of
    // its component that shows a picture (the Overview's cover), else of its own fills. A text takes none.
    const { selected: sel, nodes: list } = latest.current;
    const own: string[] = [];
    const overrides: { id: string; fills: Paint[] }[] = [];
    for (const id of sel) {
      const node = id.includes("/") ? layerAt(library, id)?.node : getNode(list, id);
      if (!node || node.type === "text") continue;
      if (node.type === "instance") {
        const resolved = resolveInstance(library, node);
        const at = resolved ? pictureIn(resolved.children) : null;
        overrides.push(at ? { id: `${id}/${at.key}`, fills: at.fills } : { id: `${id}/`, fills: resolved?.fills ?? node.fills });
      } else if (id.includes("/")) overrides.push({ id, fills: node.fills });
      else own.push(id);
    }
    if (!own.length && !overrides.length) return void placeImageUrl(url, name);
    if (own.length) setNodes((ns) => updateNodes(ns, own, (n) => (n.type === "text" ? n : { ...n, fills: pictured(n.fills) })));
    overrides.forEach((o) => override(o.id, { fills: pictured(o.fills) }));
  };
  // The Images panel's: stable (it is memoized, mounted while hidden), the latest putImage behind it.
  const putImageRef = useRef(putImage);
  useEffect(() => {
    putImageRef.current = putImage;
  });
  const onUseImage = useCallback((url: string, name: string) => putImageRef.current(url, name), []);

  // ⌥⌘C / ⌥⌘V: a layer's look (fills, strokes, effects, corners, opacity) carried to others.
  const propsClipboard = useRef<Partial<SceneNode> | null>(null);
  const copyProperties = () => {
    const n = latest.current.selected[0] ? getNode(nodes, latest.current.selected[0].split("/")[0]) : null;
    if (!n) return;
    const look: Record<string, unknown> = { fills: n.fills, opacity: n.opacity };
    if (n.type !== "text") Object.assign(look, { strokes: n.strokes, effects: n.effects, cornerRadius: n.cornerRadius, corners: n.corners });
    else Object.assign(look, { fontSize: n.fontSize, fontWeight: n.fontWeight, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing, textAlign: n.textAlign, textStyle: n.textStyle });
    propsClipboard.current = look as Partial<SceneNode>;
  };
  const pasteProperties = () => {
    const look = propsClipboard.current;
    if (!look) return;
    setNodes((list) => updateNodes(list, latest.current.selected.filter((id) => !id.includes("/")), (n) => {
      const next = { ...n } as Record<string, unknown>;
      for (const [k, v] of Object.entries(look)) {
        if (k === "fills" || k === "opacity") next[k] = v;
        else if (n.type === "text" ? ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textStyle"].includes(k) : ["strokes", "effects", "cornerRadius", "corners"].includes(k)) next[k] = v;
      }
      return next as unknown as SceneNode;
    }));
  };
  const [rulers, setRulers] = useState(true);
  const save = session.save;
  const actions = useRef({ deleteSelection, duplicateSelection, copySelection, paste, pasteFrom, groupSelection, ungroup, createComponent, detach, reorder, ops, undo, redo, save, copyProperties, pasteProperties, placeImage, pasteToReplace, flip, maskWith, autoLayout, endIsolation });
  useEffect(() => {
    actions.current = { deleteSelection, duplicateSelection, copySelection, paste, pasteFrom, groupSelection, ungroup, createComponent, detach, reorder, ops, undo, redo, save, copyProperties, pasteProperties, placeImage, pasteToReplace, flip, maskWith, autoLayout, endIsolation };
  });
  // ⌘C / ⌘X / ⌘V, as the browser's own copy, cut and paste: the system's clipboard holds the layers (another tab pastes them), and a
  // picture or words copied anywhere paste in as layers. Not while a field is typed in (its own text is copied), nor over a window.
  useEffect(() => {
    const ours = () => !isTyping() && !latest.current.previewing && !document.querySelector("[role=dialog], [role=menu]") && !window.getSelection()?.toString();
    const onCopy = (e: ClipboardEvent) => {
      if (ours() && actions.current.copySelection(e.clipboardData)) e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (!ours() || !actions.current.copySelection(e.clipboardData)) return;
      e.preventDefault();
      actions.current.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours() || !e.clipboardData || latest.current.mode === "code") return;
      e.preventDefault();
      actions.current.pasteFrom(e.clipboardData);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
  // ⌘S saves wherever the focus is — a field being typed in first gives up what it holds (its blur keeps it) — and never opens the browser's own Save.
  useEffect(() => {
    const onSave = (e: KeyboardEvent) => {
      if (!((IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyS")) return;
      e.preventDefault();
      e.stopPropagation();
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
      window.setTimeout(() => void actions.current.save(), 0);
    };
    window.addEventListener("keydown", onSave, true);
    return () => window.removeEventListener("keydown", onSave, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The prototype's window has its own keys (Esc closes it); a menu its own.
      if (isTyping() || latest.current.previewing || document.querySelector("[role=menu]")) return;
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const { selected: sel, nodes: list, tool: current, mode: shownMode, pageRoot: root } = latest.current;
      // Undo and redo work everywhere — in a window over the editor too (the variables').
      if (mod && e.code === "KeyZ") { e.preventDefault(); return e.shiftKey ? actions.current.redo() : actions.current.undo(); }
      if (mod && e.code === "KeyY") { e.preventDefault(); return actions.current.redo(); }
      // The browser's own keys that would leave the editor (reload, back, forward) never do.
      if (mod && !e.shiftKey && ["KeyR", "BracketLeft", "BracketRight", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      if (e.altKey && !mod && ["ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      // A window open over the editor (the variables, the settings, the versions): the rest of the keys are its.
      if (document.querySelector("[role=dialog]")) return;
      // The code's view has nothing to pick or draw: only the UI's own key.
      if (shownMode === "code") {
        if (mod && e.code === "Backslash") { e.preventDefault(); setMinimized((m) => !m); }
        return;
      }
      const a = actions.current;
      const { shiftKey: shift, altKey: alt, code } = e;
      const first = sel[0];
      const own = sel.filter((id) => !id.includes("/"));
      const handled = () => e.preventDefault();
      // The top level as shown: in the Page Editor, the page frame alone (what sits beside it isn't drawn there).
      const tops = root ? list.filter((n) => n.id === root) : list;
      // Matched by the key's code: with ⌥ held a Mac changes e.key ("˚" for K), the code stays.
      const is = (...codes: string[]) => codes.includes(code);
      const texts = own.map((id) => getNode(list, id)).filter((n): n is TextNode => n?.type === "text");
      const bump = (field: "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight", by: number, min: number, max: number) => {
        if (!texts.length) return false;
        handled();
        setNodes((ns) => updateNodes(ns, texts.map((t) => t.id), (n) => {
          if (n.type !== "text") return n;
          const v = n[field];
          const base = v && "value" in v ? Number(v.value) : field === "fontSize" ? 16 : field === "fontWeight" ? 400 : field === "lineHeight" ? Math.round(numberOf(n.fontSize, byId) * 1.2) : 0;
          return { ...n, [field]: { value: Math.min(max, Math.max(min, base + by)) } };
        }));
        return true;
      };

      if (is("Escape")) {
        handled();
        if (current !== "move") return setTool("move");
        // Nothing selected in a component edited on its own: back to the file.
        if (!sel.length && latest.current.isolated) return a.endIsolation();
        const found = first && !first.includes("/") ? findNode(list, first) : null;
        if (first?.includes("/")) return setSelection([first.split("/")[0]]);
        return setSelection(found?.parent ? [found.parent.id] : []);
      }
      if (is("Enter", "NumpadEnter")) {
        const node = first && !first.includes("/") ? getNode(list, first) : null;
        if (shift) {
          const found = node ? findNode(list, node.id) : null;
          if (found?.parent) { handled(); setSelection([found.parent.id]); }
          return;
        }
        if (node && isFrameLike(node) && node.children.length) { handled(); setSelection([node.children[node.children.length - 1].id]); }
        else if (node?.type === "text") { handled(); setEditing(node.id); }
        return;
      }
      // Tab: the next layer beside it (⇧: the one before).
      if (is("Tab") && !mod && !alt) {
        const found = first && !first.includes("/") ? findNode(list, first) : null;
        const sibs = found ? (found.parent ? found.parent.children : tops) : tops;
        if (!sibs.length) return;
        handled();
        const i = found ? sibs.findIndex((n) => n.id === found.node.id) : -1;
        return setSelection([sibs[((i < 0 ? (shift ? 0 : -1) : i) + (shift ? -1 : 1) + sibs.length) % sibs.length].id]);
      }
      if (is("Backspace", "Delete") && !mod) { handled(); return a.deleteSelection(); }
      if (e.key.startsWith("Arrow") && !mod) {
        // (Arrows never scroll the editor's window, whatever is selected.)
        handled();
        const step = shift ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const tops = topmost(list, own).filter((t) => t.node.id !== root && !t.node.locked);
        if (!tops.length) return;
        return setNodes((ns) => updateNodes(ns, tops.map((t) => t.node.id), (n) => ({ ...n, x: n.x + dx, y: n.y + dy })));
      }

      // ── The view ──
      if (mod && !alt && is("Equal", "NumpadAdd", "Minus", "NumpadSubtract")) { handled(); const z = latest.current.viewStore.get().zoom; return zoomActions.current?.zoomTo(is("Minus", "NumpadSubtract") ? z / 2 : z * 2); }
      if (shift && !mod && !alt && is("Digit0", "Digit1", "Digit2")) {
        handled();
        if (is("Digit0")) zoomActions.current?.zoomTo(1);
        else if (is("Digit1")) zoomActions.current?.fitAll();
        else zoomActions.current?.fitSelection();
        return;
      }
      if (mod && is("Backslash")) { handled(); return setMinimized((m) => !m); }
      if (shift && !mod && !alt && is("KeyR")) { handled(); return setRulers((r) => !r); }

      // ── The clipboard ──
      if (mod && !shift && !alt && is("KeyD")) { handled(); return a.duplicateSelection(); }
      if (mod && alt && is("KeyC")) { handled(); return a.copyProperties(); }
      if (mod && alt && is("KeyV")) { handled(); return a.pasteProperties(); }
      // ⌘C / ⌘X / ⌘V: the browser's copy, cut and paste events do it (see below) — they reach the system's clipboard.
      // ⌘,: the settings.
      if (mod && !shift && !alt && is("Comma")) { handled(); return setSettingsOpen((o) => !o); }
      // ⌘F: Find, in the file's tab.
      if (mod && !shift && !alt && is("KeyF")) { handled(); setLeftTab("file"); return setQuery((q) => q ?? ""); }
      if (mod && !shift && !alt && is("KeyA")) {
        handled();
        const found = first && !first.includes("/") ? findNode(list, first) : null;
        return setSelection((found?.parent ? found.parent.children : tops).map((n) => n.id));
      }

      // ── Alignment: ⌥A D W S H V ──
      if (alt && !mod && !shift && own.length) {
        const how = ({ KeyA: "left", KeyD: "right", KeyW: "top", KeyS: "bottom", KeyH: "hcenter", KeyV: "vcenter" } as const)[code as "KeyA"];
        if (how) { handled(); return a.ops.align(how); }
      }

      // ── Groups, components, order, auto layout ──
      if (mod && alt && is("KeyG")) { handled(); return a.groupSelection("frame"); }
      if (mod && shift && is("KeyG")) { handled(); return a.ungroup(); }
      if (mod && !shift && is("KeyG")) { handled(); return a.groupSelection("group"); }
      if (mod && alt && is("KeyK")) { handled(); return a.createComponent(); }
      if (mod && alt && !shift && is("KeyA")) { handled(); return a.ops.selectMatching(); }
      if (mod && shift && is("KeyK")) { handled(); return a.placeImage(); }
      if (mod && shift && is("KeyR")) { handled(); return a.pasteToReplace(); }
      if (mod && !shift && !alt && is("Backspace")) { handled(); return a.ungroup(); }
      // Use as mask: ^⌘M on a Mac, Ctrl+Alt+M elsewhere (Figma's).
      if ((IS_MAC ? e.ctrlKey && e.metaKey : e.ctrlKey && alt) && is("KeyM") && first) { handled(); return a.maskWith(first.split("/")[0]); }
      // Figma's ^⌥T / ^⌥V / ^⌥H on a Mac: tidy up, distribute vertical / horizontal spacing.
      if (IS_MAC && e.ctrlKey && alt && !e.metaKey && is("KeyT", "KeyV", "KeyH") && own.length > 1) { handled(); return is("KeyT") ? a.ops.tidy() : a.ops.distribute(is("KeyV") ? "v" : "h"); }
      if (!mod && !alt && is("BracketRight", "BracketLeft")) { handled(); return a.reorder(is("BracketRight") ? "front" : "back"); }
      if (!mod && shift && !alt && is("KeyH", "KeyV") && own.length) { handled(); return a.flip(is("KeyH") ? "H" : "V"); }
      if (mod && alt && is("KeyB")) { handled(); return a.detach(); }
      if (mod && shift && is("KeyH") && first) { handled(); const n = getNode(list, first.split("/")[0]); return n && patch(n.id, { visible: n.visible === false ? undefined : false }); }
      if (mod && shift && is("KeyL") && first) { handled(); const n = getNode(list, first.split("/")[0]); return n && patch(n.id, { locked: n.locked ? undefined : true }); }
      if (mod && !shift && !alt && is("KeyR") && first) { handled(); setLeftTab("file"); return requestAnimationFrame(() => requestRename(first.split("/")[0])); }
      if (mod && is("BracketRight", "BracketLeft")) { handled(); return a.reorder(alt ? (is("BracketRight") ? "front" : "back") : is("BracketRight") ? "forward" : "backward"); }
      if (!mod && shift && is("KeyA") && own.length) { handled(); return a.autoLayout(alt); }

      // ── Text: ⇧⌘< > size, ⌥< > letter spacing, ⇧⌥< > line height, ⌥⌘< > weight, ⌘B bold ──
      if (texts.length && is("Comma", "Period")) {
        const up = is("Period") ? 1 : -1;
        if (mod && shift && !alt) return bump("fontSize", up, 1, 400);
        if (mod && alt && !shift) return bump("fontWeight", up * 100, 100, 900);
        if (alt && shift && !mod) return bump("lineHeight", up, 1, 1000);
        if (alt && !mod && !shift) return bump("letterSpacing", up * 0.1, -20, 100);
      }
      if (mod && !shift && !alt && is("KeyB") && texts.length) {
        handled();
        return setNodes((ns) => updateNodes(ns, texts.map((t) => t.id), (n) => (n.type === "text" ? { ...n, fontWeight: { value: numberOf(n.fontWeight, byId) >= 600 ? 400 : 700 } } : n)));
      }

      // ── Opacity: 1…9 → 10…90 %, 0 → 100 % ──
      if (!mod && !alt && !shift && own.length && /^Digit[0-9]$/.test(code)) {
        handled();
        const digit = Number(code.slice(5));
        return setNodes((ns) => updateNodes(ns, own, (n) => ({ ...n, opacity: digit === 0 ? undefined : digit * 10 })));
      }

      if (mod || alt || shift || e.repeat) return;
      const tools: Partial<Record<string, CanvasTool>> = { KeyV: "move", KeyH: "hand", KeyF: "frame", KeyA: "frame", KeyR: "rectangle", KeyO: "ellipse", KeyL: "line", KeyT: "text" };
      const next = tools[code];
      if (next) { handled(); setTool(next); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [patch, setNodes, setSelection, byId]);

  // ── Assets: the file's components, an instance put on the canvas with a click ──
  const components = useMemo(() => allComponents(library), [library]);
  const insertInstance = (component: FrameNode) => {
    const canvas = document.querySelector<HTMLElement>("[data-figma-canvas]");
    const w = canvas?.clientWidth ?? 800;
    const h = canvas?.clientHeight ?? 600;
    const view = viewNow();
    const cx = (w / 2 - view.x) / view.zoom;
    const cy = (h / 2 - view.y) / view.zoom;
    const instance = makeInstance(component, Math.round(cx - component.width / 2), Math.round(cy - component.height / 2));
    // A component edited on its own: into it — not into itself (an instance of a component in it would draw it without end).
    if (iso) {
      if (!insertRoot || createsCycle(insertRoot, [instance])) return;
      setNodes((list) => insertNode(list, insertRoot, { ...instance, x: 0, y: 0 }));
      setSelection([instance.id]);
      return;
    }
    // On the project's page: into its page frame (at the end of its flow), as a section of the site.
    const page = !file.currentPage ? getNode(nodes, doc.pageId) : null;
    const into = page && isFrameLike(page) && page.id !== component.id ? page : null;
    if (createsCycle(into?.id ?? null, [instance])) return;
    // In the page frame: in the site's column, as the page's other sections.
    setNodes((list) => insertNode(list, into?.id ?? null, into ? inPageColumn({ ...instance, x: 0, y: 0 }) : instance));
    setSelection([instance.id]);
  };

  /** What the site's code draws (see Embed) put in, as an instance is: a frame holding it, as wide as the column, as tall as it is drawn. */
  const insertEmbed = (kind: EmbedKind) => {
    const frame = makeFrame(EMBED_LABEL[kind], 0, 0, 672, 400);
    frame.fills = [];
    frame.clipsContent = false;
    frame.layoutMode = "vertical";
    frame.sizingH = "fill";
    frame.sizingV = "hug";
    frame.embed = {
      kind,
      ...(kind === "compare" ? { entries: [{ id: nid("e"), label: "Önce", labelEn: "Before" }, { id: nid("e"), label: "Sonra", labelEn: "After" }] } : {}),
      ...(kind === "devices" ? { variant: "phone" as const, entries: [{ id: nid("e") }, { id: nid("e") }, { id: nid("e") }] } : {}),
      ...(kind === "code" ? { language: "javascript", content: "// code" } : {}),
    };
    if (iso) {
      if (!insertRoot) return;
      setNodes((list) => insertNode(list, insertRoot, frame));
      setSelection([frame.id]);
      return;
    }
    const page = !file.currentPage ? getNode(nodes, doc.pageId) : null;
    if (page && isFrameLike(page)) setNodes((list) => insertNode(list, page.id, inPageColumn(frame)));
    else {
      const canvas = document.querySelector<HTMLElement>("[data-figma-canvas]");
      const view = viewNow();
      const cx = ((canvas?.clientWidth ?? 800) / 2 - view.x) / view.zoom;
      const cy = ((canvas?.clientHeight ?? 600) / 2 - view.y) / view.zoom;
      setNodes((list) => insertNode(list, null, { ...frame, x: Math.round(cx - 336), y: Math.round(cy - 200), sizingH: undefined }));
    }
    setSelection([frame.id]);
  };

  // The layers listed: the open page's — in the Page Editor, the page frame's own tree (what sits beside it on the canvas isn't drawn there).
  const layerNodes = useMemo(() => (pageRoot ? nodes.filter((n) => n.id === pageRoot) : nodes), [nodes, pageRoot]);
  // Find's pages: every page of the file (the components' too); "This page", the open one — a component edited on its own, it alone.
  const findPages = useMemo<FindPage[]>(() => [
    { id: "", name: pages[0].name, nodes: file.nodes },
    ...(file.pages ?? []).map((pg) => ({ id: pg.id, name: pg.name, nodes: pg.nodes })),
  ], [file, pages]);
  const findCurrent = useMemo<FindPage>(() => {
    const id = iso ? iso.page : file.currentPage ?? "";
    return { id, name: isolatedNode?.name ?? pages.find((pg) => pg.id === id)?.name ?? "", nodes: doc.nodes };
  }, [iso, isolatedNode, file.currentPage, pages, doc.nodes]);
  const previewNode = previewing ? getNode(nodes, previewing) : null;

  return (
    <div className="relative flex h-full min-h-0 text-[11px] leading-4 text-[var(--text-title)]" style={{ ...FIGMA_TOKENS[theme], fontFamily: "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif" }}>
      <style>{EDITOR_CSS}</style>
      {/* ── The navigation bar: the menu, then the tabs — icons only, their names as tooltips ── */}
      {!minimized && (
        <nav aria-label="Navigation" data-instant="" className="f-nav w-12 shrink-0 h-full flex flex-col items-center border-r border-[var(--f-border)] bg-[var(--f-bg)] z-20 select-none">
          <button type="button" aria-label="Main menu" aria-haspopup="menu" onClick={(e) => openMenuUnder(e.currentTarget, shellMenu())} className="flex items-center justify-center w-12 h-12 text-[var(--f-icon)] hover:bg-[var(--f-bg-hover)] transition-colors cursor-pointer">
            <span className="flex items-center">{fi("24.figma", 20)}<span className="-ml-1 text-[var(--f-icon-secondary)]">{fi("16.chevron.down", 12)}</span></span>
          </button>
          <span className="w-6 h-px my-1 bg-[var(--f-border)]" />
          <NavTab icon={fi("24.page", 20)} label="File" active={tab === "file"} onClick={() => openTab("file")} />
          <NavTab icon={fi("16.component", 20)} label="Components" active={tab === "components"} onClick={() => openTab("components")} />
          <NavTab icon={fi("24.library", 20)} label="Assets" active={tab === "assets"} onClick={() => openTab("assets")} />
          <NavTab icon={fi("24.image", 20)} label="Images" active={tab === "images"} onClick={() => openTab("images")} />
          <NavTab icon={fi("variable.small", 20)} label="Variables" active={variablesOpen} onClick={() => setVariablesOpen(true)} />
        </nav>
      )}

      {/* ── The left sidebar ── */}
      {!minimized && (
        <aside data-left-panel="" data-instant="" className="relative shrink-0 h-full flex flex-col border-r border-[var(--f-border)] bg-[var(--f-bg)] z-10" style={{ width: panelWidths.left }}>
          <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={resizePanel("left")} className="absolute top-0 bottom-0 -right-[3px] w-[6px] z-30 cursor-col-resize hover:bg-[var(--f-border-selected)]/40 active:bg-[var(--f-border-selected)]/40" />
          <div className="shrink-0 flex items-start gap-1 h-14 pl-4 pr-3 pt-2 border-b border-[var(--f-border)]">
            <div className="min-w-0 flex-1 flex flex-col">
              <button type="button" aria-haspopup="menu" onClick={(e) => openMenuUnder(e.currentTarget, shellMenu())} className="flex items-center gap-1 min-w-0 h-[22px] text-left cursor-pointer">
                <span className="min-w-0 truncate text-[13px] font-[550] leading-[22px] tracking-[-0.0325px] text-[var(--f-text)]">{title || slug}</span>
                <span className="shrink-0 text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
              </button>
              <span className="truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">burakkoc.net</span>
            </div>
            <IconButton label="Hide UI (⌘\\)" icon={fi("24.sidebar.closed")} onClick={() => setMinimized(true)} />
          </div>
          {(tab === "file" || tab === "components") && query !== null && (
            <FindPanel
              query={query}
              onQuery={setQuery}
              current={findCurrent}
              pages={findPages}
              lang={lang}
              onClose={() => setQuery(null)}
              onPick={openNode}
              onPickPage={(page) => { if (iso) endIsolation(); if ((file.currentPage ?? "") !== page) switchPage(page); }}
              onReplace={onDoc}
              openMenu={(el, entries) => openMenuUnder(el, entries, "right")}
            />
          )}
          {(tab === "file" || tab === "components") && query === null && (
            <>
              {tab === "components" ? (
                // The site's library: every project's components, on the canvas — edited here, in place.
                <CollapseHeader
                  label="Components"
                  icons={<IconButton label="Find" icon={fi("24.search.small")} active={query !== null} onClick={() => setQuery((q) => (q === null ? "" : null))} />}
                />
              ) : iso && isolatedNode ? (
                // A component edited on its own: what it is, the way back to the file.
                <div className="f-tip-start shrink-0 flex items-center gap-1 h-10 pl-2 pr-3 border-b border-[var(--f-border)]">
                  <IconButton label="Back to the file (Esc)" icon={fi("16.chevron.right", undefined, "rotate-180")} onClick={endIsolation} />
                  <span className="flex shrink-0 text-[var(--f-text-component)]">{fi(isolatedNode.type === "componentSet" ? "16.component.set" : "16.component")}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-[550] leading-4 tracking-[0.055px] text-[var(--f-text)]">{isolatedNode.name}</span>
                </div>
              ) : (
              <section aria-label="Pages" className="shrink-0 flex flex-col pb-2 border-b border-[var(--f-border)]">
                <CollapseHeader
                  label="Pages"
                  icons={
                    <>
                      <IconButton label="Find" icon={fi("24.search.small")} active={query !== null} onClick={() => setQuery((q) => (q === null ? "" : null))} />
                      <IconButton label="Add new page" icon={fi("plus.small")} onClick={addPage} />
                    </>
                  }
                />
                <div className="flex flex-col px-2 py-1">
                  {pages.filter((pg) => pg.id !== COMPONENTS_PAGE_ID).map((pg) => {
                    const current = (file.currentPage ?? "") === pg.id;
                    return (
                      <div
                        key={pg.id || "main"}
                        onClick={() => !current && switchPage(pg.id)}
                        onDoubleClick={() => setRenamingPage(pg.id)}
                        onContextMenu={(e) => openMenu(e, [{ label: "Rename page", onSelect: () => setRenamingPage(pg.id) }, { label: "Delete page", disabled: !pg.id, onSelect: () => removePage(pg.id) }])}
                        className={cn("flex items-center h-8 pl-2 pr-1 rounded-[5px] text-[11px] font-[450] leading-4 text-[var(--f-text)] cursor-pointer", current ? "bg-[var(--f-bg-row-selected)]" : "hover:bg-[var(--f-bg-row-hover)]")}
                      >
                        {renamingPage === pg.id ? (
                          <input autoFocus aria-label="Page name" defaultValue={pg.name} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { renamePage(pg.id, e.currentTarget.value); setRenamingPage(null); } if (e.key === "Escape") setRenamingPage(null); }} onBlur={(e) => { renamePage(pg.id, e.currentTarget.value); setRenamingPage(null); }} className="min-w-0 flex-1 h-5 px-1 rounded-[3px] bg-[var(--f-bg)] border border-[var(--f-border-selected)] outline-none" />
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate">{pg.name}</span>
                            {!pg.id && <span className="text-[var(--f-text-secondary)]" title="Shown on the site">{fi("16.page")}</span>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
              )}
              <CollapseHeader
                label="Layers"
                icons={
                  <>
                    {iso && <IconButton label="Find" icon={fi("24.search.small")} active={query !== null} onClick={() => setQuery((q) => (q === null ? "" : null))} />}
                    <IconButton label="Collapse layers" icon={fi("collapse-layers.small")} onClick={() => setOpen(new Set())} />
                  </>
                }
              />
              <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full overflow-x-hidden flex flex-col pb-4" inset={8} edge={2}>
                <Layers
                  nodes={layerNodes}
                  library={library}
                  selection={selected}
                  open={open}
                  onToggle={(id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                  onToggleMany={(ids, on) => setOpen((prev) => { const next = new Set(prev); ids.forEach((id) => (on ? next.add(id) : next.delete(id))); return next; })}
                  onSelect={(id, additive) => {
                    setSelection(additive ? (selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]) : [id]);
                    // The Page Editor: the page scrolls to the layer picked (when it is out of sight).
                    if (paged && !additive) window.setTimeout(() => zoomActions.current?.fitSelection(), 60);
                  }}
                  onSelectMany={(ids) => setSelection(ids)}
                  onClear={() => setSelection([])}
                  onLocate={(id) => { setSelection([id]); window.setTimeout(() => zoomActions.current?.fitSelection(), 60); }}
                  onRename={renameLayer}
                  onToggleHidden={(id) => {
                    if (id.includes("/")) {
                      // Inside an instance: the instance's override of the layer — shown or hidden in so many words (a layer the
                      // component hides can be shown in one instance).
                      const l = layerAt(library, id);
                      if (l) override(id, { visible: l.node.visible === false });
                      return;
                    }
                    const n = getNode(nodes, id);
                    if (n) patch(id, { visible: n.visible === false ? undefined : false });
                  }}
                  onToggleLocked={(id) => { const n = getNode(nodes, id); if (n) patch(id, { locked: n.locked ? undefined : true }); }}
                  onMoveInTree={moveInTree}
                  onContextMenu={(id, e) => { if (!selected.includes(id)) setSelection([id]); openMenu(e, nodeMenu(id)); }}
                />
              </ScrollArea>
            </>
          )}
          {tab === "assets" && (
            <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full overflow-x-hidden flex flex-col pb-3" inset={8} edge={2}>
              <CollapseHeader label="Local components" />
              {components.length === 0 && <p className="px-4 py-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">No components yet. Select a frame and press ⌥⌘K.</p>}
              {/* As Figma's Assets: a set once — its default (first) variant is what a click puts in. */}
              {components.filter(({ component, set }) => !set || variantsOf(set)[0]?.id === component.id).map(({ component, set }) => (
                <div key={component.id} className="px-2 py-0.5">
                  {/* A click puts an instance on the page; the right click edits the component on its own. */}
                  <button
                    type="button"
                    onClick={() => insertInstance(component)}
                    onContextMenu={(e) => openMenu(e, [
                      { label: "Edit component", onSelect: () => editComponent(set?.id ?? component.id) },
                      { label: "Insert instance", onSelect: () => insertInstance(component) },
                      "-",
                      { label: "Delete component", disabled: stays.has(component.id) || Boolean(set && stays.has(set.id)), onSelect: () => deleteComponent(set?.id ?? component.id) },
                    ])}
                    className={cn("flex items-center gap-2 w-full h-8 px-2 rounded-[5px] text-left hover:bg-[var(--f-bg-hover)] cursor-pointer", iso && (iso.id === component.id || iso.id === set?.id) && "bg-[var(--f-bg-row-selected)]")}
                  >
                    <span className="flex shrink-0 text-[var(--f-text-component)]"><FigmaIcon name="16.component" /></span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--f-text)]">{set ? set.name : component.name}</span>
                  </button>
                </div>
              ))}
              <CollapseHeader label="Embeds" />
              <p className="px-4 pb-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">What the site&apos;s code draws: a video playing, code, a Figma file, a page… Set it up in the Embed section.</p>
              {EMBED_KINDS.map((kind) => (
                <div key={kind} className="px-2 py-0.5">
                  <button type="button" onClick={() => insertEmbed(kind)} className="flex items-center gap-2 w-full h-8 px-2 rounded-[5px] text-left hover:bg-[var(--f-bg-hover)] cursor-pointer">
                    <span className="flex shrink-0 text-[var(--f-icon-secondary)]"><FigmaIcon name="16.frame" /></span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--f-text)]">{EMBED_LABEL[kind]}</span>
                  </button>
                </div>
              ))}
            </ScrollArea>
          )}
          {imagesOpened && (
            <div className={cn("flex flex-col flex-1 min-h-0", tab !== "images" && "hidden")}>
              <ImagesPanel
                slug={slug}
                file={tab === "images" ? file : null}
                active={tab === "images"}
                canFill={tab === "images" && selected.some((id) => { const n = id.includes("/") ? layerAt(library, id)?.node : getNode(nodes, id); return Boolean(n && n.type !== "text"); })}
                onUse={onUseImage}
              />
            </div>
          )}
        </aside>
      )}

      {/* ── The canvas ── */}
      <div className="relative flex-1 min-w-0 h-full">
        {iso && isolatedNode && (
          // A component edited on its own: which one, and Done (Esc) back to the file.
          <div className="absolute top-3 -translate-x-1/2 z-30 flex items-center gap-2 h-10 pl-3 pr-1 rounded-[9px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)] select-none" style={{ left: `calc(50% + ${hiddenShift}px)` }}>
            <span className="flex shrink-0 text-[var(--f-text-component)]">{fi(isolatedNode.type === "componentSet" ? "16.component.set" : "16.component")}</span>
            <span className="max-w-[240px] truncate text-[11px] font-[550] leading-4 tracking-[0.055px] text-[var(--f-text)]">{isolatedNode.name}</span>
            <BrandButton onClick={endIsolation}>Done</BrandButton>
          </div>
        )}
        {minimized && (
          <>
            <div className="absolute top-3 left-3 z-30 flex items-center gap-1 h-12 pl-2 pr-2 rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)] select-none">
              <button type="button" aria-label="Main menu" onClick={(e) => openMenuUnder(e.currentTarget, shellMenu())} className="flex items-center justify-center w-8 h-8 rounded-[5px] text-[var(--f-icon)] hover:bg-[var(--f-bg-hover)] cursor-pointer">{fi("24.figma")}</button>
              <span className="px-1 text-[13px] font-[550] leading-[22px] tracking-[-0.0325px] text-[var(--f-text)]">{title || slug}</span>
              <IconButton label="Show UI (⌘\\)" icon={fi("24.sidebar.closed")} onClick={() => setMinimized(false)} />
            </div>
            <div className="absolute top-3 right-3 z-30 flex items-center gap-2 h-12 pl-2 pr-2 rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)] select-none">
              {mode !== "code" && (
                <button type="button" aria-haspopup="menu" onClick={(e) => openMenuUnder(e.currentTarget, zoomMenu(), "right")} className="flex items-center h-8 px-2 rounded-[5px] text-[11px] text-[var(--f-text)] tabular-nums hover:bg-[var(--f-bg-hover)] cursor-pointer">
                  <ZoomPercent store={viewStore} /><span className="text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
                </button>
              )}
              <button type="button" aria-label="Present" onClick={() => startPreview()} className="flex items-center justify-center w-8 h-8 rounded-[5px] text-[var(--f-icon)] hover:bg-[var(--f-bg-hover)] cursor-pointer">{fi("24.play")}</button>
              <SaveButton session={session} />
            </div>
          </>
        )}
        <SaveProblem session={session} />
        {notice && (
          <div role="status" className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 max-w-[520px] px-3 py-2 rounded-[9px] bg-[var(--f-bg-menu)] text-white text-[11px] leading-4 shadow-[0_2px_12px_rgba(0,0,0,0.25)]" style={{ marginLeft: hiddenShift }}>
            {notice}
          </div>
        )}
        {/* The canvas stays under the code's view: the panels' edits that measure layers as drawn (grouping, ungrouping, removing an auto layout) still can. */}
        <ViewedCanvas
          // Each view its own canvas: nothing of a drag or a hover is carried from one to the other.
          key={paged ? "page" : "canvas"}
          doc={doc}
          render={render}
          selection={selected}
          onSelect={setSelection}
          store={viewStore}
          tool={tool}
          onTool={setTool}
          onMove={onMove}
          onReparent={onReparent}
          onAddVariant={addVariant}
          prototyping={rightTab === "prototype"}
          onConnect={connect}
          onRetarget={retarget}
          onOpenReaction={openConnection}
          onPlayFlow={(id) => startPreview(id)}
          onReorder={onReorder}
          onResize={onResize}
          onDraw={onDraw}
          onDoubleClick={onDoubleClick}
          onContextMenu={(id, e) => { if (id && !selected.includes(id)) setSelection([id]); openMenu(e, nodeMenu(id, { x: e.clientX, y: e.clientY })); }}
          onLayoutEdit={(id, p) => patch(id, p as Partial<SceneNode>)}
          layoutFocus={layoutFocus}
          zoomActionsRef={zoomActions}
          rulers={rulers}
          background={doc.background}
          pageId={pageRoot}
          previewWidth={paged ? previewWidth : null}
          rightMousePan={settings.rightMousePan}
          horizontalScrollZoom={settings.horizontalScrollZoom}
          horizontalScrollZoomReversed={settings.horizontalScrollZoomReversed}
        />
        {mode === "code" && (
          // The code's view: to come — over the canvas, taking its pointer and its wheel.
          <div data-code-view="" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 bg-[var(--edit-canvas)] select-none">
            <span className="flex items-center justify-center w-10 h-10 mb-2 rounded-[8px] bg-[var(--f-bg)] text-[var(--f-icon-secondary)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)]">{fi("24.dev-brackets")}</span>
            <p className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px] text-[var(--f-text)]">Code</p>
            <p className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">Coming soon</p>
          </div>
        )}
        {paged && !getNode(nodes, doc.pageId) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 select-none">
            <p className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px] text-[var(--f-text)]">No page frame</p>
            <p className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">In the Canvas Editor, right-click a frame and choose “Set as site page”.</p>
          </div>
        )}
        {/* The toolbar, as the kit's: 8px in, the tools 8px apart, a line before the end. */}
        <div role="toolbar" aria-label="Tools" data-instant="" onClick={(e) => e.stopPropagation()} className="absolute bottom-4 -translate-x-1/2 z-30 flex items-center gap-2 h-12 px-2 rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)] select-none" style={{ left: `calc(50% + ${hiddenShift}px)` }}>
          {/* The tools: the canvas's and the page's (the code's view has nothing to draw on). */}
          <div aria-disabled={mode === "code" || undefined} className={cn("flex items-center gap-2", mode === "code" && "opacity-40 pointer-events-none")}>
            <Tool icon={<FigmaIcon name={tool === "hand" ? "24.hand" : "24.move"} />} label={tool === "hand" ? "Hand" : "Move"} shortcut={tool === "hand" ? "H" : "V"} active={tool === "move" || tool === "hand"} onClick={() => setTool("move")} menuLabel="Move tools" menu={(el) => openMenuUnder(el, [{ label: "Move", shortcut: "V", checked: tool === "move", onSelect: () => setTool("move") }, { label: "Hand", shortcut: "H", checked: tool === "hand", onSelect: () => setTool("hand") }])} />
            <Tool icon={<FigmaIcon name="24.frame" />} label="Frame" shortcut="F" active={tool === "frame"} onClick={() => setTool("frame")} />
            <Tool icon={<FigmaIcon name={tool === "ellipse" ? "24.ellipse" : tool === "line" ? "24.line" : "24.rectangle"} />} label={tool === "ellipse" ? "Ellipse" : tool === "line" ? "Line" : "Rectangle"} shortcut={tool === "ellipse" ? "O" : tool === "line" ? "L" : "R"} active={tool === "rectangle" || tool === "ellipse" || tool === "line"} onClick={() => setTool("rectangle")} menuLabel="Shape tools" menu={(el) => openMenuUnder(el, [{ label: "Rectangle", shortcut: "R", checked: tool === "rectangle", onSelect: () => setTool("rectangle") }, { label: "Ellipse", shortcut: "O", checked: tool === "ellipse", onSelect: () => setTool("ellipse") }, { label: "Line", shortcut: "L", checked: tool === "line", onSelect: () => setTool("line") }, "-", { label: "Place image…", shortcut: keys("shift", "mod", "k"), onSelect: placeImage }])} />
            <Tool icon={<FigmaIcon name="24.text" />} label="Text" shortcut="T" active={tool === "text"} onClick={() => setTool("text")} />
            <span aria-hidden className="w-px h-12 -my-2 bg-[var(--f-border)]" />
            <Tool icon={<FigmaIcon name="24.component" />} label="Create component" shortcut="⌥⌘K" onClick={createComponent} />
            <Tool icon={<FigmaIcon name="24.prototyping" />} label="Present" onClick={() => startPreview()} />
          </div>
          {/* The Page Editor's widths: the page as a tablet or a phone shows it (the site's narrow-screen rules). */}
          {paged && (
            <>
              <span aria-hidden className="w-px h-12 -my-2 bg-[var(--f-border)]" />
              <div role="tablist" aria-label="Preview width" className="flex items-center gap-1">
                {PREVIEW_WIDTHS.map((p) => (
                  <ModeTab key={p.label} label={p.label} active={previewWidth === p.width} onClick={() => { setPreviewWidth(p.width); requestAnimationFrame(() => zoomActions.current?.fitAll()); }} />
                ))}
              </div>
            </>
          )}
          {/* The editor's views, at the toolbar's end. */}
          <span aria-hidden className="w-px h-12 -my-2 bg-[var(--f-border)]" />
          <div role="tablist" aria-label="Editor" className="flex items-center gap-1">
            {EDITOR_MODES.map((m) => (
              <ModeTab key={m.id} label={m.label} active={mode === m.id} onClick={() => setMode(m.id)} />
            ))}
          </div>
        </div>
      </div>

      {/* ── The right sidebar: the header (the language, present, Save), the tabs with the zoom, the properties ── */}
      {!minimized && (
        <aside data-design-panel="" data-instant="" className="relative shrink-0 h-full flex flex-col border-l border-[var(--f-border)] bg-[var(--f-bg)] z-10" style={{ width: panelWidths.right }}>
          <div role="separator" aria-orientation="vertical" aria-label="Resize panel" onPointerDown={resizePanel("right")} className="absolute top-0 bottom-0 -left-[3px] w-[6px] z-30 cursor-col-resize hover:bg-[var(--f-border-selected)]/40 active:bg-[var(--f-border-selected)]/40" />
          <div className="shrink-0 flex flex-col gap-2 p-2 border-b border-[var(--f-border)]">
            <div className="flex items-center justify-between pl-1">
              <AccountButton account={account} onClick={(el) => openMenuUnder(el, [{ label: account.name ?? account.email ?? "Not signed in", hint: account.name ? account.email ?? undefined : undefined, disabled: true }, "-", { label: "Settings…", shortcut: keys("mod", ","), onSelect: () => setSettingsOpen(true) }, ...(account.signOut ? ["-" as const, { label: "Sign out", onSelect: () => account.signOut?.() }] : [])])} />
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-[5px] hover:bg-[var(--f-bg-hover)]">
                  <button type="button" aria-label="View on site" title={isPublished ? "View on site" : "Save first"} disabled={!isPublished} onClick={() => openExternal(`${SITE_URL}/projects/${slug}`)} className="flex items-center justify-center w-8 h-8 rounded-[5px] text-[var(--f-icon)] cursor-pointer disabled:opacity-40 disabled:cursor-default">
                    {fi("24.play")}
                  </button>
                  <button type="button" aria-label="Present options" onClick={(e) => openMenuUnder(e.currentTarget, [{ label: "View on site", disabled: !isPublished, onSelect: () => openExternal(`${SITE_URL}/projects/${slug}`) }, { label: "Preview the saved draft", hint: session.dirty ? "save first" : undefined, onSelect: () => shellBridge()?.openPreview(slug) }, { label: "Present", onSelect: () => startPreview() }], "right")} className="flex items-center justify-center w-4 h-8 text-[var(--f-icon-secondary)] cursor-pointer">
                    {fi("16.chevron.down")}
                  </button>
                </div>
                <SaveButton session={session} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 pl-1 -mt-1">
              <span className="min-w-0 truncate text-[11px] leading-4 text-[var(--f-text-secondary)]" title={session.meta?.published ? (session.meta.changedSincePublish ? "The site shows an older version" : "The site shows this version") : "Not on the site"}>
                {session.meta?.published ? (session.meta.changedSincePublish || session.dirty ? "Published · changed since" : "Published") : "Draft"}
              </span>
              <PublishButton session={session} />
            </div>
            <div role="tablist" className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Tab label="Design" active={rightTab === "design"} onClick={() => setRightTab("design")} />
                <Tab label="Prototype" active={rightTab === "prototype"} onClick={() => setRightTab("prototype")} />
              </div>
              {/* (The code's view has no canvas to zoom.) */}
              {mode !== "code" && (
                <button type="button" aria-haspopup="menu" onClick={(e) => openMenuUnder(e.currentTarget, zoomMenu(), "right")} className="flex items-center justify-end w-[60px] h-6 pl-1 rounded-[5px] text-[11px] leading-4 text-[var(--f-text)] tabular-nums hover:bg-[var(--f-bg-hover)] cursor-pointer">
                  <ZoomPercent store={viewStore} />
                  <span className="text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
                </button>
              )}
            </div>
          </div>
          {/* 160px of room under the last section (Export), so it never sits at the very bottom edge. */}
          <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full overflow-x-hidden flex flex-col pb-[160px]" inset={8} edge={2}>
            <Inspector nodes={library} pageNodes={nodes} selection={selected} tab={rightTab} ops={ops} variables={variables} byId={byId} mode={theme} textStyles={textStyles} lang={lang} background={doc.background ?? "#f5f5f5"} header={headerMenu} />
          </ScrollArea>
        </aside>
      )}

      {menu && <ContextMenu at={menu} entries={menu.entries} onClose={() => setMenu(null)} />}

      {variablesOpen && <VariablesTable system={system} onClose={() => setVariablesOpen(false)} />}
      {versionsOpen && <VersionsWindow session={session} onClose={() => setVersionsOpen(false)} />}
      {settingsOpen && <SettingsWindow settings={settings} onChange={changeSetting} onClose={() => setSettingsOpen(false)} />}

      {previewNode && isFrameLike(previewNode) && (
        <Player file={file} pageNodes={iso ? (iso.page ? file.pages?.find((x) => x.id === iso.page)?.nodes ?? [] : file.nodes) : nodes} start={previewNode.id} variables={variables} lang={lang} onClose={() => setPreviewing(null)} />
      )}
    </div>
  );
}

/** The canvas, drawn again with its view (see ViewStore) — the editor around it isn't. */
function ViewedCanvas({ store, ...props }: Omit<React.ComponentProps<typeof Canvas>, "view" | "onView"> & { store: ViewStore }) {
  const view = useView(store);
  return <Canvas {...props} view={view} onView={store.set} />;
}

export { layerIcon };
