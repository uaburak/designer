/**
 * Figma → ours mappings that change what a file looks like (docs/data-impl.md "Import fidelity"): slots, Figma's
 * derived data. Synthetic structures shaped as Figma's 2026 files write them (no real file's content).
 */
import { describe, expect, it } from "vitest";
import { codec } from "../schema/document.generated";
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

describe("convertFigMessage: Figma fields kept for round-trip (import polish)", () => {
  function file() {
    const authored = { space: "OKLCH", c0: 0.7, c1: 0.1, c2: 250, c3: 1 };
    return {
      type: "NODE_CHANGES",
      sessionID: 0,
      ackID: 0,
      nodeChanges: [
        { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT" },
        node(g(0, 1), "CANVAS", g(0, 0), "!"),
        node(g(1, 1), "RECTANGLE", g(0, 1), "!", {
          size: { x: 200, y: 300 },
          transform: T(0, 0),
          targetAspectRatio: { value: { x: 2, y: 3 } },
          fillPaints: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.9, a: 1 }, opacity: 1, visible: true, authoredColor: authored }],
          effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, visible: true, authoredColor: authored }],
          derivedSymbolDataLayoutVersion: 3,
          stackLayoutVersion: 2,
          prototypeInteractions: [
            {
              id: g(1, 9),
              event: { interactionType: "ON_CLICK", transitionTimeoutVar: { dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: 0.5 } } },
              actions: [{ connectionType: "BACK", transitionDurationVar: { dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: 0.3 } }, transitionOverridesEnabled: true }],
            },
          ],
        }),
        node(g(1, 2), "TEXT", g(0, 1), "\"", {
          size: { x: 40, y: 16 },
          transform: T(0, 400),
          textData: { characters: "Hi" },
          textTracking: 0.5,
          fontVersion: "3",
          textUserLayoutVersion: 5,
          textExplicitLayoutVersion: 1,
          textBidiVersion: 1,
        }),
      ],
    };
  }

  it("keeps targetAspectRatio (and locks proportions), authored colours, layout version stamps, textTracking and prototype bindings", () => {
    const { message, report } = convertFigMessage(file(), MODEL);
    const back = codec.decodeMessage(codec.encodeMessage(message));
    const rect = back.nodeChanges!.find((n) => n.type === "ROUNDED_RECTANGLE")!;
    expect(rect.targetAspectRatio?.value).toEqual({ x: 2, y: 3 });
    expect(rect.proportionsConstrained).toBe(true);
    expect(report.mappings["targetAspectRatio → proportionsConstrained"]).toBe(1);
    expect(rect.fillPaints![0].authoredColor?.space).toBe("OKLCH");
    expect(rect.fillPaints![0].authoredColor?.c2).toBeCloseTo(250);
    expect(rect.effects![0].authoredColor?.space).toBe("OKLCH");
    expect(rect.derivedSymbolDataLayoutVersion).toBe(3);
    expect(rect.stackLayoutVersion).toBe(2);
    const ix = rect.prototypeInteractions![0];
    expect(ix.event?.transitionTimeoutVar?.value?.floatValue).toBeCloseTo(0.5);
    expect(ix.actions![0].transitionDurationVar?.value?.floatValue).toBeCloseTo(0.3);
    expect(ix.actions![0].transitionOverridesEnabled).toBe(true);
    const text = back.nodeChanges!.find((n) => n.type === "TEXT")!;
    expect(text.textTracking).toBeCloseTo(0.5);
    expect([text.fontVersion, text.textUserLayoutVersion, text.textExplicitLayoutVersion, text.textBidiVersion]).toEqual(["3", 5, 1, 1]);
    for (const k of ["targetAspectRatio", "textTracking", "authoredColor", "fontVersion", "textUserLayoutVersion", "derivedSymbolDataLayoutVersion"])
      expect(Object.keys(report.droppedFields).some((f) => f.endsWith(`.${k}`))).toBe(false);
  });
});

describe("convertFigMessage: the schema round's fields (R17 batch C)", () => {
  it("keeps gradient interpolation, override levels and edit scopes; drops the encoding index and Figma's undo", () => {
    const scope = { editScopeStacks: [{ stack: [{ type: "PLUGIN", label: "Rename", editorType: "DESIGN" }] }] };
    const f = {
      type: "NODE_CHANGES",
      sessionID: 0,
      ackID: 0,
      encodedOffsetsIndex: { nodeChangesFieldOffset: 4, nodeChangesFieldLength: 100, blobsFieldOffset: 0, nodeChangeOffsets: [{ guid: g(0, 0), offset: 4 }] },
      localUndoStack: [{ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [] }],
      nodeChanges: [
        { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT" },
        node(g(0, 1), "CANVAS", g(0, 0), "!"),
        node(g(1, 1), "SYMBOL", g(0, 1), "!", { size: { x: 100, y: 100 }, transform: T(0, 0) }),
        node(g(1, 2), "RECTANGLE", g(1, 1), "!", {
          size: { x: 100, y: 100 },
          transform: T(0, 0),
          editScopeInfo: scope,
          fillPaints: [
            {
              type: "GRADIENT_LINEAR",
              visible: true,
              opacity: 1,
              interpolationColorSpace: "OKLCH",
              interpolationHueMethod: "LONGER",
              stops: [
                { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
                { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
              ],
            },
          ],
        }),
        node(g(2, 1), "INSTANCE", g(0, 1), "\"", {
          size: { x: 100, y: 100 },
          transform: T(0, 200),
          symbolData: { symbolID: g(1, 1), symbolOverrides: [{ guidPath: { guids: [g(1, 2)] }, overrideLevel: 1, opacity: 0.5 }] },
        }),
      ],
    };
    const { message, report } = convertFigMessage(f, MODEL);
    const back = codec.decodeMessage(codec.encodeMessage(message));
    expect(back.encodedOffsetsIndex).toBeUndefined();
    expect(back.localUndoStack).toBeUndefined();
    expect(report.droppedFields["Message.encodedOffsetsIndex"]).toBe(1);
    const rect = back.nodeChanges!.find((n) => n.type === "ROUNDED_RECTANGLE")!;
    expect(rect.fillPaints![0].interpolationColorSpace).toBe("OKLCH");
    expect(rect.fillPaints![0].interpolationHueMethod).toBe("LONGER");
    expect(rect.editScopeInfo?.editScopeStacks?.[0].stack?.[0]).toEqual({ type: "PLUGIN", label: "Rename", editorType: "DESIGN" });
    const inst = back.nodeChanges!.find((n) => n.type === "INSTANCE")!;
    expect(inst.symbolData!.symbolOverrides![0].overrideLevel).toBe(1);
  });
});

describe("convertFigMessage: Motion nodes and fields (docs/motion.md §4.1, round 8 pre-commit)", () => {
  function file() {
    // A top-level frame with a 2 s default timeline whose child's opacity binds a KEYFRAME expression to a track
    // (KEYFRAME_TRACK on the internal canvas, two KEYFRAME children), as Figma's current build stores it (§4.2).
    const trackId = g(7, 1);
    const binding = {
      variableField: "OPACITY",
      variableData: {
        dataType: "EXPRESSION",
        resolvedDataType: "FLOAT",
        value: {
          expressionValue: {
            expressionFunction: "KEYFRAME",
            expressionArguments: [
              { dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: 100 } },
              { dataType: "KEYFRAME_TRACK_PARAMETER_DATA", resolvedDataType: "KEYFRAME_TRACK_PARAMETER_DATA", value: { keyframeTrackParameterValue: { parameters: [{ type: "MANUAL", value: { manual: { keyframeTrackId: { guid: trackId }, timelineDefId: g(1, 1) } } }] } } },
            ],
          },
        },
      },
    };
    const keyframe = (guid: any, position: string, timelinePosition: bigint, value: number, easingType: string) =>
      node(guid, "KEYFRAME", trackId, position, { timelinePosition, keyframeValue: { value: { floatValue: value }, valueType: "FLOAT" }, easingData: { easingType }, interpolationType: "BEZIER" });
    return {
      type: "NODE_CHANGES",
      sessionID: 0,
      ackID: 0,
      nodeChanges: [
        { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT" },
        node(g(0, 1), "CANVAS", g(0, 0), "!"),
        node(g(0, 2), "CANVAS", g(0, 0), "~", { internalOnly: true }),
        node(g(1, 1), "FRAME", g(0, 1), "!", { size: { x: 400, y: 300 }, transform: T(0, 0), timelineDuration: 2_000_000n, playbackStyle: "LOOP", timelineKeyframeSnappingFps: { numerator: 60, denominator: 1 } }),
        node(g(1, 2), "ROUNDED_RECTANGLE", g(1, 1), "!", { size: { x: 100, y: 100 }, transform: T(20, 20), opacity: 1, parameterConsumptionMap: { entries: [binding] }, transformOrigin: { x: { value: 50, units: "PERCENT" }, y: { value: 50, units: "PERCENT" } }, motionTransform: { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, shearX: 0 } }),
        node(trackId, "KEYFRAME_TRACK", g(0, 2), "!", { name: "OPACITY", keyframeOperation: "SET", trackLoopMode: "NONE" }),
        keyframe(g(7, 2), "!", 0n, 0, "IN_CUBIC"),
        keyframe(g(7, 3), "\"", 500_000n, 100, "OUT_CUBIC"),
      ],
    };
  }

  it("keeps KEYFRAME_TRACK / KEYFRAME nodes, the timeline's fields and the KEYFRAME expression through encode / decode", () => {
    const { message, report } = convertFigMessage(file(), MODEL);
    expect(report.droppedNodeTypes).toEqual({});
    expect(report.droppedOrphans).toBe(0);
    for (const k of ["timelineDuration", "playbackStyle", "timelineKeyframeSnappingFps", "timelinePosition", "keyframeValue", "easingData", "keyframeOperation", "transformOrigin", "motionTransform"])
      expect(Object.keys(report.droppedFields).some((f) => f.endsWith(`.${k}`))).toBe(false);
    const back = codec.decodeMessage(codec.encodeMessage(message));
    const types = back.nodeChanges!.map((n) => n.type);
    expect(types).toContain("KEYFRAME_TRACK");
    expect(types.filter((t) => t === "KEYFRAME")).toHaveLength(2);
    const root = back.nodeChanges!.find((n) => n.type === "FRAME")!;
    expect(root.timelineDuration).toBe(2_000_000n);
    expect(root.playbackStyle).toBe("LOOP");
    expect(root.timelineKeyframeSnappingFps).toEqual({ numerator: 60, denominator: 1 });
    const rect = back.nodeChanges!.find((n) => n.type === "ROUNDED_RECTANGLE")!;
    const expr = rect.parameterConsumptionMap!.entries![0].variableData!.value!.expressionValue!;
    expect(expr.expressionFunction).toBe("KEYFRAME");
    expect(expr.expressionArguments![0].value?.floatValue).toBe(100);
    expect(expr.expressionArguments![1].value?.keyframeTrackParameterValue?.parameters![0].value?.manual?.keyframeTrackId?.guid).toEqual(g(7, 1));
    const keys = back.nodeChanges!.filter((n) => n.type === "KEYFRAME");
    expect(keys.map((k) => k.timelinePosition)).toEqual([0n, 500_000n]);
    expect(keys[1].keyframeValue).toEqual({ value: { floatValue: 100 }, valueType: "FLOAT" });
    expect(keys[1].easingData?.easingType).toBe("OUT_CUBIC");
    expect(rect.transformOrigin?.x).toEqual({ value: 50, units: "PERCENT" });
    expect(rect.motionTransform?.scale).toEqual({ x: 1, y: 1 });
  });
});
