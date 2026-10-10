/**
 * The agents' prototype shapes (JSON Schema for tools/list): Figma's Plugin API Reaction / Trigger / Action /
 * Transition / Easing, which agents know, with a few shorthands. The converters to and from the document's
 * PrototypeInteraction (schema/document.kiwi "Prototyping") are src/renderer/src/editor/agents/prototypeSpec.ts.
 *
 * Mapping (Plugin API → document):
 *   trigger.type  ON_CLICK → ON_CLICK, ON_DRAG → DRAG, ON_HOVER (While hovering) → ON_HOVER, ON_PRESS (While pressing)
 *                 → ON_PRESS, ON_KEY_DOWN {keyCodes, device} → ON_KEY_DOWN + keyTrigger, MOUSE_ENTER / MOUSE_LEAVE /
 *                 MOUSE_DOWN / MOUSE_UP {delay s} → the same (+ transitionTimeout), AFTER_TIMEOUT {timeout s} →
 *                 AFTER_TIMEOUT + transitionTimeout, ON_MEDIA_HIT {mediaHitTime} / ON_MEDIA_END → the same.
 *   action.type   NODE {destinationId, navigation} → connectionType INTERNAL_NODE + navigationType (CHANGE_TO →
 *                 SWAP_STATE) + transitionNodeID; BACK, CLOSE → BACK, CLOSE; URL {url, openInNewTab} → URL +
 *                 connectionURL; SET_VARIABLE {variableId, variableValue} → targetVariable + targetVariableData;
 *                 SET_VARIABLE_MODE {variableCollectionId, variableModeId} → targetVariableSetID +
 *                 targetVariableModeID; CONDITIONAL {conditionalBlocks} → conditionalActions; UPDATE_MEDIA_RUNTIME
 *                 {destinationId, mediaAction, amountToSkip, newTimestamp} → mediaAction, mediaSkipByAmount,
 *                 mediaSkipToTime.
 *   transition    null / INSTANT → INSTANT_TRANSITION; DISSOLVE, SMART_ANIMATE, SCROLL_ANIMATE → the same; MOVE_IN /
 *                 PUSH / SLIDE_IN {direction} → MOVE_FROM_ / PUSH_FROM_ / SLIDE_FROM_<opposite side>, MOVE_OUT /
 *                 SLIDE_OUT → MOVE_OUT_TO_ / SLIDE_OUT_TO_<side> (direction: the way the layers move, the panel's
 *                 arrow); matchLayers → transitionShouldSmartAnimate; duration (seconds) → transitionDuration.
 *   easing.type   EASE_IN → IN_CUBIC, EASE_OUT → OUT_CUBIC, EASE_IN_AND_OUT → INOUT_CUBIC, LINEAR, EASE_IN_BACK →
 *                 IN_BACK_CUBIC, EASE_OUT_BACK, EASE_IN_AND_OUT_BACK, CUSTOM_CUBIC_BEZIER {easingFunctionCubicBezier}
 *                 → CUSTOM_CUBIC [x1,y1,x2,y2], GENTLE → GENTLE_SPRING, QUICK → SPRING_PRESET_ONE, BOUNCY →
 *                 SPRING_PRESET_TWO, SLOW → SPRING_PRESET_THREE, CUSTOM_SPRING {easingFunctionSpring} →
 *                 CUSTOM_SPRING [mass, stiffness, damping, 0].
 */

type Obj = Record<string, unknown>;

export const TRIGGER_TYPES = ["ON_CLICK", "ON_DRAG", "ON_HOVER", "ON_PRESS", "ON_KEY_DOWN", "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_DOWN", "MOUSE_UP", "AFTER_TIMEOUT", "ON_MEDIA_HIT", "ON_MEDIA_END"] as const;
/** Accepted on writes for a trigger type */
export const TRIGGER_ALIASES: Readonly<Record<string, string>> = { WHILE_HOVERING: "ON_HOVER", WHILE_PRESSING: "ON_PRESS", KEY_DOWN: "ON_KEY_DOWN", KEY_GAMEPAD: "ON_KEY_DOWN", AFTER_DELAY: "AFTER_TIMEOUT", DRAG: "ON_DRAG", ON_TAP: "ON_CLICK", CLICK: "ON_CLICK" };

export const ACTION_TYPES = ["NODE", "NAVIGATE", "CHANGE_TO", "SCROLL_TO", "OPEN_OVERLAY", "SWAP_OVERLAY", "BACK", "CLOSE", "URL", "SET_VARIABLE", "SET_VARIABLE_MODE", "CONDITIONAL", "UPDATE_MEDIA_RUNTIME", "NONE"] as const;
/** Accepted on writes for an action type (→ a NODE action with that navigation, or another type) */
export const ACTION_ALIASES: Readonly<Record<string, string>> = { OVERLAY: "OPEN_OVERLAY", SWAP: "SWAP_OVERLAY", CLOSE_OVERLAY: "CLOSE", OPEN_URL: "URL", OPEN_LINK: "URL", SWAP_STATE: "CHANGE_TO", NAVIGATE_TO: "NAVIGATE" };

export const NAVIGATIONS = ["NAVIGATE", "CHANGE_TO", "SCROLL_TO", "OVERLAY", "SWAP"] as const;
export const TRANSITION_TYPES = ["INSTANT", "DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE", "MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"] as const;
export const DIRECTIONS = ["LEFT", "RIGHT", "TOP", "BOTTOM"] as const;
export const EASING_TYPES = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER", "GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING"] as const;
export const MEDIA_ACTIONS = ["PLAY", "PAUSE", "TOGGLE_PLAY_PAUSE", "MUTE", "UNMUTE", "TOGGLE_MUTE_UNMUTE", "SKIP_FORWARD", "SKIP_BACKWARD", "SKIP_TO"] as const;
export const OVERLAY_POSITIONS = ["CENTER", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT", "MANUAL"] as const;

const vec = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } };

export const easingSchema: Obj = {
  description: 'Easing: a type name ("EASE_OUT") or {type, easingFunctionCubicBezier: {x1, y1, x2, y2} (CUSTOM_CUBIC_BEZIER), easingFunctionSpring: {mass, stiffness, damping} (CUSTOM_SPRING)}. Default EASE_OUT.',
  anyOf: [
    { enum: [...EASING_TYPES] },
    {
      type: "object",
      properties: {
        type: { enum: [...EASING_TYPES] },
        easingFunctionCubicBezier: { type: "object", properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } } },
        easingFunctionSpring: { type: "object", properties: { mass: { type: "number" }, stiffness: { type: "number" }, damping: { type: "number" }, initialVelocity: { type: "number" } } },
      },
      required: ["type"],
    },
  ],
};

export const transitionSchema: Obj = {
  description:
    'The animation (Plugin API Transition): null or "INSTANT" for none; {type: DISSOLVE | SMART_ANIMATE | SCROLL_ANIMATE, duration, easing} or {type: MOVE_IN | MOVE_OUT | PUSH | SLIDE_IN | SLIDE_OUT, direction: LEFT | RIGHT | TOP | BOTTOM (the way the layers move), matchLayers (smart animate matching layers), duration, easing}. duration in seconds (default 0.3; durationMs is read too).',
  anyOf: [
    { type: "null" },
    { enum: [...TRANSITION_TYPES] },
    {
      type: "object",
      properties: { type: { enum: [...TRANSITION_TYPES] }, direction: { enum: [...DIRECTIONS] }, matchLayers: { type: "boolean" }, duration: { type: "number" }, durationMs: { type: "number" }, easing: easingSchema },
      required: ["type"],
    },
  ],
};

export const triggerSchema: Obj = {
  description:
    'When it fires (Plugin API Trigger): {type: ON_CLICK | ON_DRAG | ON_HOVER (While hovering) | ON_PRESS (While pressing) | MOUSE_ENTER | MOUSE_LEAVE | MOUSE_DOWN | MOUSE_UP (+ delay s) | AFTER_TIMEOUT (+ timeout s, or timeoutMs) | ON_KEY_DOWN (+ keyCodes [JS keyCodes] or keys ["Shift+K", "ArrowRight"], device KEYBOARD | XBOX_ONE | PS4 | SWITCH_PRO | UNKNOWN_CONTROLLER) | ON_MEDIA_HIT (+ mediaHitTime s) | ON_MEDIA_END}. A bare type name is read too ("ON_CLICK"); WHILE_HOVERING, WHILE_PRESSING, KEY_DOWN, AFTER_DELAY are read as their Plugin API names.',
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: [...TRIGGER_TYPES, ...Object.keys(TRIGGER_ALIASES)] },
        timeout: { type: "number" },
        timeoutMs: { type: "number" },
        delay: { type: "number" },
        keyCodes: { type: "array", items: { type: "number" } },
        keys: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        device: { enum: ["KEYBOARD", "UNKNOWN_CONTROLLER", "XBOX_ONE", "PS4", "SWITCH_PRO"] },
        mediaHitTime: { type: "number" },
        deprecatedVersion: { type: "boolean" },
      },
      required: ["type"],
    },
  ],
};

export const variableDataSchema: Obj = {
  description:
    'A variable value (Plugin API VariableData): a literal (true, 3, "Hello", "#0D99FF"), {type: "VARIABLE_ALIAS", id: variableId} (or {alias: variableId}), or an expression {type: "EXPRESSION", value: {expressionFunction: ADDITION | SUBTRACTION | MULTIPLY | DIVIDE | EQUALS | NOT_EQUAL | LESS_THAN | LESS_THAN_OR_EQUAL | GREATER_THAN | GREATER_THAN_OR_EQUAL | AND | OR | NOT | NEGATE | STRINGIFY | IS_TRUTHY | TERNARY, expressionArguments: [VariableData, …]}}.',
};

export const actionSchema: Obj = {
  type: "object",
  description:
    'What happens (Plugin API Action; run top to bottom). NODE {destinationId, navigation: NAVIGATE | CHANGE_TO | SCROLL_TO | OVERLAY | SWAP, transition, preserveScrollPosition, resetScrollPosition, resetInteractiveComponents, resetVideoPosition, overlayRelativePosition {x, y}, extraScrollOffset {x, y} (SCROLL_TO), overlay {position, background ("#RRGGBBAA" or null), closeOnClickOutside} (OVERLAY / SWAP: written to the destination frame, as Figma keeps them there)}; shorthands NAVIGATE, CHANGE_TO, SCROLL_TO, OPEN_OVERLAY, SWAP_OVERLAY take the same fields without navigation. BACK, CLOSE (close overlay) {transition?}. URL {url, openInNewTab}. SET_VARIABLE {variableId (id or name), variableValue (or value)}. SET_VARIABLE_MODE {variableCollectionId (id or name), variableModeId (id or mode name)} — e.g. a language switch TR → EN. CONDITIONAL {conditionalBlocks: [{condition: VariableData (BOOLEAN), actions}, …, {actions} (else, last)]}. UPDATE_MEDIA_RUNTIME {destinationId (a video layer), mediaAction: PLAY | PAUSE | TOGGLE_PLAY_PAUSE | MUTE | UNMUTE | TOGGLE_MUTE_UNMUTE | SKIP_FORWARD | SKIP_BACKWARD | SKIP_TO, amountToSkip s, newTimestamp s}.',
  properties: {
    type: { type: "string", enum: [...ACTION_TYPES, ...Object.keys(ACTION_ALIASES)] },
    destinationId: { type: ["string", "null"] },
    navigation: { enum: [...NAVIGATIONS] },
    transition: transitionSchema,
    preserveScrollPosition: { type: "boolean" },
    resetScrollPosition: { type: "boolean" },
    resetInteractiveComponents: { type: "boolean" },
    resetVideoPosition: { type: "boolean" },
    overlayRelativePosition: vec,
    extraScrollOffset: vec,
    overlay: { type: "object", properties: { position: { enum: [...OVERLAY_POSITIONS] }, background: { type: ["string", "null"] }, closeOnClickOutside: { type: "boolean" } } },
    url: { type: "string" },
    openInNewTab: { type: "boolean" },
    variableId: { type: "string" },
    variableValue: variableDataSchema,
    value: variableDataSchema,
    variableCollectionId: { type: "string" },
    variableModeId: { type: "string" },
    conditionalBlocks: { type: "array", items: { type: "object", properties: { condition: variableDataSchema, actions: { type: "array", items: { type: "object" } } } } },
    mediaAction: { enum: [...MEDIA_ACTIONS] },
    amountToSkip: { type: "number" },
    newTimestamp: { type: "number" },
  },
  required: ["type"],
};

export const reactionSchema: Obj = {
  type: "object",
  description: "One interaction (Plugin API Reaction): a trigger and its actions. Reads add `id` and `index`; writes ignore them.",
  properties: { trigger: triggerSchema, actions: { type: "array", items: actionSchema }, action: actionSchema },
  required: ["trigger"],
};

export const deviceSchema: Obj = {
  description:
    'The page\'s prototype device: null / "NONE" (no device), "PRESENTATION", a preset id ("IPHONE_16", "IPHONE_16_PRO", "GOOGLE_PIXEL_8", "IPAD_PRO_11", "MACBOOK_AIR", "DESKTOP" …), or {type: PRESET | CUSTOM | PRESENTATION | NONE, presetIdentifier, size {x, y}, rotation NONE | CCW_90}.',
};
