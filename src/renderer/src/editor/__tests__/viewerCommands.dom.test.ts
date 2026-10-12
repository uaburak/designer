// @vitest-environment happy-dom
// "can view" in a shared file (Figma: view, comment, inspect; no editing, no branches): the commands that edit outside
// the engine's command table — Rename, Paste to replace, Place image/video…, Create branch… and the rest — are off for
// a viewer and on again for an editor (docs/governance.md §9 "End-to-end run", follow-ups).
import { describe, expect, it } from "vitest";
import type { EditorController } from "../controller";
import { COMMANDS, viewOnly } from "../commands";
import { presenceOf } from "../multiplayer/presence";

function fakeEditor(): EditorController {
  return {
    source: { fileKey: "f1", fileOps: { fileKey: "f1" } },
    engine: { destroyed: false, abiVersion: () => 0, has: () => true, commandState: () => 1 },
    images: { store: {} },
    selection: ["1:2"],
  } as unknown as EditorController;
}

const role = (ed: EditorController, r: "viewer" | "editor") => (presenceOf(ed) as unknown as { set(p: object): void }).set({ shared: true, role: r });

describe("a viewer's commands", () => {
  const ids = ["object.rename", "canvas.rename-layers-ai", "edit.paste", "edit.paste-to-replace", "edit.cut", "tool.image", "file.place-image", "file.create-branch", "text.bold"];
  const enabled = (ed: EditorController, id: string) => {
    const c = COMMANDS.find((x) => x.id === id);
    expect(c, id).toBeTruthy();
    return c!.enabled ? c!.enabled(ed) : true;
  };

  it("are off for a viewer, on for an editor; viewing commands stay on", () => {
    const ed = fakeEditor();
    role(ed, "editor");
    expect(viewOnly(ed)).toBe(false);
    for (const id of ["object.rename", "edit.paste", "edit.paste-to-replace", "file.place-image", "tool.image", "file.create-branch"]) expect(enabled(ed, id), id).toBe(true);
    role(ed, "viewer");
    expect(viewOnly(ed)).toBe(true);
    for (const id of ids) expect(enabled(ed, id), id).toBe(false);
    for (const id of ["edit.find", "view.rulers", "canvas.cursor-chat"]) expect(COMMANDS.find((c) => c.id === id)!.enabled?.(ed) ?? true, id).not.toBe(false);
  });
});
