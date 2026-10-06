import type { VariableValue } from "@/types/design";
import type { ProjectData } from "@/types/project";
import { TEMPLATE_OVERVIEW, startingLibrary } from "./library";
import { PATH_SEP, isFrameLike, libraryOf, makeInstance, walk, type FigmaDocument, type FrameNode, type Paint, type PropertyValues, type SceneNode } from "./model";

/**
 * The project's page in its Figma file: the top-level frame the site shows
 * (FigmaDocument.pageId), laid out as the site's page — 1440 wide, its
 * column in the middle — and the Overview it starts with (see overview.ts).
 */

/** The site's column: 720px between its 24px gutters. */
export const PAGE_COLUMN = 672;
/** The gutter a page keeps on a narrow screen. */
const PAGE_GUTTER = 24;
export const PAGE_WIDTH = 1440;
/** The page frame's first layer (the project's title, description and cover): no entry of its own in the contents. */
export const OVERVIEW_NAME = "Overview";
/** The component a section's heading is an instance of: what the contents list. */
export const HEADING_COMPONENT = "c-heading";
/** The Overview's main component (in the library): the page's first layer is an instance of it. */
export const OVERVIEW_COMPONENT = "c-overview";
/** Where its picture is, in it: the key an instance's picture is set by. */
export const OVERVIEW_IMAGE = `Cover${PATH_SEP}Image`;

const v = (value: string | number): VariableValue => ({ value });
const a = (alias: string): VariableValue => ({ alias });
const said = (s?: string | null): s is string => Boolean(s && s.trim());

/** A component (or frame) by id: the file's — the starting library's where the file has none. */
function componentIn(doc: FigmaDocument, id: string): FrameNode | undefined {
  let found: FrameNode | undefined;
  const look = (nodes: readonly SceneNode[]) =>
    walk(nodes, (n) => {
      if (!found && n.id === id && isFrameLike(n) && n.type !== "instance") found = n;
    });
  look(libraryOf(doc));
  if (!found) look(startingLibrary().nodes);
  return found;
}

/** What the overview says, part by part: a part not shown is none (no category and year, no description, no cover). */
export interface OverviewContent {
  title: string;
  titleEn?: string;
  /** "UX / UI Design · 2026" */
  subtitle: string;
  subtitleShown: boolean;
  description: string;
  descriptionEn?: string;
  descriptionShown: boolean;
  /** The cover's picture — the component's placeholder when unset */
  cover?: string;
  coverShown: boolean;
}

/**
 * What a part shows when the project has nothing for it: the template's
 * example — in sight on a new project's page, there to be filled in — or
 * nothing ("hidden").
 */
export type Missing = "sample" | "hidden";

/** The project's fields as the overview's content (see Missing). */
export function overviewContent(project: ProjectData, missing: Missing): OverviewContent {
  const sample = missing === "sample";
  const own = [project.category, project.year].filter(said).join(" · ");
  const example = [said(project.category) ? project.category : TEMPLATE_OVERVIEW.category, said(project.year) ? project.year : String(new Date().getFullYear())].join(" · ");
  return {
    title: project.title || project.slug,
    titleEn: project.titleEn,
    subtitle: sample ? example : own || example,
    subtitleShown: sample || Boolean(own),
    description: said(project.description) ? project.description : TEMPLATE_OVERVIEW.description,
    descriptionEn: said(project.description) ? project.descriptionEn : undefined,
    descriptionShown: sample || said(project.description),
    cover: said(project.coverImage) ? project.coverImage : undefined,
    coverShown: sample || said(project.coverImage),
  };
}

/** The page's overview for `doc`: an instance of the Overview component saying `content`, marked as the project's. */
export function overviewFor(doc: FigmaDocument, content: OverviewContent): FrameNode {
  const main = componentIn(doc, OVERVIEW_COMPONENT);
  const props: PropertyValues = {
    title: content.title,
    subtitle: content.subtitleShown,
    subtitleText: content.subtitle,
    description: content.descriptionShown,
    descriptionText: content.description,
    cover: content.coverShown,
  };
  const en = Object.fromEntries(
    Object.entries({ title: content.titleEn, descriptionText: content.descriptionShown ? content.descriptionEn : undefined }).filter((e): e is [string, string] => said(e[1]))
  );
  const base = main ? makeInstance(main, 0, 0) : ({ ...makeInstance({ id: OVERVIEW_COMPONENT, name: OVERVIEW_NAME, width: PAGE_COLUMN, height: 100 } as FrameNode, 0, 0) } as FrameNode);
  const picture: Paint[] = said(content.cover) ? [{ type: "image", color: a("bg-2"), image: { url: content.cover, fit: "fill" } }, { color: a("bg-2") }] : [];
  return {
    ...base,
    name: OVERVIEW_NAME,
    sizingH: main?.sizingH ?? "fill",
    sizingV: main?.sizingV ?? "hug",
    props,
    ...(Object.keys(en).length ? { propsEn: en } : {}),
    fixed: "overview",
    ...(picture.length ? { overrides: { [OVERVIEW_IMAGE]: { fills: picture } } } : {}),
  };
}

/** The file's page frame (the one the site shows), when it is there. */
export function pageFrameOf(doc: FigmaDocument): FrameNode | null {
  const page = doc.nodes.find((n) => n.id === doc.pageId);
  return page && isFrameLike(page) ? page : null;
}

/** Is it the page's overview — the page frame's first layer, marked as the project's? */
export const isOverviewNode = (node: SceneNode | undefined) => node?.fixed === "overview";

/** Put in the page's column: as wide as it, never wider than the column (nor its least width wider). */
export const inPageColumn = <T extends SceneNode>(node: T): T => ({
  ...node,
  maxWidth: Math.min(node.maxWidth ?? PAGE_COLUMN, PAGE_COLUMN),
  ...(node.minWidth !== undefined ? { minWidth: Math.min(node.minWidth, PAGE_COLUMN) } : {}),
});

/** The page frame (`base`: its id and its place on the canvas kept) laid out as the site's page, holding `children`. */
export function sitePageFrame(base: FrameNode, name: string, children: SceneNode[]): FrameNode {
  return {
    ...base,
    name: name || "Page",
    type: "frame",
    width: PAGE_WIDTH,
    height: 1024,
    rotation: undefined,
    sizingH: undefined,
    sizingV: "hug",
    layoutMode: "vertical",
    itemSpacing: v(0),
    // The site's page: 160px over its content (a narrow screen keeps 40 of them: see PageView), the room under it the site's own;
    // its column in the middle, a gutter beside it on a narrow screen.
    paddingTop: v(160),
    paddingRight: v(PAGE_GUTTER),
    paddingBottom: v(0),
    paddingLeft: v(PAGE_GUTTER),
    primaryAlign: "min",
    counterAlign: "center",
    minHeight: undefined,
    fills: [{ color: a("bg-1") }],
    strokes: [],
    clipsContent: false,
    children,
  };
}
