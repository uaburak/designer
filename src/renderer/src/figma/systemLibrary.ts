import type { DesignVariable, TextStyle, VariableValue } from "@/types/design";
import type { DeletedComponent, StoredLibrary } from "@/lib/firestore";
import { resolvedValue } from "@/components/project/designVariables";
import { COMPONENTS_PAGE_ID, COMPONENTS_PAGE_NAME, LIBRARY_VERSION, idsIn, isStarting, signature, startingLibrary, withFreeIds } from "./library";
import { cloneNode, isFrameLike, libraryOf, resolveInstance, walk, type EffectStyle, type FigmaDocument, type FrameNode, type SceneNode, type TextNode } from "./model";

/**
 * The site's library — every project's components (Figma's published
 * library): one set of main components, kept on its own (design/library),
 * that every project's instances are of. The editor shows it as the file's
 * Components page (hidden from the pages: a component is edited on its own
 * from Assets) — the file it edits is the project's own file with the
 * library put in (withLibrary), split back when it is saved (splitLibrary).
 *
 * What is deleted from the design system — a component, a variable, a text
 * style — is kept as it was (a tombstone): the projects not open then still
 * use it, and when one is opened its uses become its own (detached):
 * instances frames, bound values the values they had (see detachDeleted).
 */

/** How many deleted things are kept for the projects still using them. */
const TOMBSTONES_KEPT = 100;

/** The library the starting one seeds: the starting components, each one's signature kept (an unchanged one may be upgraded). */
function seededLibrary(): StoredLibrary {
  const nodes = startingLibrary().nodes;
  return { nodes, effectStyles: [], version: LIBRARY_VERSION, seeded: Object.fromEntries(nodes.map((n) => [n.id, signature(n)])), deleted: [] };
}

/**
 * The library as the editor opens it: the stored one, brought up to the
 * current starting library — each starting component still as it was
 * seeded replaced by its current shape (at its place), one the user edited
 * kept, one added since put in (unless the user deleted it) — or, never
 * saved, the starting one. Nothing to save when it is already current.
 */
export function currentLibrary(stored: StoredLibrary | null): StoredLibrary {
  if (!stored) return seededLibrary();
  const library: StoredLibrary = { nodes: stored.nodes ?? [], effectStyles: stored.effectStyles ?? [], version: stored.version ?? 0, seeded: stored.seeded ?? {}, deleted: stored.deleted ?? [] };
  if (library.version >= LIBRARY_VERSION) return library;
  const fresh = startingLibrary().nodes;
  const gone = new Set(library.deleted.map((d) => d.id));
  const seeded = { ...library.seeded };
  const taken = idsIn(library.nodes.filter((n) => !isStarting(n)));
  const nodes = library.nodes.map((n) => {
    const f = fresh.find((x) => x.id === n.id);
    if (!f || signature(n) !== library.seeded[n.id] || signature(n) === signature(f)) return n;
    seeded[f.id] = signature(f);
    return withFreeIds({ ...f, x: n.x, y: n.y }, taken);
  });
  for (const f of fresh) {
    if (nodes.some((n) => n.id === f.id) || gone.has(f.id) || library.seeded[f.id]) continue;
    seeded[f.id] = signature(f);
    nodes.push(withFreeIds(f, taken));
  }
  return { ...library, nodes, seeded, version: LIBRARY_VERSION };
}

// ── The editor's file: the project's own, the library in it ───────────────────

/** The project's own file with the site's library as its Components page, and the library's effect styles. */
export function withLibrary(project: FigmaDocument, library: Pick<StoredLibrary, "nodes" | "effectStyles">): FigmaDocument {
  const pages = (project.pages ?? []).filter((p) => p.id !== COMPONENTS_PAGE_ID);
  return { ...project, pages: [...pages, { id: COMPONENTS_PAGE_ID, name: COMPONENTS_PAGE_NAME, nodes: library.nodes }], effectStyles: library.effectStyles };
}

/** The library's page of the editor's file: its components. */
export const libraryNodes = (file: FigmaDocument): SceneNode[] => file.pages?.find((p) => p.id === COMPONENTS_PAGE_ID)?.nodes ?? [];

/** The editor's file split back: the project's own file — without the library, nor the page left open — and the library's part. */
export function splitLibrary(file: FigmaDocument): { project: FigmaDocument; nodes: SceneNode[]; effectStyles: EffectStyle[] } {
  const pages = (file.pages ?? []).filter((p) => p.id !== COMPONENTS_PAGE_ID);
  const { effectStyles, currentPage, libraryVersion, fromLegacy, ...rest } = file;
  void currentPage; void libraryVersion; void fromLegacy;
  return { project: { ...rest, pages: pages.length ? pages : undefined }, nodes: libraryNodes(file), effectStyles: effectStyles ?? [] };
}

/** The project's part of the editor's file changed (its pages, its languages…) — by reference, as the editor changes it. */
export function projectChanged(before: FigmaDocument, after: FigmaDocument): boolean {
  const own = (d: FigmaDocument) => (d.pages ?? []).filter((p) => p.id !== COMPONENTS_PAGE_ID);
  const a = own(before);
  const b = own(after);
  return (
    before.nodes !== after.nodes ||
    before.pageId !== after.pageId ||
    before.background !== after.background ||
    before.pageName !== after.pageName ||
    before.languages !== after.languages ||
    a.length !== b.length ||
    a.some((p, i) => p !== b[i])
  );
}

/** The library's part of the editor's file changed. */
export const libraryChanged = (before: FigmaDocument, after: FigmaDocument) => libraryNodes(before) !== libraryNodes(after) || before.effectStyles !== after.effectStyles;

// ── Detached: what is deleted becomes the project's own ───────────────────────

/** An instance as a frame of its own: what it draws, its layers its own (fresh ids), its place and id kept — null when its component is nowhere. */
export function detachedFrame(library: readonly SceneNode[], instance: FrameNode): FrameNode | null {
  const resolved = resolveInstance(library, instance);
  if (!resolved) return null;
  const frame = cloneNode({ ...resolved, type: "frame", mainId: undefined, overrides: undefined, props: undefined, propsEn: undefined, propsI18n: undefined } as FrameNode);
  frame.id = instance.id;
  return frame;
}

/** `nodes` with each node through `fix` (its children first, when it keeps them) — the same arrays and objects where nothing changed. */
export function mapNodes(nodes: SceneNode[], fix: (node: SceneNode) => SceneNode): SceneNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    let m = fix(n);
    if (isFrameLike(m)) {
      const children = mapNodes(m.children, fix);
      if (children !== m.children) m = { ...m, children };
    }
    if (m !== n) changed = true;
    return m;
  });
  return changed ? next : nodes;
}

/** `nodes` with every instance of a component in `ids` detached (found in `library`, the deleted ones' tombstones in it). */
export function withDetached(nodes: SceneNode[], ids: ReadonlySet<string>, library: readonly SceneNode[]): SceneNode[] {
  if (!ids.size) return nodes;
  // What a detached instance drew may hold instances of the deleted too: mapNodes goes on into its children.
  return mapNodes(nodes, (n) => (n.type === "instance" && n.mainId && ids.has(n.mainId) ? detachedFrame(library, n) ?? n : n));
}

/** Every component id a node holds (its variants', in a set). */
export function componentIds(node: SceneNode): string[] {
  const ids: string[] = [];
  walk([node], (n) => {
    if (n.type === "component") ids.push(n.id);
  });
  return ids;
}

/** How many instances of `ids` are in `nodes` (an instance inside a main component too). */
export function instancesOf(nodes: readonly SceneNode[], ids: ReadonlySet<string>): number {
  let count = 0;
  walk(nodes, (n) => {
    if (n.type === "instance" && n.mainId && ids.has(n.mainId)) count++;
  });
  return count;
}

/** Tombstones, the newest kept (and one of an id once). */
export function keptTombstones<T extends { id: string }>(list: readonly T[], added: readonly T[]): T[] {
  const ids = new Set(added.map((t) => t.id));
  return [...list.filter((t) => !ids.has(t.id)), ...added].slice(-TOMBSTONES_KEPT);
}

/**
 * A value bound to a deleted variable as the value it had (its light
 * theme's, through its aliases) — as if it had been set by hand. Every
 * `{ alias }` in `value` (a node, a list of them, a text style, a
 * variable) naming one of `gone` is replaced; the rest is the same object.
 */
export function withoutVariables<T>(value: T, gone: ReadonlyMap<string, VariableValue>): T {
  if (!gone.size) return value;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map((x) => {
        const y = visit(x);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? next : v;
    }
    if (!v || typeof v !== "object") return v;
    const obj = v as Record<string, unknown>;
    if (typeof obj.alias === "string" && Object.keys(obj).length === 1) return gone.get(obj.alias) ?? v;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(obj)) {
      const y = visit(x);
      if (y !== x) changed = true;
      next[k] = y;
    }
    return changed ? next : v;
  };
  return visit(value) as T;
}

const FALLBACK: Record<DesignVariable["kind"], string | number> = { color: "#000000", number: 0, weight: 400 };

/** The values deleted variables had (their light theme's): what their uses keep. */
export function frozenValues(gone: readonly DesignVariable[], all: readonly DesignVariable[]): Map<string, VariableValue> {
  const byId = new Map([...all, ...gone].map((v) => [v.id, v]));
  return new Map(gone.map((v) => [v.id, { value: resolvedValue(v, "light", byId) ?? FALLBACK[v.kind] }]));
}

/** A text in a deleted text style: the style's typography and colour as its own. */
export function withoutTextStyles(nodes: SceneNode[], gone: ReadonlyMap<string, TextStyle>): SceneNode[] {
  if (!gone.size) return nodes;
  return mapNodes(nodes, (n) => {
    if (n.type !== "text" || !n.textStyle || !gone.has(n.textStyle)) return n;
    const st = gone.get(n.textStyle)!;
    const own: TextNode = { ...n, textStyle: undefined, fontSize: st.fontSize, fontWeight: st.fontWeight, lineHeight: st.lineHeight, letterSpacing: st.letterSpacing };
    return { ...own, fills: n.fills.length ? n.fills : [{ color: st.color }] };
  });
}

/**
 * A project's file as it is opened: what was deleted from the design system
 * since it was last saved made its own — instances of deleted components
 * detached, values bound to deleted variables and texts in deleted text
 * styles keeping what they had. The same file when nothing is.
 */
export function detachDeleted(
  project: FigmaDocument,
  library: StoredLibrary,
  deletedVariables: readonly DesignVariable[],
  variables: readonly DesignVariable[],
  deletedTextStyles: readonly TextStyle[]
): FigmaDocument {
  const present = new Set<string>();
  walk(library.nodes, (n) => present.add(n.id));
  const deadComponents = library.deleted.filter((d) => !present.has(d.id));
  const used = new Set<string>();
  walk(libraryOf(project), (n) => {
    if (n.type === "instance" && n.mainId) used.add(n.mainId);
  });
  const ids = new Set(deadComponents.flatMap((d) => componentIds(d.node)).filter((id) => used.has(id) && !present.has(id)));
  const lookIn = [...library.nodes, ...deadComponents.map((d) => d.node)];
  const pages = (nodes: SceneNode[]) => {
    let next = withDetached(nodes, ids, [...nodes, ...lookIn]);
    next = withoutTextStyles(next, new Map(deletedTextStyles.map((s) => [s.id, s])));
    return withoutVariables(next, frozenValues(deletedVariables.filter((v) => !variables.some((x) => x.id === v.id)), variables));
  };
  const nodes = pages(project.nodes);
  const other = project.pages?.map((p) => {
    const n = pages(p.nodes);
    return n === p.nodes ? p : { ...p, nodes: n };
  });
  if (nodes === project.nodes && (other ?? []).every((p, i) => p === project.pages![i])) return project;
  return { ...project, nodes, pages: other };
}

/** A deleted component's tombstone. */
export const tombstoneOf = (node: SceneNode): DeletedComponent => ({ id: node.id, node });
