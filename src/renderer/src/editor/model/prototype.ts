/**
 * The Prototype tab's model (docs/research/figma/R8-prototyping.md): the schema's prototype fields as the engine
 * reads and writes them (schema/document.kiwi "Prototyping": enums by name, GUIDs as {sessionID, localID}), Figma's
 * UI3 wording for triggers, actions, animations and easings, and the conversions between the panel's choices
 * (an animation and a direction) and the schema's single TransitionType.
 */
import type { Color, Guid } from "@/engine/codec";

export interface GuidJson {
  sessionID: number;
  localID: number;
}

export type InteractionType =
  | "ON_CLICK" | "AFTER_TIMEOUT" | "MOUSE_IN" | "MOUSE_OUT" | "ON_HOVER" | "MOUSE_DOWN" | "MOUSE_UP" | "ON_PRESS" | "NONE" | "DRAG"
  | "ON_KEY_DOWN" | "MOUSE_ENTER" | "MOUSE_LEAVE";
export type ConnectionType = "NONE" | "INTERNAL_NODE" | "URL" | "BACK" | "CLOSE" | "SET_VARIABLE" | "CONDITIONAL" | "SET_VARIABLE_MODE";
export type NavigationType = "NAVIGATE" | "OVERLAY" | "SWAP" | "SWAP_STATE" | "SCROLL_TO";
export type TransitionType =
  | "INSTANT_TRANSITION" | "DISSOLVE" | "FADE" | "SMART_ANIMATE" | "MAGIC_MOVE" | "SCROLL_ANIMATE"
  | `MOVE_FROM_${Side}` | `MOVE_OUT_TO_${Side}` | `PUSH_FROM_${Side}` | `SLIDE_FROM_${Side}` | `SLIDE_OUT_TO_${Side}`;
type Side = "LEFT" | "RIGHT" | "TOP" | "BOTTOM";
export type EasingType =
  | "IN_CUBIC" | "OUT_CUBIC" | "INOUT_CUBIC" | "LINEAR" | "IN_BACK_CUBIC" | "OUT_BACK_CUBIC" | "INOUT_BACK_CUBIC" | "CUSTOM_CUBIC"
  | "SPRING" | "GENTLE_SPRING" | "CUSTOM_SPRING" | "SPRING_PRESET_ONE" | "SPRING_PRESET_TWO" | "SPRING_PRESET_THREE" | "HOLD" | "EASE_IN";

export interface PrototypeAction {
  connectionType?: ConnectionType;
  navigationType?: NavigationType;
  transitionNodeID?: GuidJson | string;
  transitionType?: TransitionType;
  /** Seconds */
  transitionDuration?: number;
  easingType?: EasingType;
  easingFunction?: number[];
  transitionShouldSmartAnimate?: boolean;
  connectionURL?: string;
  openUrlInNewTab?: boolean;
  transitionPreserveScroll?: boolean;
  transitionResetScrollPosition?: boolean;
  transitionResetInteractiveComponents?: boolean;
  overlayRelativePosition?: { x: number; y: number };
  extraScrollOffset?: { x: number; y: number };
  targetVariable?: { id: VariableRef };
  targetVariableData?: VariableDataJson;
  targetVariableSetID?: VariableRef;
  targetVariableModeID?: GuidJson;
  conditionalActions?: { actions?: PrototypeAction[]; condition?: VariableDataJson }[];
  [other: string]: unknown;
}

export interface VariableRef {
  guid?: GuidJson;
  assetRef?: { key?: string; version?: string };
}
export interface VariableDataJson {
  value?: { boolValue?: boolean; textValue?: string; floatValue?: number; colorValue?: Color; alias?: VariableRef; [other: string]: unknown };
  dataType?: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR" | "ALIAS" | "EXPRESSION" | string;
  resolvedDataType?: string;
  [other: string]: unknown;
}

export interface PrototypeInteraction {
  id?: GuidJson | string;
  event?: {
    interactionType?: InteractionType;
    /** After delay, seconds */
    transitionTimeout?: number;
    keyTrigger?: { keyCodes?: number[]; triggerDevice?: string };
    [other: string]: unknown;
  };
  actions?: PrototypeAction[];
  isDeleted?: boolean;
  [other: string]: unknown;
}

export interface PrototypeStartingPoint {
  name?: string;
  description?: string;
  position?: string;
}

export interface PrototypeDevice {
  type?: "NONE" | "PRESET" | "CUSTOM" | "PRESENTATION";
  size?: { x: number; y: number };
  presetIdentifier?: string;
  rotation?: "NONE" | "CCW_90";
}

export type OverlayPositionType = "CENTER" | "TOP_LEFT" | "TOP_CENTER" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_CENTER" | "BOTTOM_RIGHT" | "MANUAL";
export type ScrollDirection = "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
export type ScrollBehavior = "SCROLLS" | "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" | "STICKY_SCROLLS";

/** The prototype fields of a node as the engine's reads show them. */
export interface PrototypeFields {
  prototypeInteractions?: PrototypeInteraction[];
  prototypeStartingPoint?: PrototypeStartingPoint;
  prototypeDevice?: PrototypeDevice;
  prototypeBackgroundColor?: Color;
  overlayPositionType?: OverlayPositionType;
  overlayBackgroundInteraction?: "NONE" | "CLOSE_ON_CLICK_OUTSIDE";
  overlayBackgroundAppearance?: { backgroundType?: "NONE" | "SOLID_COLOR"; backgroundColor?: Color };
  scrollDirection?: ScrollDirection;
  scrollBehavior?: ScrollBehavior;
}

// ── GUIDs ─────────────────────────────────────────────────────────────────────

export function guidOf(g: GuidJson | string | null | undefined): Guid | null {
  if (!g) return null;
  if (typeof g === "string") return g;
  return `${g.sessionID}:${g.localID}`;
}

export function guidJson(id: Guid): GuidJson {
  const [s, l] = id.split(":").map(Number);
  return { sessionID: s >>> 0, localID: l >>> 0 };
}

/** A fresh id for an interaction (unique within the file, like Figma's: session + a random local id). */
export function newInteractionId(sessionID: number, random: () => number = Math.random): GuidJson {
  return { sessionID, localID: 0x40000000 + Math.floor(random() * 0x3fffffff) };
}

// ── Wording (Figma UI3) ───────────────────────────────────────────────────────

export const TRIGGERS: { value: InteractionType; label: string }[] = [
  { value: "ON_CLICK", label: "On click" },
  { value: "DRAG", label: "On drag" },
  { value: "ON_HOVER", label: "While hovering" },
  { value: "ON_PRESS", label: "While pressing" },
  { value: "ON_KEY_DOWN", label: "Key/Gamepad" },
  { value: "MOUSE_ENTER", label: "Mouse enter" },
  { value: "MOUSE_LEAVE", label: "Mouse leave" },
  { value: "MOUSE_DOWN", label: "Mouse down" },
  { value: "MOUSE_UP", label: "Mouse up" },
  { value: "AFTER_TIMEOUT", label: "After delay" },
];

export function triggerLabel(t: InteractionType | undefined): string {
  if (t === "MOUSE_IN") return "Mouse enter";
  if (t === "MOUSE_OUT") return "Mouse leave";
  return TRIGGERS.find((x) => x.value === (t ?? "ON_CLICK"))?.label ?? "On click";
}

/** The panel's actions (one per menu entry): a connectionType, with a navigationType for node actions. */
export type ActionKind =
  | "NAVIGATE" | "CHANGE_TO" | "BACK" | "SCROLL_TO" | "URL" | "OVERLAY" | "SWAP" | "CLOSE" | "SET_VARIABLE" | "SET_VARIABLE_MODE"
  | "CONDITIONAL" | "NONE";

export const ACTIONS: ({ value: ActionKind; label: string } | "-")[] = [
  { value: "NAVIGATE", label: "Navigate to" },
  { value: "CHANGE_TO", label: "Change to" },
  { value: "BACK", label: "Back" },
  { value: "SCROLL_TO", label: "Scroll to" },
  { value: "URL", label: "Open link" },
  "-",
  { value: "OVERLAY", label: "Open overlay" },
  { value: "SWAP", label: "Swap overlay" },
  { value: "CLOSE", label: "Close overlay" },
  "-",
  { value: "SET_VARIABLE", label: "Set variable" },
  { value: "SET_VARIABLE_MODE", label: "Set variable mode" },
  { value: "CONDITIONAL", label: "Conditional" },
];

export function actionKind(a: PrototypeAction | undefined): ActionKind {
  if (!a) return "NONE";
  switch (a.connectionType) {
    case "INTERNAL_NODE":
      switch (a.navigationType ?? "NAVIGATE") {
        case "NAVIGATE": return "NAVIGATE";
        case "OVERLAY": return "OVERLAY";
        case "SWAP": return "SWAP";
        case "SWAP_STATE": return "CHANGE_TO";
        case "SCROLL_TO": return "SCROLL_TO";
      }
      return "NAVIGATE";
    case "URL": return "URL";
    case "BACK": return "BACK";
    case "CLOSE": return "CLOSE";
    case "SET_VARIABLE": return "SET_VARIABLE";
    case "SET_VARIABLE_MODE": return "SET_VARIABLE_MODE";
    case "CONDITIONAL": return "CONDITIONAL";
    default: return "NONE";
  }
}

export function actionLabel(k: ActionKind): string {
  if (k === "NONE") return "None";
  for (const a of ACTIONS) if (a !== "-" && a.value === k) return a.label;
  return "None";
}

/** Whether an action takes a destination layer. */
export const takesDestination = (k: ActionKind): boolean => k === "NAVIGATE" || k === "CHANGE_TO" || k === "SCROLL_TO" || k === "OVERLAY" || k === "SWAP";
/** Whether an action animates (Back and Close overlay animate too: their own transition). */
export const animates = (k: ActionKind): boolean => k === "NAVIGATE" || k === "CHANGE_TO" || k === "OVERLAY" || k === "SWAP" || k === "CLOSE" || k === "SCROLL_TO";

/** An action of kind `k`, keeping what still applies from `prev` (destination, animation). */
export function actionOfKind(k: ActionKind, prev: PrototypeAction = {}): PrototypeAction {
  const keep: PrototypeAction = {
    transitionType: prev.transitionType ?? "INSTANT_TRANSITION",
    transitionDuration: prev.transitionDuration ?? 0.3,
    easingType: prev.easingType ?? "OUT_CUBIC",
    ...(prev.easingFunction ? { easingFunction: prev.easingFunction } : {}),
  };
  const node = (navigationType: NavigationType): PrototypeAction => ({
    connectionType: "INTERNAL_NODE",
    navigationType,
    ...(prev.transitionNodeID && takesDestination(actionKind(prev)) ? { transitionNodeID: prev.transitionNodeID } : {}),
    ...keep,
  });
  switch (k) {
    case "NAVIGATE": return node("NAVIGATE");
    case "CHANGE_TO": {
      const a = node("SWAP_STATE");
      delete a.transitionNodeID;  // a variant, not a frame
      return a;
    }
    case "SCROLL_TO": {
      const a = node("SCROLL_TO");
      delete a.transitionNodeID;
      return a;
    }
    case "OVERLAY": return node("OVERLAY");
    case "SWAP": return node("SWAP");
    case "URL": return { connectionType: "URL", connectionURL: prev.connectionURL ?? "", openUrlInNewTab: true };
    case "BACK": return { connectionType: "BACK", ...keep };
    case "CLOSE": return { connectionType: "CLOSE", ...keep };
    case "SET_VARIABLE": return { connectionType: "SET_VARIABLE" };
    case "SET_VARIABLE_MODE": return { connectionType: "SET_VARIABLE_MODE" };
    case "CONDITIONAL": return { connectionType: "CONDITIONAL", conditionalActions: [{ actions: [] }, { actions: [] }] };
    default: return { connectionType: "NONE" };
  }
}

// ── Animation ────────────────────────────────────────────────────────────────

export type Animation = "INSTANT" | "DISSOLVE" | "SMART_ANIMATE" | "MOVE_IN" | "MOVE_OUT" | "PUSH" | "SLIDE_IN" | "SLIDE_OUT";
/** Which way the layers move, as the panel's arrows show it. */
export type Direction = "LEFT" | "RIGHT" | "UP" | "DOWN";

export const ANIMATIONS: { value: Animation; label: string }[] = [
  { value: "INSTANT", label: "Instant" },
  { value: "DISSOLVE", label: "Dissolve" },
  { value: "SMART_ANIMATE", label: "Smart animate" },
  { value: "MOVE_IN", label: "Move in" },
  { value: "MOVE_OUT", label: "Move out" },
  { value: "PUSH", label: "Push" },
  { value: "SLIDE_IN", label: "Slide in" },
  { value: "SLIDE_OUT", label: "Slide out" },
];

export const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "LEFT", label: "Left" },
  { value: "RIGHT", label: "Right" },
  { value: "UP", label: "Up" },
  { value: "DOWN", label: "Down" },
];

export const isDirectional = (a: Animation): boolean => a === "MOVE_IN" || a === "MOVE_OUT" || a === "PUSH" || a === "SLIDE_IN" || a === "SLIDE_OUT";

// Incoming screens (Move in, Push, Slide in) come FROM the side opposite to where they move; outgoing ones (Move out,
// Slide out) go TO the side they move to.
const OPPOSITE: Record<Direction, Side> = { LEFT: "RIGHT", RIGHT: "LEFT", UP: "BOTTOM", DOWN: "TOP" };
const TOWARDS: Record<Direction, Side> = { LEFT: "LEFT", RIGHT: "RIGHT", UP: "TOP", DOWN: "BOTTOM" };

export function transitionOf(animation: Animation, direction: Direction = "LEFT"): TransitionType {
  switch (animation) {
    case "INSTANT": return "INSTANT_TRANSITION";
    case "DISSOLVE": return "DISSOLVE";
    case "SMART_ANIMATE": return "SMART_ANIMATE";
    case "MOVE_IN": return `MOVE_FROM_${OPPOSITE[direction]}`;
    case "PUSH": return `PUSH_FROM_${OPPOSITE[direction]}`;
    case "SLIDE_IN": return `SLIDE_FROM_${OPPOSITE[direction]}`;
    case "MOVE_OUT": return `MOVE_OUT_TO_${TOWARDS[direction]}`;
    case "SLIDE_OUT": return `SLIDE_OUT_TO_${TOWARDS[direction]}`;
  }
}

export function animationOf(t: TransitionType | undefined): { animation: Animation; direction: Direction } {
  const fromSide = (s: string): Direction => (s === "RIGHT" ? "LEFT" : s === "LEFT" ? "RIGHT" : s === "BOTTOM" ? "UP" : "DOWN");
  const toSide = (s: string): Direction => (s === "LEFT" ? "LEFT" : s === "RIGHT" ? "RIGHT" : s === "TOP" ? "UP" : "DOWN");
  if (!t || t === "INSTANT_TRANSITION") return { animation: "INSTANT", direction: "LEFT" };
  if (t === "DISSOLVE" || t === "FADE" || t === "SCROLL_ANIMATE") return { animation: "DISSOLVE", direction: "LEFT" };
  if (t === "SMART_ANIMATE" || t === "MAGIC_MOVE") return { animation: "SMART_ANIMATE", direction: "LEFT" };
  let m = /^MOVE_FROM_(\w+)$/.exec(t);
  if (m) return { animation: "MOVE_IN", direction: fromSide(m[1]) };
  m = /^PUSH_FROM_(\w+)$/.exec(t);
  if (m) return { animation: "PUSH", direction: fromSide(m[1]) };
  m = /^SLIDE_FROM_(\w+)$/.exec(t);
  if (m) return { animation: "SLIDE_IN", direction: fromSide(m[1]) };
  m = /^MOVE_OUT_TO_(\w+)$/.exec(t);
  if (m) return { animation: "MOVE_OUT", direction: toSide(m[1]) };
  m = /^SLIDE_OUT_TO_(\w+)$/.exec(t);
  if (m) return { animation: "SLIDE_OUT", direction: toSide(m[1]) };
  return { animation: "INSTANT", direction: "LEFT" };
}

export const EASINGS: ({ value: EasingType; label: string } | "-")[] = [
  { value: "LINEAR", label: "Linear" },
  { value: "IN_CUBIC", label: "Ease in" },
  { value: "OUT_CUBIC", label: "Ease out" },
  { value: "INOUT_CUBIC", label: "Ease in and out" },
  { value: "IN_BACK_CUBIC", label: "Ease in back" },
  { value: "OUT_BACK_CUBIC", label: "Ease out back" },
  { value: "INOUT_BACK_CUBIC", label: "Ease in and out back" },
  { value: "CUSTOM_CUBIC", label: "Custom bezier" },
  "-",
  { value: "GENTLE_SPRING", label: "Gentle" },
  { value: "SPRING_PRESET_ONE", label: "Quick" },
  { value: "SPRING_PRESET_TWO", label: "Bouncy" },
  { value: "SPRING_PRESET_THREE", label: "Slow" },
  { value: "CUSTOM_SPRING", label: "Custom spring" },
];

export const isSpring = (e: EasingType | undefined): boolean =>
  e === "SPRING" || e === "GENTLE_SPRING" || e === "CUSTOM_SPRING" || e === "SPRING_PRESET_ONE" || e === "SPRING_PRESET_TWO" || e === "SPRING_PRESET_THREE";

export function easingLabel(e: EasingType | undefined): string {
  if (e === "SPRING") return "Gentle";
  if (e === "EASE_IN") return "Ease in";
  for (const x of EASINGS) if (x !== "-" && x.value === (e ?? "OUT_CUBIC")) return x.label;
  return "Ease out";
}

/** Custom bezier / spring defaults when picked (Figma: the curve of the easing chosen before, a gentle spring). */
export function easingFunctionFor(e: EasingType): number[] | undefined {
  if (e === "CUSTOM_CUBIC") return [0.42, 0, 0.58, 1];
  if (e === "CUSTOM_SPRING") return [1, 100, 15, 0];
  return undefined;
}

// ── Keys (Key/Gamepad) ────────────────────────────────────────────────────────

const MODIFIER_CODES: [number, string][] = [
  [17, "⌃"],
  [18, "⌥"],
  [16, "⇧"],
  [91, "⌘"],
];
const NAMED_KEYS: Record<number, string> = {
  8: "⌫", 9: "⇥", 13: "↩", 27: "Esc", 32: "Space", 37: "←", 38: "↑", 39: "→", 40: "↓", 46: "⌦",
  186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'",
};

/** A key trigger as Figma shows it ("⇧K"): modifiers first, in the Mac order. */
export function keyTriggerLabel(codes: readonly number[] | undefined): string {
  if (!codes || codes.length === 0) return "";
  let out = "";
  for (const [code, glyph] of MODIFIER_CODES) if (codes.includes(code)) out += glyph;
  for (const c of codes) {
    if (MODIFIER_CODES.some(([m]) => m === c) || c === 93) continue;
    if (NAMED_KEYS[c]) out += NAMED_KEYS[c];
    else if (c >= 112 && c <= 123) out += `F${c - 111}`;
    else if (c >= 96 && c <= 105) out += String(c - 96);
    else out += String.fromCharCode(c);
  }
  return out;
}

/** A keydown as a key trigger's codes (the modifiers held, then the key). */
export function keyTriggerOf(e: Pick<KeyboardEvent, "keyCode" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): number[] {
  const codes: number[] = [];
  if (e.ctrlKey && e.keyCode !== 17) codes.push(17);
  if (e.altKey && e.keyCode !== 18) codes.push(18);
  if (e.shiftKey && e.keyCode !== 16) codes.push(16);
  if (e.metaKey && e.keyCode !== 91 && e.keyCode !== 93) codes.push(91);
  codes.push(e.keyCode);
  return codes;
}

// ── Interactions ─────────────────────────────────────────────────────────────

/** The live interactions of a node (Figma's tombstones left out). */
export function liveInteractions(list: readonly PrototypeInteraction[] | undefined): PrototypeInteraction[] {
  return (list ?? []).filter((i) => !i.isDeleted);
}

/** "+" in Interactions: On click, Navigate to nothing yet, Instant (Figma's defaults). */
export function newInteraction(id: GuidJson, dest?: Guid): PrototypeInteraction {
  return {
    id,
    event: { interactionType: "ON_CLICK" },
    actions: [
      {
        connectionType: "INTERNAL_NODE",
        navigationType: "NAVIGATE",
        ...(dest ? { transitionNodeID: guidJson(dest) } : {}),
        transitionType: "INSTANT_TRANSITION",
        transitionDuration: 0.3,
        easingType: "OUT_CUBIC",
      },
    ],
  };
}

/** An interaction with its trigger changed (the event's other fields kept where they still mean something). */
export function withTrigger(i: PrototypeInteraction, t: InteractionType): PrototypeInteraction {
  const event: NonNullable<PrototypeInteraction["event"]> = { ...(i.event ?? {}), interactionType: t };
  if (t === "AFTER_TIMEOUT") event.transitionTimeout = i.event?.transitionTimeout ?? 0.8;
  else delete event.transitionTimeout;
  if (t !== "ON_KEY_DOWN") delete event.keyTrigger;
  return { ...i, event };
}

/** The row text of an interaction: its trigger, and what its first action does (with the destination's name). */
export function interactionSummary(i: PrototypeInteraction, nameOf: (id: Guid) => string | null): { trigger: string; action: string } {
  let trigger = triggerLabel(i.event?.interactionType);
  if (i.event?.interactionType === "ON_KEY_DOWN") {
    const key = keyTriggerLabel(i.event.keyTrigger?.keyCodes);
    if (key) trigger = `Key ${key}`;
  }
  if (i.event?.interactionType === "AFTER_TIMEOUT") trigger = `After ${Math.round((i.event.transitionTimeout ?? 0.8) * 1000)}ms`;
  const a = i.actions?.[0];
  const k = actionKind(a);
  let action = actionLabel(k);
  if (a && takesDestination(k)) {
    const dest = guidOf(a.transitionNodeID);
    action = dest ? (nameOf(dest) ?? "None") : "None";
    if (k === "OVERLAY") action = dest ? `Open ${nameOf(dest) ?? "overlay"}` : "Open overlay";
  } else if (k === "URL") {
    action = a?.connectionURL || "Open link";
  }
  if ((i.actions?.length ?? 0) > 1) action += ` +${(i.actions?.length ?? 1) - 1}`;
  return { trigger, action };
}

// ── Device ───────────────────────────────────────────────────────────────────

/**
 * Figma's device presets for prototypes (a subset: the common ones), [id, label, width, height] in portrait. The
 * engine draws each one's device frame (engine/src/proto/Devices.cpp — the same ids and models).
 */
export const DEVICE_PRESETS: { header: string; items: [string, string, number, number][] }[] = [
  {
    header: "Phone",
    items: [
      ["IPHONE_16", "iPhone 16", 393, 852],
      ["IPHONE_16_PLUS", "iPhone 16 Plus", 430, 932],
      ["IPHONE_16_PRO", "iPhone 16 Pro", 402, 874],
      ["IPHONE_16_PRO_MAX", "iPhone 16 Pro Max", 440, 956],
      ["IPHONE_15", "iPhone 15", 393, 852],
      ["IPHONE_15_PRO", "iPhone 15 Pro", 393, 852],
      ["IPHONE_15_PRO_MAX", "iPhone 15 Pro Max", 430, 932],
      ["IPHONE_SE", "iPhone SE", 375, 667],
      ["ANDROID_COMPACT", "Android Compact", 412, 917],
      ["ANDROID_MEDIUM", "Android Medium", 700, 840],
      ["GOOGLE_PIXEL_8", "Google Pixel 8", 412, 915],
      ["SAMSUNG_GALAXY_S24", "Samsung Galaxy S24", 384, 832],
    ],
  },
  {
    header: "Tablet",
    items: [
      ["IPAD_MINI", "iPad mini 8.3", 744, 1133],
      ["IPAD_PRO_11", "iPad Pro 11\"", 834, 1194],
      ["IPAD_PRO_13", "iPad Pro 12.9\"", 1024, 1366],
      ["SURFACE_PRO_8", "Surface Pro 8", 1440, 960],
    ],
  },
  {
    header: "Desktop",
    items: [
      ["MACBOOK_AIR", "MacBook Air", 1280, 832],
      ["MACBOOK_PRO_14", "MacBook Pro 14\"", 1512, 982],
      ["MACBOOK_PRO_16", "MacBook Pro 16\"", 1728, 1117],
      ["DESKTOP", "Desktop", 1440, 1024],
    ],
  },
  { header: "Watch", items: [["APPLE_WATCH", "Apple Watch Series 10 46mm", 208, 248]] },
];

/** Each preset's models (its colours; help: "the iPhone 15 Pro Max comes in four different colors"), the first the default. */
const IPHONE_16_MODELS = [["BLACK", "Black"], ["WHITE", "White"], ["PINK", "Pink"], ["TEAL", "Teal"], ["ULTRAMARINE", "Ultramarine"]] as const;
const IPHONE_16_PRO_MODELS = [["BLACK_TITANIUM", "Black Titanium"], ["WHITE_TITANIUM", "White Titanium"], ["NATURAL_TITANIUM", "Natural Titanium"], ["DESERT_TITANIUM", "Desert Titanium"]] as const;
const IPHONE_15_MODELS = [["BLACK", "Black"], ["BLUE", "Blue"], ["GREEN", "Green"], ["YELLOW", "Yellow"], ["PINK", "Pink"]] as const;
const IPHONE_15_PRO_MODELS = [["BLACK_TITANIUM", "Black Titanium"], ["WHITE_TITANIUM", "White Titanium"], ["BLUE_TITANIUM", "Blue Titanium"], ["NATURAL_TITANIUM", "Natural Titanium"]] as const;
const IPAD_PRO_MODELS = [["SPACE_BLACK", "Space Black"], ["SILVER", "Silver"]] as const;
export const DEVICE_MODELS: Record<string, readonly (readonly [string, string])[]> = {
  IPHONE_16: IPHONE_16_MODELS,
  IPHONE_16_PLUS: IPHONE_16_MODELS,
  IPHONE_16_PRO: IPHONE_16_PRO_MODELS,
  IPHONE_16_PRO_MAX: IPHONE_16_PRO_MODELS,
  IPHONE_15: IPHONE_15_MODELS,
  IPHONE_15_PRO: IPHONE_15_PRO_MODELS,
  IPHONE_15_PRO_MAX: IPHONE_15_PRO_MODELS,
  IPHONE_SE: [["MIDNIGHT", "Midnight"], ["STARLIGHT", "Starlight"], ["PRODUCT_RED", "(PRODUCT)RED"]],
  ANDROID_COMPACT: [["BLACK", "Black"]],
  ANDROID_MEDIUM: [["BLACK", "Black"]],
  GOOGLE_PIXEL_8: [["OBSIDIAN", "Obsidian"], ["HAZEL", "Hazel"], ["ROSE", "Rose"], ["MINT", "Mint"]],
  SAMSUNG_GALAXY_S24: [["ONYX_BLACK", "Onyx Black"], ["MARBLE_GREY", "Marble Grey"], ["COBALT_VIOLET", "Cobalt Violet"], ["AMBER_YELLOW", "Amber Yellow"]],
  IPAD_MINI: [["SPACE_GRAY", "Space Gray"], ["BLUE", "Blue"], ["PURPLE", "Purple"], ["STARLIGHT", "Starlight"]],
  IPAD_PRO_11: IPAD_PRO_MODELS,
  IPAD_PRO_13: IPAD_PRO_MODELS,
  SURFACE_PRO_8: [["PLATINUM", "Platinum"], ["GRAPHITE", "Graphite"]],
  MACBOOK_AIR: [["MIDNIGHT", "Midnight"], ["STARLIGHT", "Starlight"], ["SPACE_GRAY", "Space Gray"], ["SILVER", "Silver"]],
  MACBOOK_PRO_14: [["SPACE_BLACK", "Space Black"], ["SILVER", "Silver"]],
  MACBOOK_PRO_16: [["SPACE_BLACK", "Space Black"], ["SILVER", "Silver"]],
  DESKTOP: [["BLACK", "Black"]],
  APPLE_WATCH: [["JET_BLACK", "Jet Black"], ["ROSE_GOLD", "Rose Gold"], ["SILVER", "Silver"]],
};

/**
 * A presetIdentifier's preset and model: `<DEVICE>` or `<DEVICE>_<MODEL>` (ours — Figma's identifiers aren't
 * published), the longest preset id that starts it; no model: the preset's first.
 */
export function deviceOf(presetIdentifier: string | undefined): { preset: [string, string, number, number]; model: string } | null {
  if (!presetIdentifier) return null;
  let best: [string, string, number, number] | null = null;
  for (const g of DEVICE_PRESETS)
    for (const p of g.items)
      if ((presetIdentifier === p[0] || presetIdentifier.startsWith(`${p[0]}_`)) && (!best || p[0].length > best[0].length)) {
        const rest = presetIdentifier.slice(p[0].length + 1);
        if (!rest || DEVICE_MODELS[p[0]]?.some(([m]) => m === rest)) best = p;
      }
  if (!best) return null;
  const rest = presetIdentifier.slice(best[0].length + 1);
  return { preset: best, model: rest || DEVICE_MODELS[best[0]]?.[0]?.[0] || "" };
}

/** The presetIdentifier of a preset in a model (the first model: the preset's id alone). */
export function presetIdentifierOf(preset: string, model: string): string {
  const first = DEVICE_MODELS[preset]?.[0]?.[0];
  return !model || model === first ? preset : `${preset}_${model}`;
}

export function devicePreset(id: string | undefined): [string, string, number, number] | null {
  return deviceOf(id)?.preset ?? null;
}

export function deviceLabel(d: PrototypeDevice | undefined): string {
  if (!d || d.type === "NONE" || !d.type) return "No device";
  if (d.type === "PRESENTATION") return "Presentation";
  const p = devicePreset(d.presetIdentifier);
  if (p) return p[1];
  return d.size ? `Custom size ${Math.round(d.size.x)}×${Math.round(d.size.y)}` : "Custom size";
}

export const OVERLAY_POSITIONS: { value: OverlayPositionType; label: string }[] = [
  { value: "CENTER", label: "Centered" },
  { value: "TOP_LEFT", label: "Top left" },
  { value: "TOP_CENTER", label: "Top center" },
  { value: "TOP_RIGHT", label: "Top right" },
  { value: "BOTTOM_LEFT", label: "Bottom left" },
  { value: "BOTTOM_CENTER", label: "Bottom center" },
  { value: "BOTTOM_RIGHT", label: "Bottom right" },
  { value: "MANUAL", label: "Manual" },
];

export const OVERFLOWS: { value: ScrollDirection; label: string }[] = [
  { value: "NONE", label: "No scrolling" },
  { value: "HORIZONTAL", label: "Horizontal" },
  { value: "VERTICAL", label: "Vertical" },
  { value: "BOTH", label: "Both directions" },
];

export const SCROLL_POSITIONS: { value: ScrollBehavior; label: string }[] = [
  { value: "SCROLLS", label: "Scroll with parent" },
  { value: "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME", label: "Fixed" },
  { value: "STICKY_SCROLLS", label: "Sticky" },
];

/** A new flow's name: "Flow N", N one more than the flows there are (skipping names taken). */
export function nextFlowName(existing: readonly string[]): string {
  let n = existing.length + 1;
  while (existing.includes(`Flow ${n}`)) n++;
  return `Flow ${n}`;
}
