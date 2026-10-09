// Round 11 on the real engine (headless Wasm), the live capture's components (`&doc=capture`): Create property › Slot
// as live's form collects it (popovers/component-create-slot-property.txt) — the property created with its name,
// description, limits, settings and preferred instances in one undo step — "Not used within component" for a property
// no layer uses (design/component-with-slot.txt), and slot limits unset by emptying them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { CAPTURE_DOCUMENT } from "../fixtures";
import { createSlotProperty, newSlotName, readC, slotLayerOf, updateSlotSettings, usedPropertyIds, type SlotPropertyForm } from "../components";
import { guidStr, type ComponentPropDef } from "../model/components";
import { COUNTER_AXIS_INFO, SLOT_LEARN_MORE, hasAutoLayout } from "../panels/design/SlotProperty";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(CAPTURE_DOCUMENT, { fileName: "Untitled" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const form = (patch: Partial<SlotPropertyForm> = {}): SlotPropertyForm => ({
  name: "Slot",
  description: "",
  minChildren: null,
  maxChildren: null,
  allowPreferredValuesOnly: false,
  displayByDefault: false,
  stretchChildOnInsert: false,
  preferred: [],
  ...patch,
});

const slots = (ed: EditorController, id: string) => (readC(ed, id)?.componentPropDefs ?? []).filter((d) => d.type === "SLOT") as ComponentPropDef[];

describe("Create property › Slot (round 11)", () => {
  it("names new slots as Convert to slot does: Slot, then Slot 2", () => {
    expect(newSlotName([])).toBe("Slot");
    expect(newSlotName([{ name: "Slot" } as ComponentPropDef])).toBe("Slot 2");
    expect(newSlotName([{ name: "Slot" }, { name: "Slot 2" }] as ComponentPropDef[])).toBe("Slot 3");
  });

  it("creates the property with everything the form collected, as one undo step", async () => {
    const { ed, engine } = await editor();
    const card = readC(ed, "8:50")!;
    expect(slots(ed, "8:50")).toHaveLength(0);
    const made = createSlotProperty(ed, card, form({ description: "Put **cards** here", minChildren: 1, maxChildren: 3, displayByDefault: true, preferred: [{ type: "COMPONENT", key: "8:1" }] }));
    expect(made?.name).toBe("Slot");
    const [def] = slots(ed, "8:50");
    expect(def).toMatchObject({ name: "Slot", type: "SLOT", description: "Put **cards** here", slotPropConfig: { minChildren: 1, maxChildren: 3, displayByDefault: true }, preferredValues: { instanceSwapValues: [{ type: "COMPONENT", key: "8:1" }] } });
    // Settings left off aren't written (Figma's SlotSettings: unset).
    expect(def.slotPropConfig).not.toHaveProperty("allowPreferredValuesOnly");
    expect(def.slotPropConfig).not.toHaveProperty("stretchChildOnInsert");
    // Not applied to a layer yet: "Not used within component".
    expect(slotLayerOf(ed, readC(ed, "8:50")!, def)).toBeNull();
    expect(usedPropertyIds(ed, readC(ed, "8:50")!).has(guidStr(def.id))).toBe(false);
    // One undo step takes all of it back.
    engine.undo();
    expect(slots(ed, "8:50")).toHaveLength(0);
    engine.destroy();
  });

  it("empties a limit to unset it", async () => {
    const { ed, engine } = await editor();
    createSlotProperty(ed, readC(ed, "8:50")!, form({ minChildren: 2, maxChildren: 4 }));
    const [def] = slots(ed, "8:50");
    updateSlotSettings(ed, readC(ed, "8:50")!, def, { minChildren: null });
    expect(slots(ed, "8:50")[0].slotPropConfig).toEqual({ maxChildren: 4 });
    engine.destroy();
  });

  it("marks only the properties no layer uses (the capture's Button uses all of its own)", async () => {
    const { ed, engine } = await editor();
    const button = readC(ed, "8:1")!;
    const used = usedPropertyIds(ed, button);
    for (const d of button.componentPropDefs ?? []) expect(used.has(guidStr(d.id)), d.name).toBe(true);
    engine.destroy();
  });

  it("offers fill-on-counter-axis only for a slot with auto layout, with live's wording", () => {
    expect(hasAutoLayout(null)).toBe(false);
    expect(hasAutoLayout({ guid: "1:1", stackMode: "NONE" } as never)).toBe(false);
    expect(hasAutoLayout({ guid: "1:1", stackMode: "VERTICAL" } as never)).toBe(true);
    expect(COUNTER_AXIS_INFO).toBe("If a slot follows a horizontal flow (x-axis), items will stretch along its height (y-axis).");
    expect(SLOT_LEARN_MORE).toMatch(/^https:\/\/help\.figma\.com\//);
  });
});
