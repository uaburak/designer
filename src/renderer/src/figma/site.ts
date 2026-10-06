import { HEADING_COMPONENT, isOverviewNode } from "./page";
import { BASE_LANGUAGE, PATH_SEP, findComponent, isFrameLike, propertiesOf, propsIn, resolveInstance, type FrameNode, type LangCode, type SceneNode, type ShapeNode } from "./model";

/**
 * What the site's page does with the Figma file's page frame, read from the
 * frame itself — nothing of it is set in the editor:
 *
 *  - its contents (the list beside the page): the sections' headings — of
 *    each layer of the page frame (a section), its first instance of the
 *    Heading component, under its title;
 *  - its scroll effects, as the older pages': texts come up line by line,
 *    everything else rises into place as it is scrolled to.
 */

const said = (s: unknown): s is string => typeof s === "string" && s.trim() !== "";

/** Is it the page's overview — the project's title, description and cover, the page frame's first layer (see overview.ts)? */
const isOverview = (node: SceneNode, index: number) => index === 0 && isOverviewNode(node);

/** Does it draw a surface of its own — a fill, a stroke, an effect? (A frame without one only holds its layers.) */
const hasSurface = (node: FrameNode | ShapeNode) =>
  node.fills.some((p) => p.visible !== false) || node.strokes.some((s) => s.visible !== false) || Boolean(node.effects?.some((e) => e.visible !== false));

export interface PageHeading {
  /** The heading's node (its element carries it as `data-node-id`) */
  id: string;
  label: string;
}

/** The page's headings: each section's first Heading instance's title, in the language shown — the project's own title (the overview's) apart. */
export function headingsOf(page: FrameNode, library: readonly SceneNode[], lang: LangCode = "tr"): PageHeading[] {
  const first = (node: SceneNode): PageHeading | null => {
    if (node.visible === false) return null;
    if (node.type === "instance") {
      const main = node.mainId ? findComponent(library, node.mainId) : null;
      if (node.mainId !== HEADING_COMPONENT || !main) return null;
      // Its own title (an emptied one is none, as on the page); the component's default only when it has none of its own.
      const own = node.props?.title;
      const words = lang === BASE_LANGUAGE ? undefined : propsIn(node, lang)?.title;
      const title = said(words) ? words : typeof own === "string" ? own : propertiesOf(library, main.id).find((p) => p.id === "title")?.value;
      return said(title) ? { id: node.id, label: title.trim() } : null;
    }
    if (!isFrameLike(node) || node.embed) return null;
    for (const child of node.children) {
      const found = first(child);
      if (found) return found;
    }
    return null;
  };
  return page.children.filter((c, i) => !isOverview(c, i)).map(first).filter((h): h is PageHeading => Boolean(h));
}

export interface RevealPlan {
  /** Texts that come up line by line (their elements' `data-node-id`) */
  lines: string[];
  /** What rises into place whole */
  blocks: string[];
}

/** An instance's texts, when it is nothing but texts on no surface (a heading, a paragraph) — null when it holds anything else. */
function textsOnly(resolved: FrameNode, instanceId: string): string[] | null {
  if (hasSurface(resolved) || resolved.embed) return null;
  const out: string[] = [];
  const visit = (list: SceneNode[], path: string): boolean =>
    list.every((child) => {
      if (child.visible === false) return true;
      const key = path ? `${path}${PATH_SEP}${child.name}` : child.name;
      if (child.type === "text") {
        out.push(`${instanceId}/${key}`);
        return true;
      }
      if (child.type === "frame" && !hasSurface(child) && !child.embed) return visit(child.children, key);
      return false;
    });
  return visit(resolved.children, "") && out.length ? out : null;
}

/** The overview's description (its element's `data-node-id`), when it shows one — the Overview component's part (see overview.ts). */
function overviewDescription(instance: FrameNode, library: readonly SceneNode[]): string[] {
  const resolved = resolveInstance(library, instance);
  const find = (list: SceneNode[], path: string): string | null => {
    for (const child of list) {
      if (child.visible === false) continue;
      const key = path ? `${path}${PATH_SEP}${child.name}` : child.name;
      if (child.fixed === "description") return key;
      const inner = child.type === "frame" ? find(child.children, key) : null;
      if (inner) return inner;
    }
    return null;
  };
  const key = resolved ? find(resolved.children, "") : null;
  return key ? [`${instance.id}/${key}`] : [];
}

/** How the page's layers come in as it is scrolled (see above). */
export function revealPlan(page: FrameNode, library: readonly SceneNode[]): RevealPlan {
  const plan: RevealPlan = { lines: [], blocks: [] };
  const visit = (node: SceneNode) => {
    if (node.visible === false) return;
    if (node.type === "text") {
      plan.lines.push(node.id);
      return;
    }
    if (!isFrameLike(node)) {
      // A shape — a hairline (a divider's) stays as it is.
      if (node.width > 1 && node.height > 1) plan.blocks.push(node.id);
      return;
    }
    if (node.type === "instance") {
      const resolved = resolveInstance(library, node);
      if (!resolved) return;
      // One whose prototype can change it (another variant, other words) rises whole: its texts' lines split apart would no longer be React's to change.
      const main = node.mainId ? findComponent(library, node.mainId) : null;
      const texts = main?.reactions?.length ? null : textsOnly(resolved, node.id);
      if (texts) plan.lines.push(...texts);
      else plan.blocks.push(node.id);
      return;
    }
    if (node.embed || hasSurface(node)) {
      plan.blocks.push(node.id);
      return;
    }
    node.children.forEach(visit);
  };
  page.children.forEach((child, i) => {
    // The overview is in sight as the page opens: only its description comes up, as the older pages'.
    if (!isOverview(child, i) || !isFrameLike(child)) visit(child);
    else if (child.type === "instance") plan.lines.push(...overviewDescription(child, library));
    else child.children.filter((c) => c.type === "text").forEach(visit);
  });
  return plan;
}
