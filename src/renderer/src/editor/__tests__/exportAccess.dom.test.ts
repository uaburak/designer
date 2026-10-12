// @vitest-environment happy-dom
// Who may export (docs/governance.md §2.7): `FileAccess.canExport` read once for a shared file's viewer, cached on the
// editor; Export…, Export frames to PDF…, Copy as PNG / SVG / code, Copy and Cut, File › Duplicate and Save local
// copy… follow it, and the canvas's copy / cut events are stopped while it is off.
import { afterEach, describe, expect, it } from "vitest";
import type { EditorController } from "../controller";
import { COMMANDS } from "../commands";
import { attachExportAccess, canExport, exportAllowed, loadExportAllowed, setExportAllowed } from "../exporting";
import { canDuplicateFile, canSaveLocalCopy } from "../objectCommands";

const settle = () => new Promise((r) => setTimeout(r, 10));

/** An editor as far as these checks read it: a shared file's source with file operations, a selection */
function fakeEditor(): EditorController {
  return {
    source: { fileKey: "f1", fileOps: { fileKey: "f1" } },
    engine: { destroyed: false, abiVersion: () => 0, has: () => true },
    selection: ["1:2"],
  } as unknown as EditorController;
}

function store(role: "viewer" | "editor" | null, canExport: boolean | undefined) {
  const calls: string[] = [];
  return {
    calls,
    fileState: async (k: string) => (calls.push(`state:${k}`), { shared: role !== null, role }),
    fileInfo: async (k: string) => (calls.push(`info:${k}`), { access: canExport === undefined ? null : { canExport } }),
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  delete (window as unknown as { designer?: unknown }).designer;
});

describe("export access", () => {
  it("asks the server only for a shared file's viewer", async () => {
    const local = store(null, false);
    expect(await loadExportAllowed(local, "f1")).toBe(true);
    expect(local.calls).toEqual(["state:f1"]);
    const editor = store("editor", false);
    expect(await loadExportAllowed(editor, "f1")).toBe(true);
    expect(editor.calls).toEqual(["state:f1"]);
    expect(await loadExportAllowed(store("viewer", false), "f1")).toBe(false);
    expect(await loadExportAllowed(store("viewer", true), "f1")).toBe(true);
    expect(await loadExportAllowed(store("viewer", undefined), "f1")).toBe(true); // an older server: as before
  });

  it("gates the commands, Duplicate and Save local copy, and stops copying layers", async () => {
    const ed = fakeEditor();
    (window as unknown as { designer: unknown }).designer = { files: { saveLocalCopy: async () => ({ cancelled: true }) } };
    expect(exportAllowed(ed)).toBe(true);
    expect(canDuplicateFile(ed)).toBe(true);
    expect(canSaveLocalCopy(ed)).toBe(true);
    cleanups.push(attachExportAccess(ed, store("viewer", false)));
    await settle();
    expect(exportAllowed(ed)).toBe(false);
    expect(canExport(ed)).toBe(false);
    expect(canDuplicateFile(ed)).toBe(false);
    expect(canSaveLocalCopy(ed)).toBe(false);
    const enabled = (id: string) => COMMANDS.find((c) => c.id === id)!.enabled!(ed);
    for (const id of ["file.export", "file.export-frames-to-pdf", "edit.copy-as-png", "edit.copy-as-svg", "edit.copy-as-code", "edit.copy", "edit.cut", "file.duplicate", "file.save-local-copy"]) expect(enabled(id), id).toBe(false);

    // The canvas's ⌘C: the document's own listener never hears it
    let heard = 0;
    const listen = () => void heard++;
    document.addEventListener("copy", listen);
    cleanups.push(() => document.removeEventListener("copy", listen));
    const e = new Event("copy", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(heard).toBe(0);
    expect(e.defaultPrevented).toBe(true);
    // A text field still copies
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(heard).toBe(1);

    setExportAllowed(ed, true);
    expect(canDuplicateFile(ed)).toBe(true);
    document.body.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(heard).toBe(2);
  });
});
