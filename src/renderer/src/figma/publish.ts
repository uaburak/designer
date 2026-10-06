import type { DesignVariable, TextStyle } from "@/types/design";
import type { ProjectFields, PublishedPage } from "@/types/project";
import { COMPONENTS_PAGE_ID, COMPONENTS_PAGE_NAME } from "./library";
import { pageFrameOf } from "./page";
import { findNode, isFrameLike, libraryOf, walk, type FigmaDocument, type FrameNode, type NodeOverride, type Paint, type SceneNode } from "./model";

/**
 * What the site gets of a project when it is published: its page frame and
 * nothing else of its file — the components the page uses (and the ones
 * they use, all the way down; a variant's whole set, its prototype may show
 * any of them), the design system as it is now. Frozen: editing the library
 * or the variables later changes the site only when it is published again.
 */

/** The top-level node (a component, or the set holding it) of component `id`. */
function holderOf(library: readonly SceneNode[], id: string): SceneNode | null {
  const found = findNode(library, id);
  if (!found) return null;
  const parent = found.parent;
  return parent?.type === "componentSet" ? parent : found.node;
}

/** The components `nodes` draw — their instances', their instance swaps' — each one's holder once, in the library's order. */
export function usedComponents(nodes: readonly SceneNode[], library: readonly SceneNode[]): SceneNode[] {
  const holders = new Map<string, SceneNode>();
  const visit = (list: readonly SceneNode[]) => {
    walk(list, (n) => {
      if (n.type !== "instance") return;
      // Its component, and what its instance swaps (its own values, its component's defaults) may show instead.
      const ids = [n.mainId, ...Object.values(n.props ?? {})].filter((v): v is string => typeof v === "string");
      for (const id of ids) {
        const holder = holderOf(library, id);
        if (!holder || holders.has(holder.id)) continue;
        holders.set(holder.id, holder);
        visit([holder]);
        // Its properties' defaults: an instance swap's default component.
        const props = isFrameLike(holder) ? holder.properties ?? [] : [];
        for (const p of props) if (p.type === "instanceSwap" && typeof p.value === "string") visit([{ ...(holder as FrameNode), id: `${holder.id}-swap`, type: "instance", mainId: p.value, children: [] }]);
      }
    });
  };
  visit(nodes);
  return library.filter((n) => holders.has(n.id));
}

/** The pictures a page shows (its fills', its overrides', its embeds'), each once, the cover first. */
export function picturesOf(nodes: readonly SceneNode[], cover?: string): string[] {
  const out = new Set<string>(cover ? [cover] : []);
  const paints = (list: readonly Paint[] | undefined) => list?.forEach((p) => p.type === "image" && p.image?.url && p.visible !== false && out.add(p.image.url));
  const overrides = (map: Record<string, NodeOverride> | undefined) =>
    Object.values(map ?? {}).forEach((o) => {
      paints(o.fills);
      overrides(o.overrides);
    });
  walk(nodes, (n) => {
    if (n.visible === false) return;
    paints(n.fills);
    if (!isFrameLike(n)) return;
    overrides(n.overrides);
    const e = n.embed;
    if (!e) return;
    if (e.kind === "image" && e.src) out.add(e.src);
    if (e.figmaCover) out.add(e.figmaCover);
    if (e.iframeCover) out.add(e.iframeCover);
    e.entries?.forEach((x) => x.src && out.add(x.src));
  });
  return [...out];
}

/** The Overview's cover without words of its own says the project's title (its picture's alt text). */
function withCoverAlt(page: FrameNode, fields: ProjectFields): FrameNode {
  const first = page.children[0];
  const key = `Cover${"›"}Image`;
  const fills = first?.type === "instance" ? first.overrides?.[key]?.fills : undefined;
  if (!first || first.type !== "instance" || !fills?.some((p) => p.type === "image" && !p.image?.alt)) return page;
  const titled = fills.map((p) => (p.type === "image" && p.image && !p.image.alt ? { ...p, image: { ...p.image, alt: fields.title, altEn: p.image.altEn ?? fields.titleEn } } : p));
  const overview: FrameNode = { ...first, overrides: { ...first.overrides, [key]: { ...first.overrides![key], fills: titled } } };
  return { ...page, children: [overview, ...page.children.slice(1)] };
}

/** How many of its pictures a project's summary keeps (the home page's flying images). */
const SUMMARY_PICTURES = 12;

/**
 * The published page of the editor's file (the project's, the library in
 * it): its page frame, the components it uses on a Components page of
 * their own, its languages — with the design system's variables and text
 * styles (the starting ones in them) and the project's summary.
 */
export function publishedPage(file: FigmaDocument, fields: ProjectFields, order: number, variables: DesignVariable[], textStyles: TextStyle[]): PublishedPage {
  const page = pageFrameOf(file);
  if (!page) throw new Error("The file has no page frame to publish");
  const library = libraryOf(file);
  const components = usedComponents([page], library);
  const titled = withCoverAlt(page, fields);
  const doc: FigmaDocument = {
    version: 1,
    nodes: [titled],
    pageId: page.id,
    ...(file.languages ? { languages: file.languages } : {}),
    pages: [{ id: COMPONENTS_PAGE_ID, name: COMPONENTS_PAGE_NAME, nodes: components }],
  };
  // Without what is unset (a published file is read as it was written).
  const clean = JSON.parse(JSON.stringify(doc)) as FigmaDocument;
  return {
    summary: { ...fields, order, images: picturesOf([page, ...components], fields.coverImage).slice(0, SUMMARY_PICTURES), publishedAt: null },
    doc: clean,
    variables,
    textStyles,
  };
}
