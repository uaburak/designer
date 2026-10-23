// The Plugin API shapes of prototypes (agents/prototypeSpec.ts) against Figma's own writer and reader
// (docs/research/rea/motion.md §2.1–2.4): every directional type swaps LEFT ↔ RIGHT and TOP ↔ BOTTOM, EASE_IN stays
// EASE_IN, custom easings are clamped and their functions only go with their own type, zero durations read 0.3 s and
// zero timeouts 0.8 s, mouse delays live in interactionMaintained / interactionDuration, new reactions carry
// stateManagementVersion 1, and node.reactions reads as Figma's Reaction.
import { describe, expect, it } from "vitest";
import { pluginReactionsFromDoc, reactionsFromDoc, reactionToDoc, settingsFromDoc, settingsToDoc, type ProtoLookup, type ProtoNodeInfo } from "../agents/prototypeSpec";
import type { PrototypeAction, PrototypeInteraction } from "../model/prototype";

const node = (id: string, name: string): ProtoNodeInfo => ({ id, name, type: "FRAME", isStateGroup: false, parentType: "CANVAS", parentIsStateGroup: false, pageId: "0:1" });
const NODES: Record<string, ProtoNodeInfo> = { "1:1": node("1:1", "Home"), "1:2": node("1:2", "Next") };
let ids = 0;
const look: ProtoLookup = {
  node: (id) => NODES[id] ?? null,
  collection: () => null,
  variable: () => null,
  newId: () => ({ sessionID: 1, localID: 100 + ids++ }),
};

function write(reaction: unknown): { doc?: PrototypeInteraction; errors: string[] } {
  const errors: string[] = [];
  const doc = reactionToDoc(reaction, look, NODES["1:1"], "r", errors, []);
  return { doc, errors };
}
const action = (r: { doc?: PrototypeInteraction }): PrototypeAction => r.doc!.actions![0];
const navigate = (transition: unknown) => ({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:2", navigation: "NAVIGATE", transition }] });
const readBack = (doc: PrototypeInteraction) => (reactionsFromDoc([doc])[0].actions as { transition: Record<string, unknown> }[])[0].transition;

describe("prototype Plugin API shapes", () => {
  it("swaps the side for every directional type, both ways (Figma's Plugin writer and reader)", () => {
    const prefixes: Record<string, string> = { MOVE_IN: "MOVE_FROM_", MOVE_OUT: "MOVE_OUT_TO_", PUSH: "PUSH_FROM_", SLIDE_IN: "SLIDE_FROM_", SLIDE_OUT: "SLIDE_OUT_TO_" };
    const opposite: Record<string, string> = { LEFT: "RIGHT", RIGHT: "LEFT", TOP: "BOTTOM", BOTTOM: "TOP" };
    let n = 0;
    for (const [type, prefix] of Object.entries(prefixes))
      for (const direction of ["LEFT", "RIGHT", "TOP", "BOTTOM"]) {
        const r = write(navigate({ type, direction, duration: 0.4, easing: "EASE_OUT" }));
        expect(r.errors).toEqual([]);
        expect(action(r).transitionType).toBe(prefix + opposite[direction]);
        expect(readBack(r.doc!)).toMatchObject({ type, direction, duration: 0.4 });
        n++;
      }
    expect(n).toBe(20);
    // The case the old mapping had wrong: {MOVE_OUT, LEFT} is stored MOVE_OUT_TO_RIGHT, as Figma stores it.
    expect(action(write(navigate({ type: "MOVE_OUT", direction: "LEFT" }))).transitionType).toBe("MOVE_OUT_TO_RIGHT");
    expect(action(write(navigate({ type: "SLIDE_OUT", direction: "TOP" }))).transitionType).toBe("SLIDE_OUT_TO_BOTTOM");
  });

  it("writes EASE_IN as EASE_IN (15) and reads IN_CUBIC as EASE_IN too", () => {
    const r = write(navigate({ type: "DISSOLVE", easing: "EASE_IN" }));
    expect(action(r).easingType).toBe("EASE_IN");
    expect(readBack(r.doc!).easing).toEqual({ type: "EASE_IN" });
    expect(readBack({ actions: [{ connectionType: "INTERNAL_NODE", transitionType: "DISSOLVE", easingType: "IN_CUBIC" }] }).easing).toEqual({ type: "EASE_IN" });
  });

  it("custom easings: Figma's default and write clamps; a function with another type is an error", () => {
    expect(action(write(navigate({ type: "DISSOLVE", easing: "CUSTOM_CUBIC_BEZIER" }))).easingFunction).toEqual([0, 0, 0.58, 1]);
    const bez = write(navigate({ type: "DISSOLVE", easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: -0.5, y1: -2, x2: 1.7, y2: 3 } } }));
    expect(action(bez).easingFunction).toEqual([0, -2, 1, 3]);
    const spring = write(navigate({ type: "DISSOLVE", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: 5000, stiffness: -3, damping: 2000, initialVelocity: 4 } } }));
    expect(action(spring).easingFunction).toEqual([1000, 0, 1000, 0]);
    expect(write(navigate({ type: "DISSOLVE", easing: { type: "EASE_OUT", easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } })).errors.join()).toContain("easingFunctionCubicBezier: only with type CUSTOM_CUBIC_BEZIER");
    expect(write(navigate({ type: "DISSOLVE", easing: { type: "GENTLE", easingFunctionSpring: { mass: 1, stiffness: 1, damping: 1 } } })).errors.join()).toContain("easingFunctionSpring: only with type CUSTOM_SPRING");
  });

  it("reads a zero duration as 0.3 s and a zero timeout as 0.8 s", () => {
    const doc: PrototypeInteraction = { event: { interactionType: "AFTER_TIMEOUT", transitionTimeout: 0 }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", transitionNodeID: "1:2", transitionType: "DISSOLVE", transitionDuration: 0 }] };
    const r = reactionsFromDoc([doc])[0];
    expect(r.trigger).toEqual({ type: "AFTER_TIMEOUT", timeout: 0.8 });
    expect((r.actions as { transition: { duration: number } }[])[0].transition.duration).toBe(0.3);
  });

  it("keeps mouse delays in interactionMaintained / interactionDuration (and reads Wecra's earlier transitionTimeout)", () => {
    const r = write({ trigger: { type: "MOUSE_ENTER", delay: 0.4 }, actions: [{ type: "BACK" }] });
    expect(r.doc!.event).toEqual({ interactionType: "MOUSE_ENTER", interactionMaintained: true, interactionDuration: 0.4 });
    expect(reactionsFromDoc([r.doc!])[0].trigger).toEqual({ type: "MOUSE_ENTER", delay: 0.4 });
    expect(write({ trigger: { type: "MOUSE_UP", delay: 0 }, actions: [] }).doc!.event).toEqual({ interactionType: "MOUSE_UP" });
    const old = reactionsFromDoc([{ event: { interactionType: "MOUSE_LEAVE", transitionTimeout: 0.25 }, actions: [] }])[0];
    expect(old.trigger).toEqual({ type: "MOUSE_LEAVE", delay: 0.25 });
    const maintained = reactionsFromDoc([{ event: { interactionType: "MOUSE_DOWN", interactionMaintained: true }, actions: [] }])[0];
    expect(maintained.trigger).toEqual({ type: "MOUSE_DOWN", delay: 0.3 });
  });

  it("new reactions carry stateManagementVersion 1; node.reactions reads as Figma's Reaction", () => {
    const r = write(navigate({ type: "PUSH", direction: "LEFT" }));
    expect(r.doc!.stateManagementVersion).toBe(1);
    const plugin = pluginReactionsFromDoc([r.doc!, { event: { interactionType: "NONE" }, actions: [], isDeleted: true }]);
    expect(plugin).toHaveLength(1);
    expect(Object.keys(plugin[0]).sort()).toEqual(["action", "actions", "trigger"]);
    expect(plugin[0].trigger).toEqual({ type: "ON_CLICK" });
    expect(plugin[0].action).toEqual((plugin[0].actions as unknown[])[0]);
    expect((plugin[0].actions as { transition: unknown }[])[0].transition).toMatchObject({ type: "PUSH", direction: "LEFT" });
  });

  it("Wecra's ON_DOUBLE_CLICK trigger and Scrollbar setting (not Figma's) go through as they are", () => {
    for (const type of ["ON_DOUBLE_CLICK", "DOUBLE_CLICK"]) {
      const r = write({ trigger: { type }, actions: [{ type: "NODE", destinationId: "1:2", navigation: "NAVIGATE" }] });
      expect(r.errors).toEqual([]);
      expect(r.doc!.event).toEqual({ interactionType: "ON_DOUBLE_CLICK" });
      expect(reactionsFromDoc([r.doc!])[0].trigger).toEqual({ type: "ON_DOUBLE_CLICK" });
    }
    const errors: string[] = [];
    expect(settingsToDoc({ overflowDirection: "VERTICAL", prototypeScrollbar: true }, "n", errors)).toEqual({ scrollDirection: "VERTICAL", prototypeScrollbar: true });
    expect(settingsToDoc({ prototypeScrollbar: false }, "n", errors)).toEqual({ prototypeScrollbar: null });
    expect(errors).toEqual([]);
    settingsToDoc({ prototypeScrollbar: "yes" }, "n", errors);
    expect(errors).toHaveLength(1);
    expect(settingsFromDoc({ scrollDirection: "BOTH", prototypeScrollbar: true })).toEqual({ overflowDirection: "BOTH", prototypeScrollbar: true });
    // Its colour ("#RRGGBBAA" or {r, g, b, a}) and width (2–24); null puts the automatic ones back.
    const e2: string[] = [];
    expect(settingsToDoc({ prototypeScrollbarColor: "#FF000080", prototypeScrollbarWidth: 10 }, "n", e2)).toEqual({
      prototypeScrollbarColor: { r: 1, g: 0, b: 0, a: 128 / 255 },
      prototypeScrollbarWidth: 10,
    });
    expect(settingsToDoc({ prototypeScrollbarColor: { r: 0, g: 0, b: 1, a: 0.4 } }, "n", e2)).toEqual({ prototypeScrollbarColor: { r: 0, g: 0, b: 1, a: 0.4 } });
    expect(settingsToDoc({ prototypeScrollbarColor: null, prototypeScrollbarWidth: null }, "n", e2)).toEqual({ prototypeScrollbarColor: null, prototypeScrollbarWidth: null });
    expect(e2).toEqual([]);
    settingsToDoc({ prototypeScrollbarColor: "red-ish", prototypeScrollbarWidth: 40 }, "n", e2);
    expect(e2).toHaveLength(2);
    expect(settingsFromDoc({ prototypeScrollbar: true, prototypeScrollbarColor: { r: 1, g: 0, b: 0, a: 0.5 }, prototypeScrollbarWidth: 10 })).toEqual({
      prototypeScrollbar: true,
      prototypeScrollbarColor: "#FF000080",
      prototypeScrollbarWidth: 10,
    });
  });
});
