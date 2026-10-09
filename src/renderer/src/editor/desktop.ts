/**
 * The desktop app's hooks (docs/desktop.md §6, §8), when the editor runs in
 * an editor view (`window.designer.role === "editor"`); nothing in a plain
 * browser. Autosave: main's flush (`tab.onFlush`) waits for the source's
 * flush; the app menu sends the editor's own command ids (run here, or
 * natively in a focused text field) and gets each command's enabled /
 * checked state whenever it changes (`menu.setState`); the tab's title
 * follows the file's name; a file trashed or deleted elsewhere closes its tab.
 */
import type { EditorApi } from "@shared/desktop";
import type { MenuCommandEvent, MenuStatePatch } from "@shared/ipc";
import type { EditorController } from "./controller";
import { COMMAND_BY_ID, COMMANDS, isEnabled, runEditorCommand } from "./commands";
import { isEditable } from "./keyboard";
import { attachAgents } from "./agents/service";

/** The editor view's preload API, or null (a browser, or another role). */
export function editorBridge(): EditorApi | null {
  const d = (window as unknown as { designer?: { role?: string } }).designer;
  return d?.role === "editor" ? (d as EditorApi) : null;
}

/** Edit commands a focused text field does itself (as src/shared/commands.ts TEXT_FIELD_COMMANDS; the editor imports only types from shared). */
const TEXT_FIELD_COMMANDS: Record<string, string> = { "edit.undo": "undo", "edit.redo": "redo", "edit.select-all": "selectAll", "edit.delete": "delete" };

/**
 * What a menu-bar command does while a text field has the focus (docs/desktop.md §8.3, rule 4): Undo, Redo, Select all
 * and Delete act on the field; any other key that came through the menu bar (`accelerator`) is ignored — a shortcut
 * never fires from a text field; a command clicked in the menu runs. The canvas's own text field (text being edited on
 * the canvas) keeps its ⌘ / ⌃ shortcuts; a plain key (N, [, ⇧V…) is typing there too. Main drops plain keys already
 * (src/shared/commands.ts runsFromMenuBar: macOS hands the menu bar the letters a field leaves unhandled).
 */
export function menuCommandInField(id: string, source: MenuCommandEvent["source"], field: "dom" | "canvas-text" = "dom"): "native" | "drop" | "run" {
  if (TEXT_FIELD_COMMANDS[id]) return "native";
  if (source !== "accelerator") return "run";
  if (field === "dom") return "drop";
  // The key the menu shows (its accelerator) is the command's first.
  const shown = COMMAND_BY_ID.get(id)?.keys?.[0];
  return shown && !shown.mod && !shown.ctrl ? "drop" : "run";
}

type MenuState = { enabled: Record<string, boolean>; checked: Record<string, boolean> };

/** Every registry command's enabled / checked state now. */
export function menuState(ed: EditorController): MenuState {
  const enabled: Record<string, boolean> = {};
  const checked: Record<string, boolean> = {};
  for (const c of COMMANDS) {
    enabled[c.id] = isEnabled(ed, c);
    if (c.checked) checked[c.id] = c.checked(ed);
  }
  return { enabled, checked };
}

/** Only what changed since `last` (null: everything). */
export function menuPatch(last: MenuState | null, next: MenuState): MenuStatePatch | null {
  const diff = (a: Record<string, boolean> | undefined, b: Record<string, boolean>) => {
    const out: Record<string, boolean> = {};
    let any = false;
    for (const [k, v] of Object.entries(b))
      if (!a || a[k] !== v) {
        out[k] = v;
        any = true;
      }
    return any ? out : undefined;
  };
  const enabled = diff(last?.enabled, next.enabled);
  const checked = diff(last?.checked, next.checked);
  return enabled || checked ? ({ enabled, checked } as MenuStatePatch) : null;
}

export function attachDesktop(ed: EditorController): () => void {
  const d = editorBridge();
  if (!d) return () => {};
  const offs: (() => void)[] = [];

  // Agents: tool calls for this file are answered from the start (an MCP client may call before the tab is shown).
  offs.push(attachAgents(ed));

  // Main ends the view right after a close/quit flush: what is still pending (the thumbnail) goes first, then the changes are fsynced.
  offs.push(
    d.tab.onFlush(async () => {
      await Promise.all([...ed.beforeFlush].map((work) => work().catch(() => {})));
      await ed.source.flush();
    })
  );

  offs.push(
    d.menu.onCommand((c: MenuCommandEvent) => {
      const id = c.id as string;
      if (id === "file.save") {
        void ed.source.flush();
        return;
      }
      const focused = document.activeElement;
      if (isEditable(focused)) {
        const action = menuCommandInField(id, c.source, focused?.closest("[data-canvas-text]") ? "canvas-text" : "dom");
        if (action === "native") return void document.execCommand(TEXT_FIELD_COMMANDS[id]);
        if (action === "drop") return;
      }
      runEditorCommand(ed, id);
    })
  );

  // The menu's enablement: recomputed at most once a frame after anything it depends on changed.
  let last: MenuState | null = null;
  let frame = 0;
  const publish = () => {
    frame = 0;
    if (ed.engine.destroyed) return;
    const next = menuState(ed);
    const patch = menuPatch(last, next);
    last = next;
    if (patch) d.menu.setState(patch);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(publish);
  };
  for (const topic of ["selection", "undo", "tool", "pages", "page", "structure"] as const) offs.push(ed.store.subscribe(topic, schedule));
  offs.push(ed.engine.on("NODES_CHANGED", schedule), ed.ui.subscribe(schedule));
  publish();
  offs.push(() => cancelAnimationFrame(frame));

  let name = ed.ui.get().fileName;
  d.tab.report({ title: name, status: "ready" });
  offs.push(
    ed.ui.subscribe(() => {
      const next = ed.ui.get().fileName;
      if (next !== name) {
        name = next;
        d.tab.report({ title: name });
      }
    })
  );
  const meta = ed.source.onMetaChanged?.((m) => {
    if (m.trashed || m.deleted) d.tab.close();
  });
  if (meta) offs.push(meta);
  return () => offs.forEach((off) => off());
}
