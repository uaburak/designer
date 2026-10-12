/**
 * Rename layers' rules (help.figma.com 24004711129879, docs/ai.md §1): only layers with default names are renamed —
 * frames ("Frame 12"), groups ("Group 3"), rectangles with an image fill ("Rectangle 5", "Image 2"), texts still named
 * by their text, and instances still named as their main (the instance alone, nothing inside it). Renamed, hidden and
 * locked layers are skipped (with what is in them), as are layers inside instances and plain vector shapes. Matching
 * layers across top-level frames — the same place in each — get the same name: one of them is asked about and the
 * name goes to all. "Rename anyway" lifts the default-name rule (nothing else).
 */
import type { Layer } from "./layers";

const DEFAULT: Record<string, RegExp> = {
  FRAME: /^Frame( \d+)?$/,
  GROUP: /^Group( \d+)?$/,
  RECTANGLE: /^(Rectangle|Image)( \d+)?$/,
};

/** Kinds Rename layers renames at all (a rectangle only with an image fill). */
export function renamable(l: Layer): boolean {
  if (l.type === "FRAME" || l.type === "GROUP" || l.type === "TEXT" || l.type === "INSTANCE") return true;
  return l.type === "RECTANGLE" && l.imageFill;
}

/** The layer still has the name Figma gave it. */
export function hasDefaultName(l: Layer): boolean {
  if (l.type === "TEXT") {
    // Named by its text: the whole text, or its start where a long text's name was cut.
    const text = (l.text ?? "").replace(/\s+/g, " ").trim();
    const name = l.name.replace(/\s+/g, " ").trim();
    return !!l.autoRename || name === text || name === "Text" || (name.length >= Math.min(text.length, 40) && name.length > 0 && text.startsWith(name.replace(/…$/, "")));
  }
  if (l.type === "INSTANCE") return l.mainName !== undefined && l.name === l.mainName;
  return DEFAULT[l.type]?.test(l.name.trim()) ?? false;
}

/** The layers to rename under `roots` (pre-order). `anyway`: renamed layers too. */
export function renameCandidates(roots: readonly Layer[], anyway = false): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => {
    if (l.hidden || l.locked || l.inInstance) return;
    if (renamable(l) && (anyway || hasDefaultName(l))) out.push(l);
    if (l.type === "INSTANCE") return;
    l.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * Candidates grouped by their place in their top-level frame: each group's first layer is asked about, the others
 * take its name. Top-level frames themselves (and layers whose frame isn't known) stay alone.
 */
export function matchGroups(candidates: readonly Layer[]): Layer[][] {
  const groups = new Map<string, Layer[]>();
  const out: Layer[][] = [];
  for (const l of candidates) {
    if (!l.top || !l.path) {
      out.push([l]);
      continue;
    }
    const key = `${l.path}|${l.type}`;
    const g = groups.get(key);
    // Two layers at the same place in the same frame can't happen; a second frame's layer joins.
    if (g && !g.some((x) => x.top === l.top)) g.push(l);
    else if (!g) {
      const fresh = [l];
      groups.set(key, fresh);
      out.push(fresh);
    } else out.push([l]);
  }
  return out;
}
