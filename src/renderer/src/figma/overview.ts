import type { ProjectData } from "@/types/project";
import { OVERVIEW_NAME, inPageColumn, overviewContent, overviewFor, pageFrameOf, sitePageFrame } from "./page";
import {
  findComponent,
  insertNode,
  isFrameLike,
  libraryOf,
  propertiesOf,
  removeNodes,
  resolveInstance,
  walk,
  type FigmaDocument,
  type FixedPart,
  type FrameNode,
  type SceneNode,
  type ShapeNode,
  type TextNode,
} from "./model";

/**
 * The page's Overview — the project's title, its category and year, its
 * description and cover — as the page frame's first layer, on every
 * project's page: an instance of the Overview component (c-overview, on the
 * Components page), made with a new project's page, the template's example
 * in it to fill in (see page.ts's Missing).
 *
 *  - Its look is the component's: edited on the component (Go to main
 *    component), it changes the page's overview. Its words are the
 *    instance's text properties, its parts shown or not by its booleans
 *    (Subtitle, Description, Cover), its picture the instance's fill of the
 *    Cover's Image.
 *  - The instance and the component's parts are marked as the project's
 *    (SceneNode.fixed): they can't be deleted, moved out of their place,
 *    wrapped, unwrapped, detached or renamed — the editor's actions leave
 *    them out, and any change that would break the overview is refused
 *    (keepsOverview).
 *  - Saved, it is the project's own fields (overviewFields): what the
 *    projects' list, the cards and the page's title read. A subtitle, a
 *    description or a cover not shown is none.
 */

/** Each part's parent part. */
const PARENT: Record<FixedPart, FixedPart | null> = {
  overview: null,
  header: "overview",
  title: "header",
  subtitle: "header",
  description: "overview",
  cover: "overview",
  image: "cover",
};
const PARTS = Object.keys(PARENT) as FixedPart[];

/** The parts that stay in sight: the project's title, over its header. (The others not shown: the project has none of them.) */
const ALWAYS_SHOWN = ["header", "title"] as const;

export interface OverviewParts {
  /** The page's instance */
  instance: FrameNode;
  /** It, resolved: what it draws, its parts the component's */
  overview: FrameNode;
  header: FrameNode;
  title: TextNode;
  subtitle: TextNode;
  description: TextNode;
  cover: FrameNode;
  image: ShapeNode;
}

/** Is the layer the kind its part is? */
const fits = (part: FixedPart, node: SceneNode) =>
  part === "title" || part === "subtitle" || part === "description" ? node.type === "text" : part === "image" ? node.type === "rectangle" : node.type === "frame";

const found = new WeakMap<FigmaDocument, OverviewParts | null>();

/**
 * The page's overview, part by part — null when it isn't whole: the page
 * frame's first layer not the marked instance, its component gone, a part
 * of it missing, out of its place, of another kind or there twice, or its
 * words and parts no longer the instance's to set (a text not bound to its
 * text property, a part not shown by its boolean).
 */
export function overviewOf(doc: FigmaDocument): OverviewParts | null {
  if (!found.has(doc)) found.set(doc, partsOf(doc));
  return found.get(doc)!;
}

function partsOf(doc: FigmaDocument): OverviewParts | null {
  const first = pageFrameOf(doc)?.children[0];
  if (!first || first.fixed !== "overview" || first.type !== "instance" || !first.mainId) return null;
  const lib = libraryOf(doc);
  const overview = resolveInstance(lib, first);
  if (!overview || overview.fixed !== "overview") return null;
  const parts: Partial<Record<FixedPart, SceneNode>> = { overview };
  let whole = true;
  walk(overview.children, (node, parent) => {
    if (!node.fixed) return;
    if (parts[node.fixed] || !fits(node.fixed, node) || parent?.fixed !== PARENT[node.fixed]) whole = false;
    else parts[node.fixed] = node;
  }, overview);
  if (!whole || !PARTS.every((p) => parts[p])) return null;
  const o = { ...parts, instance: first } as OverviewParts;
  const properties = propertiesOf(lib, first.mainId);
  const has = (id: string | undefined, type: "text" | "boolean") => properties.some((p) => p.id === id && p.type === type);
  const bound =
    has(o.title.charactersProp, "text") &&
    has(o.subtitle.charactersProp, "text") && has(o.subtitle.visibleProp, "boolean") &&
    has(o.description.charactersProp, "text") && has(o.description.visibleProp, "boolean") &&
    has(o.cover.visibleProp, "boolean");
  return bound ? o : null;
}

/**
 * The ids of the layers that stay: the site's page frame, the overview's
 * instance, the component it is an instance of and that component's parts
 * (another variant of it, not in use, goes as any).
 */
export function fixedIds(doc: FigmaDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  if (pageFrameOf(doc)) ids.add(doc.pageId);
  const o = overviewOf(doc);
  const main = o?.instance.mainId ? findComponent(libraryOf(doc), o.instance.mainId) : null;
  if (!o || !main) return ids;
  ids.add(o.instance.id);
  walk([main], (node) => {
    if (node.fixed) ids.add(node.id);
  });
  return ids;
}

/**
 * Does the change from `before` to `after` keep the overview — the same
 * instance, the page frame's first, in sight, every part of its component
 * in its place, the title shown? (Nothing to keep when `before` had none
 * whole.)
 */
export function keepsOverview(before: FigmaDocument, after: FigmaDocument): boolean {
  if (before.nodes === after.nodes && before.pages === after.pages && before.pageId === after.pageId) return true;
  const was = overviewOf(before);
  if (!was) return true;
  const now = overviewOf(after);
  if (!now) return false;
  return now.instance.id === was.instance.id && now.instance.visible !== false && ALWAYS_SHOWN.every((p) => now[p].visible !== false);
}

// ── The overview made whole ───────────────────────────────────────────────────

/** Without the project's mark, anywhere in it. */
function unmarked(node: SceneNode): SceneNode {
  const own = { ...node };
  delete own.fixed;
  return isFrameLike(own) ? { ...own, children: own.children.map(unmarked) } : own;
}

const shown = (node?: SceneNode) => Boolean(node && node.visible !== false);
const said = (s?: string | null): s is string => Boolean(s && s.trim());

/** Is it an instance of the Overview component (a variant of it too)? */
const isOverviewInstance = (lib: readonly SceneNode[], node: SceneNode) =>
  node.type === "instance" && Boolean(node.mainId && findComponent(lib, node.mainId)?.fixed === "overview");

/**
 * The file with its page's overview whole (see overviewOf): kept as it is
 * when it is; on an empty page — a new project's — the site's page made, its
 * overview the template's example to fill in; otherwise the instance there
 * (marked, or the page's first) put first and marked — or a new one, from
 * the project's fields. Nothing else on the page keeps a mark. A page frame
 * isn't made where there is none, nor an overview without its component.
 */
export function withOverview(doc: FigmaDocument, project: ProjectData): FigmaDocument {
  const page = pageFrameOf(doc);
  if (!page || overviewOf(doc)) return doc;
  if (!page.children.length) {
    const made = sitePageFrame(page, project.title || project.slug, [inPageColumn(overviewFor(doc, overviewContent(project, "sample")))]);
    return keep(doc, { ...doc, nodes: doc.nodes.map((n) => (n.id === page.id ? made : n)) });
  }
  const lib = libraryOf(doc);
  const kids = page.children;
  let at = kids.findIndex((c) => c.fixed === "overview" && isOverviewInstance(lib, c));
  if (at < 0 && isOverviewInstance(lib, kids[0])) at = 0;
  const lead: SceneNode = at >= 0
    ? { ...kids[at], fixed: "overview", name: OVERVIEW_NAME, visible: undefined }
    : inPageColumn(overviewFor(doc, overviewContent(project, "hidden")));
  const rest = kids.filter((_, i) => i !== at);
  return keep(doc, { ...doc, nodes: doc.nodes.map((n) => (n.id === page.id ? { ...page, children: [lead, ...rest].map((c, i) => (i === 0 ? c : unmarked(c))) } : n)) });
}

/** `next` when its overview is whole — else the file as it was. */
const keep = (doc: FigmaDocument, next: FigmaDocument) => (overviewOf(next) ? next : doc);

/**
 * Another top-level frame as the site's page ("Set as site page"): the
 * overview goes with it, its first layer. When the frame leads with a copy
 * of it (a copy of the page), the overview takes the copy's place and what
 * the copy says. Into anything but a plain frame it can't: the page stays.
 */
export function withSitePage(doc: FigmaDocument, id: string): FigmaDocument {
  if (id === doc.pageId) return doc;
  const target = doc.nodes.find((n) => n.id === id);
  const parts = overviewOf(doc);
  if (!parts) return target ? { ...doc, pageId: id } : doc;
  if (!target || target.type !== "frame") return doc;
  const lead = target.children[0];
  const copy = lead && !lead.fixed && isOverviewInstance(libraryOf(doc), lead) ? (lead as FrameNode) : null;
  const moved: FrameNode = copy ? { ...parts.instance, mainId: copy.mainId, props: copy.props, propsEn: copy.propsEn, propsI18n: copy.propsI18n, overrides: copy.overrides } : parts.instance;
  const gone = new Set([parts.instance.id, ...(copy ? [copy.id] : [])]);
  return { ...doc, pageId: id, nodes: insertNode(removeNodes(doc.nodes, gone), id, moved, 0) };
}

/** The page's Overview saying another title (a copy of the project): its instance's Title property, the page frame's name. */
export function withOverviewTitle(doc: FigmaDocument, title: string): FigmaDocument {
  const page = pageFrameOf(doc);
  if (!page) return doc;
  const children = page.children.map((c, i) => (i === 0 && c.fixed === "overview" && c.type === "instance" ? { ...c, props: { ...c.props, title } } : c));
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === page.id ? { ...page, name: title, children } : n)) };
}

// ── The project's fields ──────────────────────────────────────────────────────

export type OverviewFields = Required<Pick<ProjectData, "title" | "titleEn" | "category" | "year" | "description" | "descriptionEn" | "coverImage">>;

/** A year, or a span of them ("2024", "2024–2025"). */
const YEAR = /^\d{4}(\s*[-–]\s*\d{2,4})?$/;

/** "UX / UI Design · 2026" as its category and its year — the year the part after the last "·", when it is one. */
function categoryAndYear(subtitle: string): [category: string, year: string] {
  const at = subtitle.lastIndexOf("·");
  const last = (at < 0 ? subtitle : subtitle.slice(at + 1)).trim();
  if (!YEAR.test(last)) return [subtitle.trim(), ""];
  return [at < 0 ? "" : subtitle.slice(0, at).trim(), last];
}

/** What the overview says, as the project's fields — null when the page has no whole overview. A part not shown says nothing. */
export function overviewFields(doc: FigmaDocument): OverviewFields | null {
  const o = overviewOf(doc);
  if (!o) return null;
  const [category, year] = categoryAndYear(shown(o.subtitle) ? o.subtitle.characters : "");
  const described = shown(o.description) && said(o.description.characters);
  const picture = shown(o.cover) && shown(o.image) ? o.image.fills.find((p) => p.visible !== false && p.type === "image" && p.image?.url) : undefined;
  return {
    title: o.title.characters.trim(),
    titleEn: o.title.charactersEn?.trim() ?? "",
    category,
    year,
    description: described ? o.description.characters.trim() : "",
    descriptionEn: described ? o.description.charactersEn?.trim() ?? "" : "",
    coverImage: picture?.image?.url ?? "",
  };
}

