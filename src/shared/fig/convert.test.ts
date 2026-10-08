/**
 * Figma → ours mappings that change what a file looks like (docs/data-impl.md "Import fidelity"): slots, Figma's
 * derived data. Synthetic structures shaped as Figma's 2026 files write them (no real file's content).
 */
import { describe, expect, it } from "vitest";
import { MODEL } from "../schema/model";
import { convertFigMessage, FIGMA_DERIVED_DATA_VERSION } from "./convert";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-shaped test data */

const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const T = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const node = (guid: any, type: string, parent: any, position: string, extra: any = {}) => ({ guid, phase: "CREATED", type, parentIndex: { guid: parent, position }, ...extra });

function slotFile() {
  // A main (2:1) with a slot frame (2:2) bound to a SLOT property (2:9); an instance (3:1) on the page whose slot
  // content (4:1, a frame with a text 4:2) sits on the internal canvas, as Figma keeps it.
  const slotRef = { componentPropRefs: [{ defID: g(2, 9), componentPropNodeField: "SLOT_CONTENT_ID" }], parameterConsumptionMap: { entries: [{ variableField: "SLOT_CONTENT_ID", variableData: { dataType: "PROP_REF", resolvedDataType: "SLOT_CONTENT_ID", value: { propRefValue: { defId: g(2, 9) } } } }] } };
  return {
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [
      { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT" },
      node(g(0, 1), "CANVAS", g(0, 0), "!"),
      node(g(0, 2), "CANVAS", g(0, 0), "~", { internalOnly: true }),
      node(g(2, 1), "SYMBOL", g(0, 1), "!", { size: { x: 200, y: 100 }, transform: T(0, 0), componentPropDefs: [{ id: g(2, 9), name: "Slot", type: "SLOT", initialValue: {} }] }),
      node(g(2, 2), "FRAME", g(2, 1), "!", { size: { x: 180, y: 80 }, transform: T(10, 10), ...slotRef }),
      node(g(3, 1), "INSTANCE", g(0, 1), "\"", {
        size: { x: 200, y: 100 },
        transform: T(0, 200),
        symbolData: { symbolID: g(2, 1), symbolOverrides: [] },
        componentPropAssignments: [{ defID: g(2, 9), value: {}, varValue: { dataType: "SLOT_CONTENT_ID", resolvedDataType: "SLOT_CONTENT_ID", value: { slotContentIdValue: { guid: g(4, 1) } } } }],
      }),
      node(g(4, 1), "FRAME", g(0, 2), "!", { isSlotContent: true, size: { x: 180, y: 80 }, transform: T(0, 0) }),
      node(g(4, 2), "TEXT", g(4, 1), "!", { isSlotContent: true, size: { x: 50, y: 16 }, transform: T(0, 0), textData: { characters: "Hi" } }),
    ],
  };
}

describe("convertFigMessage: slots (Figma 2026)", () => {
  it("marks the slot frame, takes the content from the SLOT_CONTENT_ID value and moves it under its instance", () => {
    const { message, report } = convertFigMessage(slotFile(), MODEL);
    const byId = new Map(message.nodeChanges!.map((n) => [`${n.guid!.sessionID}:${n.guid!.localID}`, n]));
    expect(byId.get("2:2")!.isSlot).toBe(true);
    expect(byId.get("3:1")!.componentPropAssignments![0].value?.guidValue).toEqual(g(4, 1));
    const content = byId.get("4:1")!;
    expect(content.parentIndex!.guid).toEqual(g(3, 1));
    // After the instance's own children (it has none here): a position of its own.
    expect(content.parentIndex!.position).toBe("~");
    expect(byId.get("4:2")!.parentIndex!.guid).toEqual(g(4, 1));
    expect(report.mappings["slot content → under its instance"]).toBe(1);
    expect(report.mappings["SLOT_CONTENT_ID binding → isSlot"]).toBe(1);
  });

  it("leaves content already under an instance (our own files) where it is", () => {
    const f = slotFile();
    const content = f.nodeChanges.find((n: any) => n.guid.sessionID === 4 && n.guid.localID === 1) as any;
    content.parentIndex = { guid: g(3, 1), position: "!" };
    const { message, report } = convertFigMessage(f, MODEL);
    expect(message.nodeChanges!.find((n) => n.guid!.sessionID === 4 && n.guid!.localID === 1)!.parentIndex).toEqual({ guid: g(3, 1), position: "!" });
    expect(report.mappings["slot content → under its instance"]).toBeUndefined();
  });
});

describe("convertFigMessage: Figma's derived data (keepDerived)", () => {
  function derivedFile() {
    const glyph = { commandsBlob: 0, position: { x: 0, y: 12 }, fontSize: 12, firstCharacter: 0, advance: 0.6 };
    const layout = { layoutSize: { x: 20, y: 16 }, baselines: [{ position: { x: 0, y: 12 }, width: 20, lineY: 0, lineHeight: 16, lineAscent: 12, firstCharacter: 0, endCharacter: 2 }], glyphs: [glyph], fontMetaData: [{ key: { family: "Brand Sans", style: "Bold", postscript: "" }, fontLineHeight: 1.2, fontDigest: new Uint8Array(20) }] };
    return {
      type: "NODE_CHANGES",
      sessionID: 0,
      ackID: 0,
      blobs: [{ bytes: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]) }],
      nodeChanges: [
        { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT" },
        node(g(0, 1), "CANVAS", g(0, 0), "!"),
        node(g(2, 1), "SYMBOL", g(0, 1), "!", { size: { x: 100, y: 40 }, transform: T(0, 0) }),
        node(g(2, 2), "TEXT", g(2, 1), "!", { size: { x: 20, y: 16 }, transform: T(4, 4), textData: { characters: "Hi" }, derivedTextData: layout }),
        node(g(3, 1), "INSTANCE", g(0, 1), "\"", {
          size: { x: 120, y: 40 },
          transform: T(0, 100),
          symbolData: { symbolID: g(2, 1), symbolOverrides: [] },
          derivedSymbolDataLayoutVersion: 3,
          // Figma lists the instance itself first ([symbolID]); the old text layout lives in textData.
          derivedSymbolData: [
            { guidPath: { guids: [g(2, 1)] }, size: { x: 120, y: 40 } },
            { guidPath: { guids: [g(2, 2)] }, size: { x: 30, y: 16 }, transform: T(14, 4), fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 0 }], textData: { characters: "Hi", ...layout } },
          ],
        }),
      ],
    };
  }

  it("keeps the text layout and instance geometry, stamped as Figma's", () => {
    const { message, report } = convertFigMessage(derivedFile(), MODEL, MODEL, { keepDerived: true });
    expect(message.derivedDataVersion).toBe(FIGMA_DERIVED_DATA_VERSION);
    const text = message.nodeChanges!.find((n) => n.type === "TEXT")!;
    expect(text.derivedTextData?.glyphs?.length).toBe(1);
    expect(text.derivedTextData?.fontMetaData?.[0].key?.family).toBe("Brand Sans");
    const inst = message.nodeChanges!.find((n) => n.type === "INSTANCE")!;
    // The root entry goes (ours leaves the instance out), the sublayer keeps guidPath / size / transform / layout.
    expect(inst.derivedSymbolData!.length).toBe(1);
    const e = inst.derivedSymbolData![0];
    expect(e.guidPath!.guids).toEqual([g(2, 2)]);
    expect(e.size).toEqual({ x: 30, y: 16 });
    expect(e.fillGeometry).toBeUndefined();
    expect(e.derivedTextData?.glyphs?.length).toBe(1);
    expect(report.mappings["TextData layout → derivedTextData"]).toBe(1);
  });

  it("drops them without keepDerived (a paste, an old snapshot of ours)", () => {
    const { message } = convertFigMessage(derivedFile(), MODEL);
    expect(message.derivedDataVersion).toBeUndefined();
    for (const n of message.nodeChanges!) {
      expect(n.derivedTextData).toBeUndefined();
      expect(n.derivedSymbolData).toBeUndefined();
    }
  });
});
