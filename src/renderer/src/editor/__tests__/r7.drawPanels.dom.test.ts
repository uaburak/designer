// @vitest-environment happy-dom
// Round 7d — Draw's panels and layers (docs/draw.md §5.3–§5.5, §5.8, §5.9): the sections per mode, the stroke kinds
// and their commands, the Transform section and its Repeat popover, Flip, and the Layers previews' cache — on a fake
// engine (the real Draw calls are round 7b's).
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Status } from "@/engine/abi";
import type { Pixels } from "@/engine/codec";
import { DYNAMIC_DEFAULTS, REPEAT_DEFAULTS, type BrushType, type DrawCommandArgs, type InstallBrushInput, type RepeatModifierInput } from "@shared/draw/types";
import type { ChangeInfo } from "@/ds";
import { $, $$, click, focus, key, mount, type, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, type EditorController } from "../controller";
import { Store, type UIState } from "../uiStore";
import { drawToolsOf, setBuiltinBrushes } from "../draw/drawTools";
import {
  addRepeat,
  designSections,
  dynamicOf,
  gapShown,
  gapStored,
  guidString,
  pickStrokeBrush,
  repeatsOf,
  rightPanelTabs,
  scatterOf,
  setDynamic,
  setRepeat,
  setScatter,
  setStretch,
  setStrokeKind,
  stretchOf,
  strokeKindOf,
} from "../draw/panels/drawPanel";
import { RepeatSettings, TransformSection } from "../draw/panels/TransformSection";
import { LayerThumbnails, layerThumbnails } from "../draw/panels/layerThumbs";
import { FlipTextPathButton } from "../panels/design/Typography";
import { zoomToLayer } from "../panels/Layers";
import type { PanelNode } from "../panels/design/shared";

const ARTWORK = { width: 256, height: 16, d: "M0 0L256 8L0 16Z", windingRule: "NONZERO" as const };
const node = (n: Record<string, unknown>) => n as unknown as PanelNode;

/** A fake editor: the Draw commands recorded, transactions counted as the controller opens them. */
function fakeEditor(opts: { built?: boolean; brushes?: { guid: string; name: string; type: BrushType }[] } = {}) {
  const built = opts.built ?? true;
  const notBuilt = (name: string) => {
    throw new Error(`engine: ${name} not built (round 7b)`);
  };
  const brushes = [...(opts.brushes ?? [])];
  const commands: { id: keyof DrawCommandArgs; args: unknown }[] = [];
  const engineCommands: { name: string; args: unknown }[] = [];
  const installed: InstallBrushInput[] = [];
  const txns = { begun: 0, committed: 0, cancelled: 0 };
  let selection: string[] = [];
  const engine = {
    destroyed: false,
    setDrawToolSettings: () => (built ? Status.OK : notBuilt("setDrawToolSettings")),
    installBrush: (input: InstallBrushInput) => {
      if (!built) return notBuilt("installBrush");
      installed.push(input);
      const guid = `0:${100 + brushes.length}`;
      brushes.push({ guid, name: input.name, type: input.type });
      return guid;
    },
    listBrushes: () => (built ? brushes : notBuilt("listBrushes")),
    brushPreview: () => (built ? null : notBuilt("brushPreview")),
    runDrawCommand: (id: keyof DrawCommandArgs, args: unknown) => (built ? (commands.push({ id, args }), Status.OK) : notBuilt("runDrawCommand")),
    commandState: () => 1,
    txnBegin: () => void txns.begun++,
    txnCommit: () => void txns.committed++,
    txnCancel: () => void txns.cancelled++,
    setSelection: (refs: string[]) => void (selection = refs),
    readNode: () => ({}),
    command: (name: string, args: unknown) => (engineCommands.push({ name, args }), Status.OK),
  };
  let open: string | null = null;
  const ed = {
    engine,
    ui: new Store<Partial<UIState>>({ mode: "draw" }),
    store: { readNode: () => ({}) },
    edit(label: string, info: ChangeInfo, write: () => void) {
      if (!info.final) {
        if (open === null) {
          engine.txnBegin();
          open = label;
        }
        write();
        return;
      }
      if (open === null) engine.txnBegin();
      write();
      open = null;
      engine.txnCommit();
    },
    cancelEdit() {
      if (open === null) return;
      open = null;
      engine.txnCancel();
    },
    focusCanvas: () => {},
  } as unknown as EditorController;
  return { ed, commands, engineCommands, installed, txns, selection: () => selection };
}

const withEditor = (ed: EditorController, child: () => ReactNode) =>
  function Host() {
    return createElement(EditorContext.Provider, { value: ed }, child());
  };

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  setBuiltinBrushes([]);
});
beforeEach(() => setBuiltinBrushes([]));

describe("round 7d: the Design panel's sections per mode (docs/draw.md §5.3)", () => {
  const rect = node({ guid: "1:1", type: "ROUNDED_RECTANGLE" });
  const frame = node({ guid: "1:2", type: "FRAME" });
  const group = node({ guid: "1:3", type: "TRANSFORM" });
  const path = node({ guid: "1:4", type: "TEXT_PATH" });

  it("Draw: Alignment / Dimensions, Appearance, Transform, Typography, Fill, Stroke, Effects, Export — no Selection colors, no layout guides", () => {
    expect(designSections("draw", [rect])).toEqual(["position", "layout", "appearance", "transform", "fill", "stroke", "effects", "export"]);
    expect(designSections("draw", [frame])).not.toContain("layoutGuide");
    expect(designSections("draw", [path])).toContain("typography");
  });

  it("Design: as before, Transform only for transform groups", () => {
    expect(designSections("design", [rect])).toEqual(["position", "layout", "appearance", "fill", "stroke", "effects", "selectionColors", "export"]);
    expect(designSections("design", [frame])).toContain("layoutGuide");
    expect(designSections("design", [group])).toContain("transform");
    expect(designSections("design", [group, rect])).not.toContain("transform");
  });

  it("sections: no effects, no layout guide, no transform in Draw either", () => {
    const section = node({ guid: "1:9", type: "SECTION" });
    expect(designSections("draw", [section])).toEqual(["position", "layout", "appearance", "fill", "stroke", "export"]);
  });

  it("Draw has no Prototype tab", () => {
    expect(rightPanelTabs("draw")).toEqual(["design"]);
    expect(rightPanelTabs("design")).toEqual(["design", "prototype"]);
  });
});

describe("round 7d: stroke kinds (docs/draw.md §5.4)", () => {
  it("the kind is implicit: a brush GUID = Brush, Dynamic settings = Dynamic, else Basic", () => {
    expect(strokeKindOf(node({ guid: "1:1" }))).toBe("BASIC");
    expect(strokeKindOf(node({ guid: "1:1", dynamicStrokeSettings: { frequency: 3 } }))).toBe("DYNAMIC");
    expect(strokeKindOf(node({ guid: "1:1", strokeBrushGuid: { sessionID: 0, localID: 7 }, dynamicStrokeSettings: {} }))).toBe("BRUSH");
    expect(guidString("0:7")).toBe("0:7");
    expect(dynamicOf(node({ guid: "1:1", dynamicStrokeSettings: { frequency: 3 } }))).toEqual({ ...DYNAMIC_DEFAULTS, frequency: 3 });
    expect(scatterOf(node({ guid: "1:1", scatterStrokeSettings: { gap: 2 } })).gap).toBe(2);
    expect(stretchOf(node({ guid: "1:1", stretchStrokeSettings: { orientation: "REVERSE" } }))).toEqual({ direction: "BACKWARD" });
  });

  it("Stroke Type › Basic / Dynamic (with the defaults) / Brush (the last-used brush, installed first)", () => {
    setBuiltinBrushes([{ key: "HEIST", name: "Heist", type: "STRETCH", artwork: ARTWORK }]);
    const { ed, commands, installed } = fakeEditor();
    setStrokeKind(ed, ["1:1"], "BASIC");
    setStrokeKind(ed, ["1:1"], "DYNAMIC");
    setStrokeKind(ed, ["1:1", "1:2"], "BRUSH");
    expect(commands).toEqual([
      { id: "SET_STROKE_KIND", args: { refs: ["1:1"], kind: "BASIC" } },
      { id: "SET_STROKE_KIND", args: { refs: ["1:1"], kind: "DYNAMIC", dynamic: DYNAMIC_DEFAULTS } },
      { id: "SET_STROKE_BRUSH", args: { refs: ["1:1", "1:2"], brush: "0:100" } },
    ]);
    expect(installed.map((b) => b.name)).toEqual(["Heist"]);
    expect(drawToolsOf(ed).brush.guid).toBe("0:100");
  });

  it("Brush without any brush to install (no artwork, or the stubs) sends nothing", () => {
    const { ed, commands } = fakeEditor();
    expect(setStrokeKind(ed, ["1:1"], "BRUSH")).toBe(Status.E_UNSUPPORTED);
    expect(commands).toEqual([]);
    const stub = fakeEditor({ built: false });
    expect(setStrokeKind(stub.ed, ["1:1"], "DYNAMIC")).toBe(Status.E_UNSUPPORTED);
  });

  it("Dynamic and Scatter fields are clamped to the plugin API's ranges; a scrub is one undo step", () => {
    const { ed, commands, txns } = fakeEditor();
    setDynamic(ed, ["1:1"], "frequency", 50, { final: false, source: "scrub" });
    setDynamic(ed, ["1:1"], "frequency", 0, { final: false, source: "scrub" });
    setDynamic(ed, ["1:1"], "frequency", 4, { final: true, source: "scrub" });
    expect(txns).toEqual({ begun: 1, committed: 1, cancelled: 0 });
    expect(commands.map((c) => (c.args as { dynamic: { frequency: number } }).dynamic.frequency)).toEqual([20, 0.01, 4]);
    setScatter(ed, ["1:1"], "sizeJitter", 9, { final: true, source: "type" });
    setScatter(ed, ["1:1"], "angularJitter", -400, { final: true, source: "type" });
    setStretch(ed, ["1:1"], "BACKWARD");
    expect(commands.slice(3)).toEqual([
      { id: "SET_BRUSH_SETTINGS", args: { refs: ["1:1"], scatter: { sizeJitter: 3 } } },
      { id: "SET_BRUSH_SETTINGS", args: { refs: ["1:1"], scatter: { angularJitter: -180 } } },
      { id: "SET_BRUSH_SETTINGS", args: { refs: ["1:1"], stretch: { direction: "BACKWARD" } } },
    ]);
  });

  it("the Brush picker's pick sets the layers' brush and becomes the last-used one", () => {
    const { ed, commands } = fakeEditor({ brushes: [{ guid: "0:9", name: "Mine", type: "SCATTER" }] });
    pickStrokeBrush(ed, ["1:1"], { guid: "0:9", name: "Mine", type: "SCATTER", builtin: null });
    expect(commands).toEqual([{ id: "SET_STROKE_BRUSH", args: { refs: ["1:1"], brush: "0:9" } }]);
    expect(drawToolsOf(ed).brush).toMatchObject({ guid: "0:9", name: "Mine" });
  });
});

describe("round 7d: the Transform section and the Repeat popover (docs/draw.md §5.5)", () => {
  const radial = { type: "REPEAT", repeatType: "RADIAL", count: 8, offset: { x: 10, y: 0 }, visible: true };
  const linear = { type: "REPEAT", repeatType: "LINEAR", count: 3, offset: { x: 0.5, y: 0 }, unitType: "RELATIVE", axis: "Y", visible: false };
  const groupNode = node({ guid: "2:1", type: "TRANSFORM", transformModifiers: [radial, { type: "SKEW" }, linear] });

  it("a group's repeats with their document indices (SYMMETRY / SKEW kept, not listed); the schema's zero values", () => {
    expect(repeatsOf(groupNode)).toEqual([
      { index: 0, modifier: { repeatType: "RADIAL", count: 8, offset: 10, unitType: "PIXELS", axis: "X", order: "FORWARD", visible: true } },
      { index: 2, modifier: { repeatType: "LINEAR", count: 3, offset: 0.5, unitType: "RELATIVE", axis: "Y", order: "FORWARD", visible: false } },
    ]);
    expect(repeatsOf(node({ guid: "2:2", type: "TRANSFORM", transformModifiers: [{}] }))[0].modifier).toMatchObject({ repeatType: "LINEAR", count: 1, offset: 0 });
  });

  it("Gap in px or in % of the content (switching keeps the number shown)", () => {
    expect(gapShown(repeatsOf(groupNode)[1].modifier)).toBe(50);
    expect(gapStored(50, "RELATIVE")).toBe(0.5);
    expect(gapStored(16, "PIXELS")).toBe(16);
  });

  it("Linear / Radial repeat add with their defaults; Count is clamped and rounded; a Count scrub is one step", () => {
    const { ed, commands, txns } = fakeEditor();
    addRepeat(ed, ["1:1", "1:2"], "RADIAL");
    setRepeat(ed, "2:1", 0, { count: 2000.4 }, { final: false, source: "scrub" });
    setRepeat(ed, "2:1", 0, { count: 0 }, { final: true, source: "scrub" });
    expect(commands).toEqual([
      { id: "ADD_TRANSFORM_MODIFIER", args: { refs: ["1:1", "1:2"], modifier: REPEAT_DEFAULTS.RADIAL } },
      { id: "SET_TRANSFORM_MODIFIER", args: { ref: "2:1", index: 0, modifier: { count: 1000 } } },
      { id: "SET_TRANSFORM_MODIFIER", args: { ref: "2:1", index: 0, modifier: { count: 1 } } },
    ]);
    expect(txns).toEqual({ begun: 1, committed: 1, cancelled: 0 });
  });

  it("rows: the eye, the minus and Apply transforms to selection go to the engine; a row opens Repeat", () => {
    const { ed, commands } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(TransformSection, { nodes: [groupNode] })), {});
    const rows = $$("[data-repeat-row]");
    expect(rows.map((r) => r.querySelector("button")!.textContent)).toEqual(["Radial repeat", "Linear repeat"]);
    click(rows[1].querySelector('[aria-label="Toggle visibility"]')!);
    click(rows[0].querySelector('[aria-label="Remove"]')!);
    click($("[data-apply-transforms]"));
    expect(commands).toEqual([
      { id: "SET_TRANSFORM_MODIFIER", args: { ref: "2:1", index: 2, modifier: { visible: true } } },
      { id: "REMOVE_TRANSFORM_MODIFIER", args: { ref: "2:1", index: 0 } },
      { id: "APPLY_TRANSFORMS", args: {} },
    ]);
    click(rows[0].querySelector("button")!);
    expect($('[data-repeat-settings="RADIAL"]')).not.toBeNull();
  });

  it("a plain layer in Draw: \"+\" only, no rows, no Apply", () => {
    const { ed } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(TransformSection, { nodes: [node({ guid: "1:1", type: "VECTOR" })] })), {});
    expect($$("[data-repeat-row]")).toEqual([]);
    expect($("[data-apply-transforms]")).toBeNull();
    expect($('[aria-label="Additional transform modifier"]')).not.toBeNull();
  });

  it("the Repeat popover: Count, Gap and its unit, Axis for Linear only, Order", () => {
    const changes: [Partial<RepeatModifierInput>, ChangeInfo][] = [];
    const onChange = (p: Partial<RepeatModifierInput>, i: ChangeInfo) => void changes.push([p, i]);
    const linearInput = repeatsOf(groupNode)[1].modifier;
    m = mount(RepeatSettings, { modifier: { ...linearInput, unitType: "PIXELS", offset: 16 }, anchor: null, onChange, onCancel: () => {}, onClose: () => {}, static: true });
    const count = $('input[aria-label="Count"]');
    focus(count);
    type(count as HTMLInputElement, "12");
    key(count, "Enter");
    click($('[role="radio"][aria-label="Vertical"], [role="radiogroup"][aria-label="Axis"] [role="radio"]:nth-child(2)'));
    click($('[role="radiogroup"][aria-label="Gap unit"] [role="radio"]:nth-child(2)'));
    click($('[role="radiogroup"][aria-label="Order"] [role="radio"]:nth-child(2)'));
    expect(changes.map(([p]) => p)).toEqual([{ count: 12 }, { axis: "Y" }, { unitType: "RELATIVE", offset: 0.16 }, { order: "REVERSE" }]);
    m.unmount();
    m = mount(RepeatSettings, { modifier: REPEAT_DEFAULTS.RADIAL, anchor: null, onChange, onCancel: () => {}, onClose: () => {}, static: true });
    expect($('[role="radiogroup"][aria-label="Axis"]')).toBeNull();
    expect($('[data-repeat-settings="RADIAL"]')).not.toBeNull();
  });
});

describe("round 7d: Flip (docs/draw.md §5.8)", () => {
  it("Typography's Flip sends FLIP_TEXT_PATH for the text paths", () => {
    const { ed, commands } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(FlipTextPathButton, { refs: ["3:1", "3:2"] })), {});
    const flip = $("[data-flip-text-path]");
    expect(flip.getAttribute("aria-label")).toBe("Flip text orientation");
    click(flip);
    expect(commands).toEqual([{ id: "FLIP_TEXT_PATH", args: { refs: ["3:1", "3:2"] } }]);
  });
});

describe("round 7d: Layers previews (docs/draw.md §5.9)", () => {
  const px = (w = 4): Pixels => ({ width: w, height: w, pixels: new Uint8Array(w * w * 4) });
  const setup = (limit?: number, perFrame?: number) => {
    const drawn: string[] = [];
    const slices: (() => void)[] = [];
    const thumbs = new LayerThumbnails(
      (node) => (drawn.push(node), node === "empty" ? null : px()),
      (run) => void slices.push(run),
      limit,
      perFrame
    );
    const idle = () => {
      while (slices.length) slices.shift()!();
    };
    return { thumbs, drawn, idle, slices };
  };
  const parents: Record<string, string | null> = { "1:1": "0:1", "1:2": "1:1", "1:3": "1:1", "0:1": null };
  const parentOf = (id: string) => parents[id] ?? null;

  it("drawn once for a row on screen, then served from the cache", () => {
    const { thumbs, drawn, idle } = setup();
    let notified = 0;
    thumbs.subscribe("1:2", () => notified++);
    expect(thumbs.get("1:2")).toBeUndefined();
    idle();
    expect(drawn).toEqual(["1:2"]);
    expect(notified).toBe(1);
    expect(thumbs.get("1:2")?.width).toBe(4);
    idle();
    expect(drawn).toEqual(["1:2"]);
  });

  it("a change redraws the layer and its ancestors (a stale preview shows meanwhile), not its siblings", () => {
    const { thumbs, drawn, idle } = setup();
    for (const id of ["1:1", "1:2", "1:3"]) {
      thumbs.subscribe(id, () => {});
      thumbs.get(id);
    }
    idle();
    drawn.length = 0;
    thumbs.invalidate(["1:2"], parentOf);
    expect(thumbs.get("1:1")).not.toBeUndefined();
    idle();
    expect(drawn.sort()).toEqual(["1:1", "1:2"]);
  });

  it("only rows on screen are drawn, at most 8 a slice; empty layers cache as null", () => {
    const { thumbs, drawn, slices } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => `5:${i}`);
    const offs = ids.map((id) => thumbs.subscribe(id, () => {}));
    ids.forEach((id) => thumbs.get(id));
    offs[11]();
    slices.shift()!();
    expect(drawn).toHaveLength(8);
    slices.shift()!();
    expect(drawn).toHaveLength(11);
    expect(drawn).not.toContain("5:11");
    thumbs.subscribe("empty", () => {});
    thumbs.get("empty");
    slices.shift()!();
    expect(thumbs.get("empty")).toBeNull();
  });

  it("keeps the last N previews (least recently shown out); removed layers leave", () => {
    const { thumbs, idle } = setup(2);
    for (const id of ["a", "b", "c"]) {
      thumbs.subscribe(id, () => {});
      thumbs.get(id);
      idle();
    }
    expect(thumbs.size).toBe(2);
    thumbs.invalidate([], parentOf, ["c"]);
    expect(thumbs.size).toBe(1);
  });

  it("a row subscribing after a slice dropped it is queued again", () => {
    const { thumbs, drawn, idle } = setup();
    expect(thumbs.get("1:2")).toBeUndefined();
    idle(); // no row listening yet: nothing drawn
    expect(drawn).toEqual([]);
    thumbs.subscribe("1:2", () => {});
    idle();
    expect(drawn).toEqual(["1:2"]);
  });

  it("the editor's previews follow DOCUMENT_CHANGED (GUIDs as the kiwi stream carries them) up the tree", () => {
    let onChange: ((changes: { guid: unknown; phase?: string }[]) => void) | null = null;
    const rendered: string[] = [];
    const tree = { nodes: new Map(Object.entries(parents).map(([id, parent]) => [id, { id, parent }])) };
    const ed = {
      engine: { destroyed: false, renderNodeThumbnailPixels: ({ node }: { node: string }) => (rendered.push(node), px()), onDocumentChanged: (h: typeof onChange) => ((onChange = h), () => {}) },
      getTree: () => tree,
    } as unknown as EditorController;
    const thumbs = layerThumbnails(ed);
    expect(layerThumbnails(ed)).toBe(thumbs);
    thumbs.subscribe("1:1", () => {});
    thumbs.get("1:1");
    thumbs.pump();
    onChange!([{ guid: { sessionID: 1, localID: 2 } }]);
    thumbs.pump();
    expect(rendered).toEqual(["1:1", "1:1"]);
  });

  it("a double-click on a preview zooms to the layer (selected, Zoom to selection)", () => {
    const { ed, engineCommands, selection } = fakeEditor();
    zoomToLayer(ed, "1:2");
    expect(selection()).toEqual(["1:2"]);
    expect(engineCommands).toEqual([{ name: "ZOOM_TO_SELECTION", args: { animate: 300 } }]);
  });
});
