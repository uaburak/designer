import { useRef } from "react";
import { keys } from "../util/keys";
import { rovingTarget } from "../util/rovingFocus";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import { Toolbar, ToolbarDivider, ToolButton } from "./Toolbar";
import styles from "./Toolbar.module.css";

/**
 * The editor's bottom toolbar as Figma's (measured on the owner's screenshots:
 * 530 × 48 — eight tool slots, a full-height line, the mode switch). This
 * file is the model the editor drives; the component only draws it.
 */
export type ToolId =
  | "move" | "hand" | "scale"
  | "frame" | "section" | "slice"
  | "rectangle" | "line" | "arrow" | "ellipse" | "polygon" | "star" | "image"
  | "pen" | "pencil"
  | "text" | "text-on-path"
  | "comment" | "annotation" | "measurement";

export type ToolGroupId = "move" | "region" | "shape" | "creation" | "text" | "comment";
export type EditorMode = "draw" | "design" | "motion" | "dev";

export type ToolDef = {
  id: ToolId;
  label: string;
  /** Display string (keys()), for the tooltip and the menu */
  shortcut?: string;
  icon: IconName;
};

/** Every tool, as Figma names it, with its keys. */
export const TOOLS: Record<ToolId, ToolDef> = {
  move: { id: "move", label: "Move", shortcut: "V", icon: "24.move" },
  hand: { id: "hand", label: "Hand tool", shortcut: "H", icon: "24.hand" },
  scale: { id: "scale", label: "Scale", shortcut: "K", icon: "24.scale" },
  frame: { id: "frame", label: "Frame", shortcut: "F", icon: "24.frame" },
  section: { id: "section", label: "Section", shortcut: keys(["shift", "s"]), icon: "24.section" },
  slice: { id: "slice", label: "Slice", shortcut: "S", icon: "24.slice" },
  rectangle: { id: "rectangle", label: "Rectangle", shortcut: "R", icon: "24.rectangle" },
  line: { id: "line", label: "Line", shortcut: "L", icon: "24.line" },
  arrow: { id: "arrow", label: "Arrow", shortcut: keys(["shift", "l"]), icon: "24.arrow" },
  ellipse: { id: "ellipse", label: "Ellipse", shortcut: "O", icon: "24.ellipse" },
  polygon: { id: "polygon", label: "Polygon", icon: "24.polygon" },
  star: { id: "star", label: "Star", icon: "24.star" },
  image: { id: "image", label: "Image/video…", shortcut: keys(["shift", "mod", "k"]), icon: "24.image" },
  pen: { id: "pen", label: "Pen", shortcut: "P", icon: "24.pen" },
  pencil: { id: "pencil", label: "Pencil", shortcut: keys(["shift", "p"]), icon: "24.pencil" },
  text: { id: "text", label: "Text", shortcut: "T", icon: "24.text" },
  "text-on-path": { id: "text-on-path", label: "Text on path", icon: "24.text-on-path" },
  comment: { id: "comment", label: "Comment", shortcut: "C", icon: "24.comment" },
  annotation: { id: "annotation", label: "Annotation", shortcut: "Y", icon: "24.annotation" },
  measurement: { id: "measurement", label: "Measurement", shortcut: keys(["shift", "m"]), icon: "24.measurement" },
};

/** `menuWidth`: the width of the group's menu in live (toolbar/*-tools-menu.txt; ours come out a fraction wider) */
export type ToolGroupDef = { id: ToolGroupId; label: string; tools: ToolId[]; menuWidth: number };

/** The toolbar's slots, left to right; each opens a menu of its tools (Figma: "Move tools", "Region tools"…). */
export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: "move", label: "Move tools", tools: ["move", "hand", "scale"], menuWidth: 151 },
  { id: "region", label: "Region tools", tools: ["frame", "section", "slice"], menuWidth: 150 },
  { id: "shape", label: "Shape tools", tools: ["rectangle", "line", "arrow", "ellipse", "polygon", "star", "image"], menuWidth: 196 },
  { id: "creation", label: "Creation tools", tools: ["pen", "pencil"], menuWidth: 142 },
  { id: "text", label: "Type tools", tools: ["text", "text-on-path"], menuWidth: 142 },
  { id: "comment", label: "Comment tools", tools: ["comment", "annotation", "measurement"], menuWidth: 186 },
];

/** The group a tool belongs to. */
export const groupOf = (tool: ToolId): ToolGroupId => TOOL_GROUPS.find((g) => g.tools.includes(tool))!.id;

/** The tool a key chooses (single keys and ⇧ combinations, outside text fields), or null — for the editor's keymap. */
export function toolForKey(e: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): ToolId | null {
  if (e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.metaKey || e.ctrlKey) return e.shiftKey && k === "k" ? "image" : null;
  if (e.shiftKey) return ({ s: "section", l: "arrow", p: "pencil", t: "annotation", m: "measurement" } as Record<string, ToolId>)[k] ?? null;
  return ({ v: "move", h: "hand", k: "scale", f: "frame", s: "slice", r: "rectangle", l: "line", o: "ellipse", p: "pen", t: "text", c: "comment", y: "annotation" } as Record<string, ToolId>)[k] ?? null;
}

export type EditorModeDef = { id: EditorMode; label: string; icon: IconName; shortcut?: string };

/** The mode switch, left to right (the owner's screenshots; Figma's Draw, Design, Motion, Dev Mode). */
export const EDITOR_MODES: EditorModeDef[] = [
  { id: "draw", label: "Draw", icon: "24.draw" },
  { id: "design", label: "Design", icon: "24.design" },
  { id: "motion", label: "Motion", icon: "24.motion" },
  { id: "dev", label: "Dev Mode", icon: "24.dev-brackets", shortcut: keys(["shift", "d"]) },
];

export interface EditorToolbarProps {
  /** The current tool (its slot is blue) */
  tool: ToolId;
  /** The tool each slot shows (the last one chosen in it); default its first */
  groupTools?: Partial<Record<ToolGroupId, ToolId>>;
  /** A slot clicked or a tool picked from a slot's menu (the editor keeps `groupTools`) */
  onTool: (tool: ToolId) => void;
  /** Actions (⌘K) */
  onActions?: () => void;
  actionsActive?: boolean;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  /** Modes this file can't use (shown, disabled) */
  disabledModes?: EditorMode[];
  /** Tools not available yet (shown dimmed, not clickable, tooltip kept; also greyed in the slot menus) */
  disabledTools?: ToolId[];
  /** Absolutely placed, 12px over its container's bottom; `offset` centres it on the window rather than the canvas */
  floating?: boolean;
  offset?: number;
  /** Shortcuts the user changed (the tool's, or "actions"): shown instead of Figma's; null: the tool has none now */
  shortcuts?: Partial<Record<ToolId | "actions", string | null>>;
}

/**
 * Figma's bottom toolbar (presentational): Move ▾, Region ▾, Shape ▾,
 * Creation ▾, Text ▾, Comment ▾, Actions | Draw · Design · Motion · Dev Mode.
 * A slot shows the last tool chosen in it; its chevron opens the group
 * (the current tool ticked) above the toolbar. ← → move within the mode
 * switch. The keys themselves are the editor's (see `toolForKey`).
 */
export function EditorToolbar({ tool, groupTools, onTool, onActions, actionsActive, mode, onMode, disabledModes = [], disabledTools = [], floating, offset, shortcuts }: EditorToolbarProps) {
  const shortcutOf = (id: ToolId | "actions", own: string | undefined) => (shortcuts && id in shortcuts ? (shortcuts[id] ?? undefined) : own);
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = groupOf(tool);
  return (
    <Toolbar floating={floating} offset={offset} data-ds="EditorToolbar">
      {TOOL_GROUPS.map((g) => {
        const shown = TOOLS[g.id === current ? tool : groupTools?.[g.id] ?? g.tools[0]];
        return (
          <ToolButton
            key={g.id}
            icon={shown.icon}
            label={shown.label}
            shortcut={shortcutOf(shown.id, shown.shortcut)}
            active={g.id === current}
            onSelect={() => onTool(shown.id)}
            disabled={disabledTools.includes(shown.id)}
            menuDisabled={g.tools.every((id) => disabledTools.includes(id))}
            menuLabel={g.label}
            menuWidth={g.menuWidth}
            // Live (toolbar/*-tools-menu.txt): the slot's own tool is the lit row, whichever tool is active
            menu={g.tools.map((id) => ({ id, label: TOOLS[id].label, shortcut: shortcutOf(id, TOOLS[id].shortcut), icon: TOOLS[id].icon, checked: id === shown.id, radio: true, disabled: disabledTools.includes(id) }))}
            onMenuSelect={(id) => !disabledTools.includes(id as ToolId) && onTool(id as ToolId)}
          />
        );
      })}
      <ToolButton icon="24.actions" label="Actions" shortcut={shortcutOf("actions", keys(["mod", "k"]))} active={Boolean(actionsActive)} onSelect={() => onActions?.()} />
      <ToolbarDivider />
      <div role="radiogroup" aria-label="Mode" className={styles.modes} data-ds="ModeSwitch">
        {EDITOR_MODES.map((m, i) => {
          const enabled = (k: number) => !disabledModes.includes(EDITOR_MODES[k].id);
          return (
            <button
              key={m.id}
              ref={(el) => {
                modeRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={m.id === mode}
              aria-label={m.label}
              aria-disabled={!enabled(i) || undefined}
              tabIndex={m.id === mode ? 0 : -1}
              className={styles.mode}
              onClick={() => enabled(i) && onMode(m.id)}
              onKeyDown={(e) => {
                const next = rovingTarget(e.key, EDITOR_MODES.length, enabled, i, "horizontal");
                if (next === null || next < 0) return;
                e.preventDefault();
                modeRefs.current[next]?.focus();
                onMode(EDITOR_MODES[next].id);
              }}
              {...tooltipProps(m.label, m.shortcut, "top")}
            >
              <Icon name={m.icon} />
            </button>
          );
        })}
      </div>
    </Toolbar>
  );
}
