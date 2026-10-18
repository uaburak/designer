/**
 * Rename layers' rules (atlas 18 §4.1, Figma's auto-rename-layers): rectangles, texts, frames, groups and instances are
 * renamed when their name is still a default one — the type's base and a number ("Frame 12", "Rectangle 3 (2)";
 * "Frame" alone is not), a text whose name still follows its characters (`autoRename`), an instance still named as its
 * main (the instance alone, nothing inside it). Hidden layers, layers at opacity 0, locked layers (with what is in
 * them) and layers inside instances are skipped. Layers at the same place in other selected top-level frames — the
 * same names and same-named-sibling indices up to the frame — get the same name: one of them is asked about and the
 * name goes to all. "Rename anyway" lifts the default-name rule (nothing else). At most 500 layers are sent.
 */
import type { Layer } from "./layers";

/** Figma's cap on the layers in the selection's trees. */
export const RENAME_MAX_LAYERS = 500;

/** Each type's default-name bases (Figma's table). */
const BASES: Record<string, string[]> = {
  RECTANGLE: ["Rectangle", "Image"],
  TEXT: ["Text"],
  FRAME: ["Frame", "Group"],
  GROUP: ["Group"],
  POLYGON: ["Polygon", "Vector"],
  STAR: ["Star"],
  LINE: ["Line"],
  ELLIPSE: ["Ellipse"],
  VECTOR: ["Vector"],
  INSTANCE: ["Instance"],
};

const DEFAULT = Object.fromEntries(Object.entries(BASES).map(([type, bases]) => [type, new RegExp(`^(${bases.join("|")}) [()\\d]+[ ()\\d]*$`, "i")]));

/** Kinds Rename layers renames (components only from Create component, which we don't run). */
export function renamable(l: Layer): boolean {
  return l.type === "FRAME" || l.type === "GROUP" || l.type === "TEXT" || l.type === "INSTANCE" || l.type === "RECTANGLE";
}

/** The layer still has the name Figma gave it. */
export function hasDefaultName(l: Layer): boolean {
  if (l.type === "TEXT" && l.autoRename) return true;
  if (l.type === "INSTANCE" && l.mainName !== undefined && l.name === l.mainName) return true;
  return DEFAULT[l.type]?.test(l.name.trim()) ?? false;
}

/** The layers to rename under `roots` (pre-order). `anyway`: renamed layers too. */
export function renameCandidates(roots: readonly Layer[], anyway = false): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => {
    if (l.hidden || l.transparent || l.locked || l.inInstance) return;
    if (renamable(l) && (anyway || hasDefaultName(l))) out.push(l);
    if (l.type === "INSTANCE") return;
    l.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * Candidates grouped by their place in their top-level frame (`path`: names and same-named-sibling indices): each
 * group's first layer is asked about, the others take its name. Top-level frames themselves (and layers whose frame
 * isn't known) stay alone.
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
