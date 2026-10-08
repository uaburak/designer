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
  DEVICE_MODELS,
  DEVICE_PRESETS,
  deviceLabel,
  deviceOf,
  presetIdentifierOf,
  easingLabel,
  guidJson,
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
    // The arrows say where the layers move: Move in ← comes from the right; Move out ← goes to the left.
    expect(transitionOf("MOVE_IN", "LEFT")).toBe("MOVE_FROM_RIGHT");
    expect(transitionOf("MOVE_OUT", "LEFT")).toBe("MOVE_OUT_TO_LEFT");
    expect(transitionOf("PUSH", "UP")).toBe("PUSH_FROM_BOTTOM");
    expect(transitionOf("SLIDE_OUT", "DOWN")).toBe("SLIDE_OUT_TO_BOTTOM");
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
    expect(interactionSummary(newInteraction(guidJson("1:1"), "2:10"), names)).toEqual({ trigger: "On click", action: "Details" });
    expect(interactionSummary(newInteraction(guidJson("1:1")), names)).toEqual({ trigger: "On click", action: "None" });
    const overlay = { ...newInteraction(guidJson("1:1"), "2:20"), actions: [actionOfKind("OVERLAY", newInteraction(guidJson("1:1"), "2:20").actions![0])] };
    expect(interactionSummary(overlay, names).action).toBe("Open Menu");
    const delay = withTrigger(newInteraction(guidJson("1:1"), "2:10"), "AFTER_TIMEOUT");
    expect(delay.event).toMatchObject({ interactionType: "AFTER_TIMEOUT", transitionTimeout: 0.8 });
    expect(interactionSummary(delay, names).trigger).toBe("After 800ms");
    expect(withTrigger(delay, "ON_HOVER").event?.transitionTimeout).toBeUndefined();
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
    expect(deviceOf("IPHONE_16_PRO_DESERT_TITANIUM")).toMatchObject({ preset: ["IPHONE_16_PRO"], model: "DESERT_TITANIUM" });
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
});
