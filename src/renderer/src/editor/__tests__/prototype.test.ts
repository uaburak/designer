// The Prototype tab's model (model/prototype.ts): Figma's wording, the animation + direction ⇄ TransitionType mapping,
// actions changing kind, interaction rows, key triggers.
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  ANIMATIONS,
  DIRECTIONS,
  TRIGGERS,
  actionKind,
  actionOfKind,
  animationOf,
  animationsFor,
  disabledTriggers,
  springEditorDuration,
  springOf,
  springSettleTime,
  springWithEditorDuration,
  triggerMenu,
  DEVICE_MODELS,
  DEVICE_PRESETS,
  deviceLabel,
  deviceOf,
  presetIdentifierOf,
  easingFunctionFor,
  easingFunctionOfCurve,
  prototypeCurve,
  easingLabel,
  guidJson,
  mouseDelayOf,
  withMouseDelay,
  guidOf,
  interactionSummary,
  isDirectional,
  keyTriggerLabel,
  keyTriggerOf,
  newInteraction,
  nextFlowName,
  transitionOf,
  withTrigger,
} from "../model/prototype";

describe("prototype model", () => {
  it("uses Figma's wording for triggers, actions and animations", () => {
    expect(TRIGGERS.map((t) => t.label)).toEqual([
      "On click", "On drag", "While hovering", "While pressing", "Key/Gamepad", "Mouse enter", "Mouse leave", "Mouse down", "Mouse up", "After delay",
    ]);
    expect(ACTIONS.filter((a) => a !== "-").map((a) => (a as { label: string }).label)).toEqual([
      "Navigate to", "Change to", "Back", "Scroll to", "Open link", "Open overlay", "Swap overlay", "Close overlay", "Set variable", "Set variable mode", "Conditional",
    ]);
    expect(ANIMATIONS.map((a) => a.label)).toEqual(["Instant", "Dissolve", "Smart animate", "Move in", "Move out", "Push", "Slide in", "Slide out"]);
    expect(easingLabel("SPRING_PRESET_TWO")).toBe("Bouncy");
    expect(easingLabel(undefined)).toBe("Ease out");
  });

  it("maps an animation and its direction to the schema's TransitionType and back", () => {
    // The arrows say where the layers move, the stored type the other side (atlas 13 §5.2): Move in ← comes from the
    // right; Move out ← is MOVE_OUT_TO_RIGHT (MOVE_FROM_LEFT reversed: the old screen leaves to the left).
    expect(transitionOf("MOVE_IN", "LEFT")).toBe("MOVE_FROM_RIGHT");
    expect(transitionOf("MOVE_OUT", "LEFT")).toBe("MOVE_OUT_TO_RIGHT");
    expect(transitionOf("PUSH", "UP")).toBe("PUSH_FROM_BOTTOM");
    expect(transitionOf("SLIDE_OUT", "DOWN")).toBe("SLIDE_OUT_TO_TOP");
    expect(transitionOf("MOVE_OUT")).toBe("MOVE_OUT_TO_RIGHT");  // no direction: Figma's RIGHT
    expect(transitionOf("INSTANT")).toBe("INSTANT_TRANSITION");
    for (const a of ANIMATIONS)
      for (const d of isDirectional(a.value) ? DIRECTIONS : [DIRECTIONS[0]]) expect(animationOf(transitionOf(a.value, d.value))).toEqual({ animation: a.value, direction: d.value });
    // Figma's older names read as their UI3 counterparts.
    expect(animationOf("MAGIC_MOVE").animation).toBe("SMART_ANIMATE");
    expect(animationOf("FADE").animation).toBe("DISSOLVE");
  });

  it("changes an action's kind keeping what still applies", () => {
    const nav = newInteraction(guidJson("1:9"), "2:10").actions![0];
    expect(actionKind(nav)).toBe("NAVIGATE");
    const overlay = actionOfKind("OVERLAY", { ...nav, transitionType: "DISSOLVE" });
    expect(overlay).toMatchObject({ connectionType: "INTERNAL_NODE", navigationType: "OVERLAY", transitionNodeID: { sessionID: 2, localID: 10 }, transitionType: "DISSOLVE" });
    expect(actionKind(actionOfKind("CHANGE_TO", nav))).toBe("CHANGE_TO");
    expect(actionOfKind("CHANGE_TO", nav).transitionNodeID).toBeUndefined();  // a variant, not the frame
    expect(actionOfKind("BACK", nav)).toMatchObject({ connectionType: "BACK" });
    expect(actionOfKind("URL")).toMatchObject({ connectionType: "URL", connectionURL: "", openUrlInNewTab: true });
    expect(actionOfKind("CONDITIONAL").conditionalActions).toHaveLength(2);
  });

  it("writes interaction rows as Figma does", () => {
    const names = (id: string) => ({ "2:10": "Details", "2:20": "Menu" })[id] ?? null;
    expect(interactionSummary(newInteraction(guidJson("1:1"), "2:10"), names)).toEqual({ trigger: "Click", action: "Details", kind: "NAVIGATE" });
    expect(interactionSummary(newInteraction(guidJson("1:1")), names)).toEqual({ trigger: "Click", action: "None", kind: "NAVIGATE" });
    const overlay = { ...newInteraction(guidJson("1:1"), "2:20"), actions: [actionOfKind("OVERLAY", newInteraction(guidJson("1:1"), "2:20").actions![0])] };
    expect(interactionSummary(overlay, names)).toMatchObject({ action: "Menu", kind: "OVERLAY" });
    const delay = withTrigger(newInteraction(guidJson("1:1"), "2:10"), "AFTER_TIMEOUT");
    expect(delay.event).toMatchObject({ interactionType: "AFTER_TIMEOUT", transitionTimeout: 0.8 });
    expect(interactionSummary(delay, names).trigger).toBe("Delay");
    expect(withTrigger(delay, "ON_HOVER").event?.transitionTimeout).toBeUndefined();
  });

  it("Figma's timing: new interactions carry stateManagementVersion 1, mouse delays in interactionMaintained, custom bezier [0, 0, 0.58, 1]", () => {
    expect(newInteraction(guidJson("1:1")).stateManagementVersion).toBe(1);
    expect(easingFunctionFor("CUSTOM_CUBIC")).toEqual([0, 0, 0.58, 1]);
    expect(easingFunctionFor("CUSTOM_SPRING")).toEqual([1, 100, 15, 0]);
    const enter = withTrigger(newInteraction(guidJson("1:1")), "MOUSE_ENTER");
    const delayed = { ...enter, event: withMouseDelay(enter.event!, 0.5) };
    expect(delayed.event).toEqual({ interactionType: "MOUSE_ENTER", interactionMaintained: true, interactionDuration: 0.5 });
    expect(mouseDelayOf(delayed.event)).toBe(0.5);
    expect(withMouseDelay(delayed.event, 0)).toEqual({ interactionType: "MOUSE_ENTER" });
    expect(mouseDelayOf({ interactionType: "MOUSE_UP", interactionMaintained: true })).toBe(0.3);
    expect(mouseDelayOf({ interactionType: "MOUSE_DOWN", transitionTimeout: 0.2 })).toBe(0.2);  // Wecra's earlier placement
    expect(mouseDelayOf({ interactionType: "ON_CLICK", interactionMaintained: true, interactionDuration: 1 })).toBe(0);
    expect(withTrigger(delayed, "MOUSE_LEAVE").event).toMatchObject({ interactionMaintained: true, interactionDuration: 0.5 });
    expect(withTrigger(delayed, "ON_CLICK").event).toEqual({ interactionType: "ON_CLICK" });
    // A legacy delay (Wecra's earlier transitionTimeout placement, or the legacy Mouse in) survives a switch between
    // mouse triggers, moved to Figma's placement.
    expect(withTrigger({ event: { interactionType: "MOUSE_IN", transitionTimeout: 0.25 } }, "MOUSE_ENTER").event).toEqual({ interactionType: "MOUSE_ENTER", interactionMaintained: true, interactionDuration: 0.25 });
    expect(withTrigger({ event: { interactionType: "AFTER_TIMEOUT", transitionTimeout: 1.5 } }, "MOUSE_ENTER").event).toEqual({ interactionType: "MOUSE_ENTER" });
    expect(withTrigger({ ...enter, event: { interactionType: "ON_CLICK", transitionTimeout: 0 } }, "AFTER_TIMEOUT").event?.transitionTimeout).toBe(0.8);
  });

  it("records and shows key triggers", () => {
    const codes = keyTriggerOf({ keyCode: 75, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false });
    expect(codes).toEqual([16, 75]);
    expect(keyTriggerLabel(codes)).toBe("⇧K");
    expect(keyTriggerLabel([91, 39])).toBe("⌘→");
    expect(keyTriggerLabel([32])).toBe("Space");
  });

  it("reads GUIDs either way and names devices and flows", () => {
    expect(guidOf({ sessionID: 1, localID: 2 })).toBe("1:2");
    expect(guidOf("3:4")).toBe("3:4");
    expect(guidJson("5:6")).toEqual({ sessionID: 5, localID: 6 });
    expect(deviceLabel(undefined)).toBe("No device");
    expect(deviceLabel({ type: "PRESET", presetIdentifier: "IPHONE_16", size: { x: 393, y: 852 } })).toBe("iPhone 16");
    // Models: the preset's colours in the identifier (the first one: the preset alone).
    expect(deviceLabel({ type: "PRESET", presetIdentifier: "IPHONE_16_PRO_DESERT_TITANIUM" })).toBe("iPhone 16 Pro");
    expect(deviceOf("IPHONE_16_PRO_DESERT_TITANIUM")).toMatchObject({ preset: ["IPHONE_16_PRO", "iPhone 16 Pro", 402, 874], model: "DESERT_TITANIUM" });
    expect(deviceOf("IPHONE_16_PRO")?.model).toBe("BLACK_TITANIUM");
    expect(deviceOf("IPHONE_16")?.preset[0]).toBe("IPHONE_16");
    expect(deviceOf("IPHONE_15_PRO_MAX_BLUE_TITANIUM")?.preset[0]).toBe("IPHONE_15_PRO_MAX");
    expect(DEVICE_MODELS.IPHONE_15_PRO_MAX).toHaveLength(4);
    expect(deviceOf("NOKIA_3310")).toBeNull();
    expect(presetIdentifierOf("IPHONE_16_PRO", "BLACK_TITANIUM")).toBe("IPHONE_16_PRO");
    expect(presetIdentifierOf("IPHONE_16_PRO", "WHITE_TITANIUM")).toBe("IPHONE_16_PRO_WHITE_TITANIUM");
    // Every preset has a model.
    for (const g of DEVICE_PRESETS) for (const p of g.items) expect(DEVICE_MODELS[p[0]]?.length ?? 0).toBeGreaterThan(0);
    expect(nextFlowName([])).toBe("Flow 1");
    expect(nextFlowName(["Flow 1", "Flow 2"])).toBe("Flow 3");
    expect(nextFlowName(["Flow 2"])).toBe("Flow 3");
  });

  it("disables the triggers Figma's list does (atlas 13 §3.2)", () => {
    const click = { event: { interactionType: "ON_CLICK" as const }, actions: [{ connectionType: "BACK" as const }] };
    const hover = { event: { interactionType: "ON_HOVER" as const }, actions: [{ connectionType: "INTERNAL_NODE" as const }] };
    const key = { event: { interactionType: "ON_KEY_DOWN" as const }, actions: [] };
    // Another interaction's trigger (key triggers may repeat); a lone Back: no While hovering / While pressing.
    const off = disabledTriggers(click, [click, hover, key]);
    expect([...off].sort()).toEqual(["ON_HOVER", "ON_PRESS"]);
    expect(disabledTriggers(key, [click, key]).has("ON_KEY_DOWN")).toBe(false);
    // Open link: On click and Mouse up only.
    const link = { event: { interactionType: "ON_CLICK" as const }, actions: [{ connectionType: "URL" as const }] };
    const linkOff = disabledTriggers(link, [link]);
    expect(linkOff.has("MOUSE_UP")).toBe(false);
    expect(linkOff.has("DRAG")).toBe(true);
    expect(linkOff.has("AFTER_TIMEOUT")).toBe(false);
    // Mouse enter with and without a delay are different triggers.
    const enter = { event: { interactionType: "MOUSE_ENTER" as const }, actions: [] };
    const late = { event: { interactionType: "MOUSE_LEAVE" as const, interactionMaintained: true, interactionDuration: 0.5 }, actions: [] };
    expect(disabledTriggers(late, [enter, late]).has("MOUSE_ENTER")).toBe(false);
    expect(triggerMenu(false, off).find((e) => e !== "-" && e.value === "ON_HOVER")).toMatchObject({ disabled: true });
  });

  it("offers each action Figma's animations (atlas 13 §5.1)", () => {
    const enabled = (k: Parameters<typeof animationsFor>[0], t?: Parameters<typeof animationsFor>[1]) => animationsFor(k, t).filter((a) => !a.disabled).map((a) => a.value);
    expect(enabled("OVERLAY")).toEqual(["INSTANT", "DISSOLVE", "MOVE_IN"]);
    expect(enabled("SWAP")).toEqual(["INSTANT", "DISSOLVE", "SMART_ANIMATE", "MOVE_IN"]);
    expect(enabled("CHANGE_TO")).toEqual(["INSTANT", "DISSOLVE", "SMART_ANIMATE"]);
    expect(enabled("NAVIGATE")).toHaveLength(8);
    expect(enabled("NAVIGATE", "DRAG")).not.toContain("DISSOLVE");
  });

  it("stores a spring's settle time as its duration; its Duration field is 6 / (ζω₀) (atlas 13 §5.4)", () => {
    expect(springSettleTime(springOf("GENTLE_SPRING"))).toBeCloseTo(1.022, 3);
    expect(springSettleTime(springOf("SPRING_PRESET_ONE"))).toBeCloseTo(0.744, 3);
    expect(springSettleTime(springOf("SPRING_PRESET_TWO"))).toBeCloseTo(0.958, 3);
    expect(springSettleTime(springOf("SPRING_PRESET_THREE"))).toBeCloseTo(1.25, 3);
    expect(springEditorDuration(springOf("GENTLE_SPRING"))).toBeCloseTo(0.8, 6);
    const faster = springWithEditorDuration(springOf("GENTLE_SPRING"), 0.4);
    expect(springEditorDuration(faster)).toBeCloseTo(0.4, 3);
    expect(faster[0]).toBe(1);
  });

  it("round 8j: the Easing editor's graph — a custom bezier's four numbers, a custom spring's bounce as its damping", () => {
    expect(prototypeCurve("CUSTOM_CUBIC", [0.1, 0.2, 0.3, 1.2])).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 1.2 } });
    expect(prototypeCurve("OUT_CUBIC", [])).toBeNull();
    // Mass 1, stiffness 100, damping 10: ζ = 0.5, bounce 0.5.
    const spring = prototypeCurve("CUSTOM_SPRING", [1, 100, 10, 0])!;
    expect(spring.easingFunctionSpring!.bounce).toBeCloseTo(0.5, 6);
    expect(easingFunctionOfCurve({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.8 } }, [1, 100, 10, 0])).toEqual([1, 100, 4, 0]);
    expect(easingFunctionOfCurve({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 1 } }, [1, 100, 10])[2]).toBeCloseTo(0.2, 6);
    expect(easingFunctionOfCurve({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } }, [0, 0, 0.58, 1])).toEqual([0.4, 0, 0.2, 1]);
  });
});
