/**
 * The bottom toolbar (DS EditorToolbar, Figma UI3): 48 high, 12 over the
 * bottom, centred on the window (live: 529 wide at x 456 in a 1440 window).
 * Its place is CSS alone on the editor's full-window box (EditorApp's
 * `Overlays`, not the view between the panels): nothing about the panels or
 * the canvas moves it, so a panel drag neither moves nor re-renders it. A slot shows the last
 * tool chosen in it; tools the engine doesn't implement yet are disabled.
 * The mode switch stays on Design (the others come later). In vector edit
 * mode Figma's secondary toolbar opens 8 over it (live toolbar/vector-edit-toolbar.txt): Move, Lasso │ Paint, Bend,
 * Cut, Erase │ More ▾ (Vector editing tools: Shape builder, Variable width) │ Close.
 */
import { useMemo, useRef, useState } from "react";
import { ContextMenu, EditorToolbar, groupOf, IconButton, showToast, Toolbar, ToolbarDivider, ToolTextButton, type IconName, type MenuEntry, type ToolGroupId, type ToolId } from "@/ds";
import type { ToolName } from "@/engine/abi";
import { useTool } from "@/engine/hooks";
import { useEditor } from "../controller";
import { COMMAND_BY_ID, comboText, runEditorCommand } from "../commands";
import { isCustom } from "../shortcuts/keymap";
import { useShortcutSettings } from "../shortcuts/prefs";
import { useUI } from "../hooks";
import { useStoreSlice } from "../uiStore";
import { setMode } from "../devmode/devMode";
import type { VectorTool } from "../vectorEdit";

/** The toolbar's tools → the engine's (null: a tool the engine has no id for). */
export const ENGINE_TOOL: Record<ToolId, ToolName | null> = {
  move: "MOVE",
  hand: "HAND",
  scale: "SCALE",
  frame: "FRAME",
  section: "SECTION",
  slice: "SLICE",
  rectangle: "RECTANGLE",
  line: "LINE",
  arrow: "ARROW",
  ellipse: "ELLIPSE",
  polygon: "POLYGON",
  star: "STAR",
  image: "IMAGE",
  pen: "PEN",
  pencil: "PENCIL",
  text: "TEXT",
  "text-on-path": null,
  comment: "COMMENT",
  annotation: "ANNOTATION",
  measurement: "MEASUREMENT",
};

/** Dev Mode's tools (help.figma.com: ⇧T Annotate, ⇧M Measure, C Comment; Move and Hand to look around). */
const DEV_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["move", "hand", "comment", "annotation", "measurement"]);

/** The toolbar's tool for the engine's current one. */
export function toolIdOf(engineTool: string): ToolId {
  for (const [id, name] of Object.entries(ENGINE_TOOL)) if (name === engineTool) return id as ToolId;
  return "move";
}

/** Does the engine implement the toolbar's tool? (The Image tool is the editor's: a file picker, then clicks.) */
const isAvailable = (ed: ReturnType<typeof useEditor>, t: ToolId) => {
  if (t === "image") return !!ed.images.store;
  const name = ENGINE_TOOL[t];
  return !!name && ed.tools.has(name);
};

export function BottomToolbar() {
  const ed = useEditor();
  const vectorEditing = useStoreSlice(ed.vector.state, (s) => s.active);
  const placing = useUI((s) => !!s.placingImages?.length);
  const engineTool = toolIdOf(useTool(ed.store));
  // While images wait to be placed, the Image tool is the one in use (Figma).
  const tool = placing ? "image" : engineTool;
  const actionsOpen = useUI((s) => !!s.actionsOpen);
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  // A tool chosen by key is remembered in its slot too.
  if (groups[groupOf(tool)] !== tool) setGroups({ ...groups, [groupOf(tool)]: tool });
  const dev = useUI((s) => s.mode === "dev");
  const draw = useUI((s) => s.mode === "draw");
  // The tools' keys the user changed (the Keyboard shortcuts panel); the others keep the toolbar's own wording.
  const bindings = useShortcutSettings().bindings;
  const shortcuts = useMemo(() => {
    const out: Partial<Record<ToolId | "actions", string | null>> = {};
    for (const t of [...(Object.keys(ENGINE_TOOL) as ToolId[]), "actions" as const]) {
      const id = t === "actions" ? "tool.actions" : `tool.${t}`;
      if (!isCustom(id, bindings)) continue;
      const first = COMMAND_BY_ID.get(id)?.keys?.[0];
      out[t] = first ? comboText(first) : null;
    }
    return out;
  }, [bindings]);
  const disabledTools = useMemo(() => (Object.keys(ENGINE_TOOL) as ToolId[]).filter((t) => !isAvailable(ed, t) || (dev && !DEV_TOOLS.has(t))), [ed, dev]);
  const pick = (t: ToolId) => {
    if (t === "image") {
      setGroups((g) => ({ ...g, shape: "image" }));
      runEditorCommand(ed, "tool.image");
      return;
    }
    const name = ENGINE_TOOL[t];
    if (!name || !ed.tools.has(name) || (dev && !DEV_TOOLS.has(t))) return;
    ed.setTool(name);
    setGroups((g) => ({ ...g, [groupOf(t)]: t }));
    ed.focusCanvas();
  };
  return (
    <>
      {vectorEditing && <VectorEditToolbar />}
      <EditorToolbar
      floating
      tool={tool}
      groupTools={groups}
      disabledTools={disabledTools}
      onTool={pick}
      onActions={() => runEditorCommand(ed, "tool.actions")}
      actionsActive={actionsOpen}
      mode={dev ? "dev" : draw ? "draw" : "design"}
      onMode={(m) => {
        if (m === "dev" || m === "design") setMode(ed, m);
        else if (m === "draw") runEditorCommand(ed, "view.switch-to-draw");
        else showToast({ message: "Motion comes later" });
      }}
      disabledModes={["motion"]}
      shortcuts={shortcuts}
      />
    </>
  );
}

/** Live (toolbar/vector-edit-toolbar.txt): Move, Lasso │ Paint, Bend, Cut, Erase — glyph and name. */
const VECTOR_TOOL_GROUPS: { id: VectorTool; label: string; icon: IconName }[][] = [
  [
    { id: "MOVE", label: "Move", icon: "24.move" },
    { id: "LASSO", label: "Lasso", icon: "24.lasso" },
  ],
  [
    { id: "PAINT_BUCKET", label: "Paint", icon: "24.paint-bucket" },
    { id: "BEND", label: "Bend", icon: "24.bend" },
    { id: "CUT", label: "Cut", icon: "24.cut" },
    { id: "ERASE", label: "Erase", icon: "24.erase" },
  ],
];

/**
 * The text buttons' widths in live's vector edit toolbar (toolbar/vector-edit-toolbar.txt: Move 60, Lasso 62, Paint 58,
 * Bend 59, Cut 50, Erase 61, More 55; 529 × 40 at 455, 792). Ours are 0.2-0.9 wider each (the text's own advance), 2 px
 * over the whole. The fractions are inferred (unverified): the least ones that keep every rounded place of live's dump
 * (Lasso 76, the line 147, Paint 156, Bend 222, Cut 289, Erase 347, the line 416, More 425, the line 488, Close 497).
 */
const VECTOR_TOOL_WIDTH: Record<string, number> = { Move: 60.3, Lasso: 62.4, Paint: 58, Bend: 59, Cut: 50, Erase: 61.1, More: 55.4 };

/**
 * More ▾ (live toolbar/vector-edit-more-menu.txt: "Vector editing tools", Shape builder M, Variable width ⇧W; round
 * 12: built — the engine's SHAPE_BUILDER and VARIABLE_WIDTH). A radio menu: the active one is checked (and lit; with
 * neither active the first row is lit, as live opens it). Variable width is disabled where Figma doesn't offer it
 * (dashed or dynamic strokes, branching paths).
 */
export function vectorMoreTools(tool: VectorTool, variableWidth: boolean): MenuEntry[] {
  return [
    { id: "SHAPE_BUILDER", label: "Shape builder", icon: "24.shape-builder", shortcut: "M", checked: tool === "SHAPE_BUILDER", radio: true },
    { id: "VARIABLE_WIDTH", label: "Variable width", icon: "24.variable-width", shortcut: "⇧W", checked: tool === "VARIABLE_WIDTH", radio: true, disabled: !variableWidth },
  ];
}

/** Figma UI3's vector edit toolbar: 529 × 40, 8 over the bottom toolbar (live 455, 792 at 1440 × 900). */
function VectorEditToolbar() {
  const ed = useEditor();
  const tool = useStoreSlice(ed.vector.state, (s) => s.tool);
  const variableWidth = useStoreSlice(ed.vector.state, (s) => s.variableWidth);
  const more = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const pick = (t: VectorTool) => {
    ed.vector.setTool(t);
    ed.focusCanvas();
  };
  return (
    <Toolbar floating secondary label="Vector edit tools" data-vector-toolbar="">
      {VECTOR_TOOL_GROUPS.map((group, g) => (
        <div key={g} style={{ display: "contents" }}>
          {g > 0 && <ToolbarDivider />}
          {group.map((t) => (
            <ToolTextButton key={t.id} icon={t.icon} label={t.label} active={t.id === tool} disabled={!ed.vector.hasTool(t.id)} width={VECTOR_TOOL_WIDTH[t.label]} onSelect={() => pick(t.id)} />
          ))}
        </div>
      ))}
      <ToolbarDivider />
      <div ref={more} style={{ display: "contents" }}>
        <ToolTextButton
          label="More"
          width={VECTOR_TOOL_WIDTH.More}
          chevron
          active={tool === "SHAPE_BUILDER" || tool === "VARIABLE_WIDTH"}
          aria-haspopup="menu"
          aria-expanded={!!menuAt}
          onSelect={(e) => {
            if (menuAt) return setMenuAt(null);
            // Live: the menu 11 left of the button, its bottom 16 over the button's top (8 over the toolbar).
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left - 11, y: r.top - 16 });
          }}
        />
      </div>
      {menuAt && (
        <ContextMenu
          at={menuAt}
          above
          flush
          label="Vector editing tools"
          width={189}
          entries={vectorMoreTools(tool, variableWidth && ed.vector.hasTool("VARIABLE_WIDTH"))}
          ignore={more}
          onSelect={(id) => {
            setMenuAt(null);
            pick(id as VectorTool);
          }}
          onClose={() => setMenuAt(null)}
        />
      )}
      <ToolbarDivider />
      <IconButton
        icon="24.close.small"
        label="Close"
        onClick={() => {
          ed.vector.end();
          ed.focusCanvas();
        }}
      />
    </Toolbar>
  );
}
