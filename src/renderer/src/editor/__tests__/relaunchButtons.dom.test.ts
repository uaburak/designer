// @vitest-environment happy-dom
// Relaunch buttons while a file loads (docs/governance.md §9 "End-to-end run", follow-ups): after a reload the engine's
// read of the page and the document came back with no nodes (the message had no nodeChanges), and the panel threw
// "Cannot read properties of undefined (reading 'length')". It now renders nothing until the nodes are there.
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, type EditorController } from "../controller";
import type { PluginService } from "../plugins/service";
import { RelaunchButtons, relaunchesOf } from "../panels/design/RelaunchButtons";

// The editor's plugin service, as attachPlugins would give it (no plugins known yet)
vi.mock("../plugins/service", async (orig) => ({ ...(await orig<object>()), usePluginService: () => ({ entries: () => [] }), usePlugins: () => null }));

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function fakeEditor(read: () => unknown): EditorController {
  return {
    engine: { destroyed: false, readNodes: read },
    store: { undo: { canUndo: false, canRedo: false }, subscribe: () => () => {} },
  } as unknown as EditorController;
}

describe("relaunch buttons while the file loads", () => {
  it("a read without nodes (undefined, or holes) gives no buttons", () => {
    const service = { entries: () => [] } as unknown as PluginService;
    expect(relaunchesOf(service, undefined)).toEqual([]);
    expect(relaunchesOf(service, null)).toEqual([]);
    expect(relaunchesOf(service, [null, undefined])).toEqual([]);
    expect(relaunchesOf(service, [{ pluginRelaunchData: undefined }])).toEqual([]);
  });

  it("the panel renders nothing (and doesn't throw) when the engine's read has no nodes", () => {
    const ed = fakeEditor(() => undefined);
    function Panel() {
      return createElement(EditorContext.Provider, { value: ed }, createElement(RelaunchButtons, { refs: ["0:1", "0:0"] }));
    }
    expect(() => (m = mount(Panel, {}))).not.toThrow();
    expect(document.querySelector("[data-relaunch-buttons]")).toBeNull();
  });
});
