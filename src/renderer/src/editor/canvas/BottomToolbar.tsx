/**
 * The bottom toolbar (DS EditorToolbar, Figma UI3): 48 high, 12 over the
 * bottom, centred on the window (not the canvas). A slot shows the last
 * tool chosen in it; tools the engine doesn't implement yet are disabled.
 * The mode switch stays on Design (the others come later).
 */
import { useEffect, useMemo, useState } from "react";
import { EditorToolbar, groupOf, showToast, type ToolGroupId, type ToolId } from "@/ds";
import type { ToolName } from "@/engine/abi";
import { useTool } from "@/engine/hooks";
import { useEditor } from "../controller";
import { runEditorCommand } from "../commands";
import { useUI } from "../hooks";

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
  annotation: null,
  measurement: null,
};

/** The toolbar's tool for the engine's current one. */
export function toolIdOf(engineTool: string): ToolId {
  for (const [id, name] of Object.entries(ENGINE_TOOL)) if (name === engineTool) return id as ToolId;
  return "move";
}

/** Does the engine implement the toolbar's tool? */
const isAvailable = (ed: ReturnType<typeof useEditor>, t: ToolId) => {
  const name = ENGINE_TOOL[t];
  return !!name && ed.tools.has(name);
};

/** The canvas area's width (the toolbar must stay inside it). */
function useCanvasWidth(ed: ReturnType<typeof useEditor>): number {
  const [width, setWidth] = useState(() => ed.canvas?.clientWidth ?? 0);
  useEffect(() => {
    const el = ed.canvas;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ed]);
  return width;
}

const TOOLBAR_WIDTH = 530;
const MARGIN = 8;

export function BottomToolbar() {
  const ed = useEditor();
  const canvasWidth = useCanvasWidth(ed);
  const tool = toolIdOf(useTool(ed.store));
  const left = useUI((s) => s.leftWidth);
  const right = useUI((s) => s.rightWidth);
  const minimized = useUI((s) => s.uiMinimized);
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  // A tool chosen by key is remembered in its slot too.
  if (groups[groupOf(tool)] !== tool) setGroups({ ...groups, [groupOf(tool)]: tool });
  // Centred on the window: the canvas sits between the rail + left panel and the right panel.
  // (kept inside the canvas when the panels are wide).
  const wanted = minimized ? 0 : (right - (48 + left)) / 2;
  const room = Math.max(0, (canvasWidth - TOOLBAR_WIDTH) / 2 - MARGIN);
  const offset = Math.max(-room, Math.min(room, wanted));
  const disabledTools = useMemo(() => (Object.keys(ENGINE_TOOL) as ToolId[]).filter((t) => !isAvailable(ed, t)), [ed]);
  const pick = (t: ToolId) => {
    const name = ENGINE_TOOL[t];
    if (!name || !ed.tools.has(name)) return;
    ed.setTool(name);
    setGroups((g) => ({ ...g, [groupOf(t)]: t }));
    ed.focusCanvas();
  };
  return (
    <EditorToolbar
      floating
      offset={offset}
      tool={tool}
      groupTools={groups}
      disabledTools={disabledTools}
      onTool={pick}
      onActions={() => runEditorCommand(ed, "tool.actions") || showToast({ message: "Actions come later" })}
      mode="design"
      onMode={(m) => {
        if (m !== "design") showToast({ message: "Draw, Motion and Dev Mode come later" });
      }}
      disabledModes={["draw", "motion", "dev"]}
    />
  );
}
