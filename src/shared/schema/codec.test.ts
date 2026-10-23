import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, newDocumentMessage, type Message } from "./codec";
import { BINDINGS, BLOB_FIELDS, DEFAULTS, DOCUMENT_FORMAT_VERSION, FIELD_FLAGS, NODE_FIELDS, SCHEMA_BINARY, SCHEMA_SHA1 } from "./document.generated";
import { MODEL } from "./model";

describe("generated codec", () => {
  it("round-trips a NODE_CHANGES message with a CREATED rectangle and an update carrying clearedFields", () => {
    const message: Message = {
      type: "NODE_CHANGES",
      sessionID: (1 << 20) | 7,
      ackID: 0,
      nodeChanges: [
        {
          guid: { sessionID: (1 << 20) | 7, localID: 1 },
          phase: "CREATED",
          type: "ROUNDED_RECTANGLE",
          name: "Rectangle 1",
          parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" },
          size: { x: 100, y: 50 },
          transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
          fillPaints: [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
          cornerRadius: 8,
        },
        { guid: { sessionID: (1 << 20) | 7, localID: 1 }, opacity: 0.5, clearedFields: [20] },
      ],
      blobs: [],
      sentTimestamp: 1759766400000n,
    };
    const bytes = encodeMessage(message);
    const back = decodeMessage(bytes);
    // kiwi floats are 32-bit: compare after one more round trip (stable), and check the values that are exact.
    expect(encodeMessage(back)).toEqual(bytes);
    expect(back.nodeChanges![0].name).toBe("Rectangle 1");
    expect(back.nodeChanges![1].clearedFields).toEqual([20]);
    expect(back.sentTimestamp).toBe(1759766400000n);
    expect(back.nodeChanges![0].fillPaints![0].color!.r).toBeCloseTo(0.85, 6);
  });

  it("encodes the three nodes of a new file (docs/schema.md §3.1)", () => {
    const m = newDocumentMessage({ libraries: [{ libraryKey: "a".repeat(22), name: "Design System" }] });
    const back = decodeMessage(encodeMessage(m));
    expect(back.nodeChanges!.map((n) => [n.type, n.name, n.parentIndex?.position ?? null])).toEqual([
      ["DOCUMENT", "Document", null],
      ["CANVAS", "Page 1", "!"],
      ["CANVAS", "Internal Only Canvas", "~"],
    ]);
    expect(back.nodeChanges![0].librarySubscriptions).toEqual([{ libraryKey: "a".repeat(22), name: "Design System" }]);
    expect(back.nodeChanges![2].visible).toBe(false);
    expect(back.nodeChanges![2].internalOnly).toBe(true);
  });

  it("throws on a field id the schema does not know (the JS decoder cannot skip)", () => {
    expect(() => decodeMessage(new Uint8Array([99, 0]))).toThrow();
  });
});

describe("field registry (from the schema's tags)", () => {
  it("lists NodeChange's live fields with their flags", () => {
    expect(NODE_FIELDS.length).toBe(271);  // + prototypeScrollbarColor / prototypeScrollbarWidth, + prototypeScrollbar (ours, 2026-10-23), + prototypeTextInput / prototypeCursor, overlayEdgeBehavior / overlayStack (ours, website behaviours 2026-10-21), + overlayFitWindow (ours, 2026-10-21), + audioBeatAnalyses 613 (Motion fields from Figma's current embedded schema, R17 batch C), the 35 Motion fields (Phase 7 round 8 pre-commit, docs/motion.md §4.1), overrideLevel / overrideStash / componentPropRefs / componentKey / sharedSymbolVersion / editScopeInfo (schema round, R17 batch C), textPathStart / transformModifiers / rotationOrigin / vectorOperationVersion (Draw, Phase 7 round 7), pluginData / pluginRelaunchData (plugins, Phase 7 round 5d), invertedCornerMask (ours, round 16), overriddenVariableId (extended collections, round 5), the brush fields and videoPlayback (text round), editInfo (round 6), targetAspectRatio / textTracking / 6 layout version stamps (import polish)
    const cleared = NODE_FIELDS.find((f) => f.name === "clearedFields")!;
    expect(cleared.id).toBe(1000);
    expect(cleared.flags & FIELD_FLAGS.PATCH).toBeTruthy();
    expect(cleared.flags & FIELD_FLAGS.OURS).toBeTruthy();
    const derived = NODE_FIELDS.filter((f) => f.flags & FIELD_FLAGS.DERIVED).map((f) => f.name);
    expect(derived.sort()).toEqual(["derivedSymbolData", "derivedTextData", "fillGeometry", "strokeGeometry"]);
    const own = NODE_FIELDS.filter((f) => f.flags & FIELD_FLAGS.OWN).map((f) => f.name);
    expect(own).toContain("symbolData");
    expect(own).toContain("parentIndex");
  });

  it("has 33 bindable fields (37 bindings with struct components) and the documented defaults", () => {
    expect(new Set(BINDINGS.map((b) => b.field)).size).toBe(33);
    expect(BINDINGS).toContainEqual({ variableField: "WIDTH", field: "size", fieldId: 11, component: "x" });
    expect(BINDINGS).toContainEqual({ variableField: "FONT_STYLE", field: "fontName", fieldId: 41, component: "style" });
    expect(DEFAULTS.NodeChange.visible).toBe(true);
    expect(DEFAULTS.NodeChange.transform).toEqual({ m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 });
    expect(DEFAULTS.NodeChange.fontName).toEqual({ family: "Inter", style: "Regular", postscript: "Inter-Regular" });
    expect(DEFAULTS.NodeChange.lineHeight).toEqual({ value: 100, units: "PERCENT" });
    expect(DEFAULTS.NodeChange.stackPrimarySizing).toBe("RESIZE_TO_FIT_WITH_IMPLICIT_SIZE");
    expect(DEFAULTS.ExportSettings.constraint).toEqual({ type: "CONTENT_SCALE", value: 1 });
  });

  it("knows the blob fields and the binary schema", () => {
    expect(BLOB_FIELDS.map((b) => `${b.message}.${b.field}`).sort()).toEqual(["Glyph.commandsBlob", "Image.dataBlob", "Path.commandsBlob", "VectorData.vectorNetworkBlob"]);
    expect(SCHEMA_BINARY.length).toBe(41364);  // + prototypeScrollbarColor / prototypeScrollbarWidth (@ours), + prototypeScrollbar, InteractionType.ON_DOUBLE_CLICK (@ours, 2026-10-23), + prototypeTextInput / prototypeCursor, PrototypeTextInput / PrototypeTextInputType / PrototypeCursor, overlayEdgeBehavior / overlayStack, OverlayEdgeBehavior / OverlayStack (@ours, website behaviours 2026-10-21), + overlayFitWindow / OverlayFitWindow (@ours, overlay Fit to window, 2026-10-21), + Figma's current-build Motion fields (TimelineData.durationUsVar, StyleIdForAnimation.timelineOffsetVar, TextElementDelayBehaviour 5–7, AudioFill 13–20, AudioBeatAnalysis, ROTATION_3D / Rotation3D, audioParametrizedField, Paint.videoFillPlayback; R17 batch C), + Message.pasteEditorType / pasteAssetType and PasteAssetType (copied Fill / Stroke / Effect rows, 2026-10-19), + MessageType.STYLE (atlas sweep B 2026-10-18), + Paint.animatedImage / animationFrame (GIF fills, atlas sweep A), + Message.undoBatchPageIds (atlas wave 6), + ComponentPropType.NUMBER (atlas wave 2), + Motion: KEYFRAME / KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE, its enums and messages, the Effect *Var slots, ExportSettings 13-17 (Phase 7 round 8 pre-commit), localUndoStack / localRedoStack / encodedOffsetsIndex, Paint interpolation, parentPropDefId, the 6 NodeChange fields and their types (schema round, R17 batch C), TEXT_PATH / TRANSFORM, TextPathStart, TransformModifier and its enums, their fields and Glyph.rotation (Draw, Phase 7 round 7), PluginData / PluginRelaunchData and their fields (Phase 7 round 5d), + invertedCornerMask (round 16), + SlotContentId and slotContentIdValue (round 4), gridReflowEnabled (import fidelity), MAP / VariableMap / extended collections, BRUSH / VIDEO and the brush fields (round 5), the video triggers / actions and MediaAction, EditInfo and Annotation.labelV2 (round 6), PATTERN / NOISE paints and the newer effect fields (round 7), CUSTOM shader paints / effects, CodeComponentId and ComponentPropValue.floatValue (round 11), targetAspectRatio / textTracking / layout version stamps / AuthoredColor / prototype bindings (import polish)
    expect(SCHEMA_SHA1).toMatch(/^[0-9a-f]{40}$/);
    expect(DOCUMENT_FORMAT_VERSION).toBe(1);
    expect(MODEL.def("NodeChange").fields.length).toBe(271);
    expect(MODEL.canContain("NodeChange", new Set(["Image"]))).toBe(true);
  });
});
