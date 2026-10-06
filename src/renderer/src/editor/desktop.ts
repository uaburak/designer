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
import { COMMANDS, isEnabled, runEditorCommand } from "./commands";
import { isEditable } from "./keyboard";

/** The editor view's preload API, or null (a browser, or another role). */
export function editorBridge(): EditorApi | null {
  const d = (window as unknown as { designer?: { role?: string } }).designer;
  return d?.role === "editor" ? (d as EditorApi) : null;
}

/** Edit commands a focused text field does itself (as src/shared/commands.ts TEXT_FIELD_COMMANDS; the editor imports only types from shared). */
const TEXT_FIELD_COMMANDS: Record<string, string> = { "edit.undo": "undo", "edit.redo": "redo", "edit.select-all": "selectAll", "edit.delete": "delete" };

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
      const native = TEXT_FIELD_COMMANDS[id];
      if (native && isEditable(document.activeElement)) {
        document.execCommand(native);
        return;
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
