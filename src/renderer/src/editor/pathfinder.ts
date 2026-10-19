/**
 * Round 19b [ours]: Adobe Illustrator's six Pathfinders beside Figma's boolean groups (docs/roadmap.md Round 19; the
 * engine's PATHFINDER_* commands, engine/src/editor/PathfinderCommands.cpp). Destructive, as Illustrator's: the
 * selected shapes become ordinary vectors (grouped; Minus Back: one vector), one undo step named as Illustrator's
 * button, the result selected. Illustrator's names; their glyphs are ours, drawn in Figma's boolean-icon style
 * (ds/icons/svg/24/pathfinder.*.small.svg) — Adobe's own are not used.
 *
 * Pathfinder Options (Illustrator's dialog: Precision, Remove Redundant Points, "Divide and Outline will remove
 * unpainted artwork") are kept per machine, as Illustrator keeps them in its preferences.
 */
import type { IconName, MenuEntry, MenuItem } from "@/ds";
import type { CommandName } from "@/engine/abi";
import type { EditorController } from "./controller";
import { t } from "@/i18n";

export interface PathfinderOptions {
  /** How closely curves are followed, in px (Illustrator: 0.028 pt) */
  precision: number;
  removeRedundantPoints: boolean;
  /** Divide and Outline drop unfilled shapes first */
  removeUnpainted: boolean;
}

export const DEFAULT_PATHFINDER: PathfinderOptions = {
  precision: 0.028,
  removeRedundantPoints: true,
  removeUnpainted: false,
};
export const PATHFINDER_PRECISION = { min: 0.001, max: 100 } as const;

/** The six, in Illustrator's panel order (left to right). */
export const PATHFINDERS: readonly {
  id: string;
  label: string;
  name: CommandName;
  icon: IconName;
}[] = [
  {
    id: "vector.pathfinder-divide",
    label: "Divide",
    name: "PATHFINDER_DIVIDE",
    icon: "24.pathfinder.divide.small",
  },
  {
    id: "vector.pathfinder-trim",
    label: "Trim",
    name: "PATHFINDER_TRIM",
    icon: "24.pathfinder.trim.small",
  },
  {
    id: "vector.pathfinder-merge",
    label: "Merge",
    name: "PATHFINDER_MERGE",
    icon: "24.pathfinder.merge.small",
  },
  {
    id: "vector.pathfinder-crop",
    label: "Crop",
    name: "PATHFINDER_CROP",
    icon: "24.pathfinder.crop.small",
  },
  {
    id: "vector.pathfinder-outline",
    label: "Outline",
    name: "PATHFINDER_OUTLINE",
    icon: "24.pathfinder.outline.small",
  },
  {
    id: "vector.pathfinder-minus-back",
    label: "Minus Back",
    name: "PATHFINDER_MINUS_BACK",
    icon: "24.pathfinder.minus-back.small",
  },
];
export const PATHFINDER_OPTIONS_ID = "vector.pathfinder-options";
/** The command ids, then the options (the menus' "Pathfinder ›" submenu). */
export const PATHFINDER_MENU_IDS: readonly string[] = [...PATHFINDERS.map((p) => p.id), "-", PATHFINDER_OPTIONS_ID];

const KEY = "designer.pathfinder";

export function loadPathfinderOptions(): PathfinderOptions {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return DEFAULT_PATHFINDER;
    const v = JSON.parse(raw) as Partial<PathfinderOptions>;
    const precision = typeof v.precision === "number" && Number.isFinite(v.precision) ? clampPrecision(v.precision) : DEFAULT_PATHFINDER.precision;
    return {
      precision,
      removeRedundantPoints: typeof v.removeRedundantPoints === "boolean" ? v.removeRedundantPoints : DEFAULT_PATHFINDER.removeRedundantPoints,
      removeUnpainted: typeof v.removeUnpainted === "boolean" ? v.removeUnpainted : DEFAULT_PATHFINDER.removeUnpainted,
    };
  } catch {
    return DEFAULT_PATHFINDER;
  }
}

export const clampPrecision = (v: number) => Math.min(PATHFINDER_PRECISION.max, Math.max(PATHFINDER_PRECISION.min, v));

/** The options in effect: this session's (the window's), else what this machine kept. */
export function pathfinderOptions(ed: EditorController): PathfinderOptions {
  return ed.ui.get().pathfinder ?? loadPathfinderOptions();
}

export function setPathfinderOptions(ed: EditorController, next: PathfinderOptions): void {
  const o = { ...next, precision: clampPrecision(next.precision) };
  ed.ui.set({ pathfinder: o });
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // no storage (a test, a private window): this session only
  }
}

/** Runs one Pathfinder on the selection with the options in effect. */
export function runPathfinder(ed: EditorController, name: CommandName): number {
  const o = pathfinderOptions(ed);
  return ed.engine.command(name, {
    precision: o.precision,
    removeRedundantPoints: o.removeRedundantPoints,
    removeUnpainted: o.removeUnpainted,
  });
}

/** "Pathfinder ›": the six, a line, Pathfinder options… — for menus built from items (the boolean split menu). */
export function pathfinderSubmenu(item: (id: string) => MenuItem): MenuItem {
  const entries: MenuEntry[] = PATHFINDER_MENU_IDS.map((id) => (id === "-" ? "-" : item(id)));
  return {
    id: "pathfinder",
    label: t("Pathfinder"),
    icon: "24.pathfinder.divide.small",
    items: entries,
    disabled: entries.every((e) => e === "-" || (e as MenuItem).disabled),
  };
}
