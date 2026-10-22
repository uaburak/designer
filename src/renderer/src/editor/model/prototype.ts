/**
 * The Prototype tab's model (docs/research/figma/R8-prototyping.md): the schema's prototype fields as the engine
 * reads and writes them (schema/document.kiwi "Prototyping": enums by name, GUIDs as {sessionID, localID}), Figma's
 * UI3 wording for triggers, actions, animations and easings, and the conversions between the panel's choices
 * (an animation and a direction) and the schema's single TransitionType.
 */
import { t as tr } from "@/i18n";
import type { Color, Guid } from "@/engine/codec";
import type { IconName } from "@/ds";
import type { MotionEasing } from "@shared/motion/types";

export interface GuidJson {
  sessionID: number;
  localID: number;
}

export type InteractionType =
  | "ON_CLICK" | "AFTER_TIMEOUT" | "MOUSE_IN" | "MOUSE_OUT" | "ON_HOVER" | "MOUSE_DOWN" | "MOUSE_UP" | "ON_PRESS" | "NONE" | "DRAG"
  | "ON_KEY_DOWN" | "ON_MEDIA_HIT" | "ON_MEDIA_END" | "MOUSE_ENTER" | "MOUSE_LEAVE";
export type ConnectionType = "NONE" | "INTERNAL_NODE" | "URL" | "BACK" | "CLOSE" | "SET_VARIABLE" | "UPDATE_MEDIA_RUNTIME" | "CONDITIONAL" | "SET_VARIABLE_MODE";
/** UPDATE_MEDIA_RUNTIME's action (schema MediaAction). */
export type MediaAction = "PLAY" | "PAUSE" | "TOGGLE_PLAY_PAUSE" | "MUTE" | "UNMUTE" | "TOGGLE_MUTE_UNMUTE" | "SKIP_FORWARD" | "SKIP_BACKWARD" | "SKIP_TO";
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
  /** "Reset video state" */
  transitionResetVideoPosition?: boolean;
  /** UPDATE_MEDIA_RUNTIME: what it does to the video `transitionNodeID` */
  mediaAction?: MediaAction;
  /** SKIP_TO: seconds */
  mediaSkipToTime?: number;
  /** SKIP_FORWARD / SKIP_BACKWARD: seconds */
  mediaSkipByAmount?: number;
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
    /** After delay, seconds (missing or 0 reads 0.8, as Figma's) */
    transitionTimeout?: number;
    /** Mouse enter / leave / down / up: the trigger waits `interactionDuration` (Figma's placement of their delay) */
    interactionMaintained?: boolean;
    /** Mouse triggers' delay, seconds (with interactionMaintained) */
    interactionDuration?: number;
    keyTrigger?: { keyCodes?: number[]; triggerDevice?: string };
    /** ON_MEDIA_HIT: the video's time, seconds */
    mediaHitTime?: number;
    [other: string]: unknown;
  };
  actions?: PrototypeAction[];
  isDeleted?: boolean;
  /** Figma writes 1 on every new interaction */
  stateManagementVersion?: number;
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

/**
 * "No device", written as Figma's own value (type NONE) — never by clearing the field: a cleared field is no change in
 * the NODE_CHANGES the journal, undo's peers and a kept presentation receive (kiwi has no "absent"), so the device came
 * back on the file's next opening and stayed in a presentation kept open.
 */
export const NO_DEVICE: PrototypeDevice = { type: "NONE", rotation: "NONE" };

export type OverlayPositionType = "CENTER" | "TOP_LEFT" | "TOP_CENTER" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_CENTER" | "BOTTOM_RIGHT" | "MANUAL";
/** Wecra's overlay "Fit to window" (NodeChange.overlayFitWindow, @ours: never in a .fig export; docs/engine.md §3.4). */
export type OverlayFitWindow = "NONE" | "WIDTH" | "HEIGHT" | "BOTH";
/** Wecra's overlay "Keep in window" (NodeChange.overlayEdgeBehavior, @ours): a Manual overlay follows its hotspot, flips
 *  and shifts into the window (AUTO, also when absent), only follows it (FOLLOW_ONLY), or stays where Figma puts it. */
export type OverlayEdgeBehavior = "AUTO" | "NONE" | "FOLLOW_ONLY";
/** Wecra's overlay "Stack" (NodeChange.overlayStack, @ours): toasts at one preset position, `gap` apart, at most `max`. */
export interface OverlayStack {
  gap?: number;
  max?: number;
}
export type ScrollDirection = "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
/** Wecra's Prototype › Text input (NodeChange.prototypeTextInput, @ours: never in a .fig export; docs/engine.md §3.4). */
export type TextInputType = "TEXT" | "PASSWORD" | "EMAIL" | "NUMBER" | "MULTI_LINE";
export interface PrototypeTextInput {
  type?: TextInputType;
  /** UTF-16 units; 0 or absent: no limit */
  maxLength?: number;
}
/** Wecra's Prototype › Cursor (NodeChange.prototypeCursor, @ours): the pointer over the layer while presented. */
export type PrototypeCursor = "AUTO" | "DEFAULT" | "POINTER" | "TEXT" | "GRAB" | "MOVE" | "NOT_ALLOWED" | "HELP" | "ZOOM_IN" | "ZOOM_OUT" | "CROSSHAIR" | "NONE";
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
  /** Wecra-only: the overlay's sides that take the window's size while presented (absent: None) */
  overlayFitWindow?: OverlayFitWindow;
  /** Wecra-only: Keep in window (absent: on) */
  overlayEdgeBehavior?: OverlayEdgeBehavior;
  /** Wecra-only: Stack (absent: off) */
  overlayStack?: OverlayStack;
  scrollDirection?: ScrollDirection;
  scrollBehavior?: ScrollBehavior;
  /** Prototype › Video (absent: all off) */
  videoPlayback?: VideoPlayback;
  /** Wecra-only: a text layer typed into while presented (absent: not an input) */
  prototypeTextInput?: PrototypeTextInput;
  /** Wecra-only: the cursor over the layer while presented (absent: Auto) */
  prototypeCursor?: PrototypeCursor;
}

/** Prototype › Video (schema VideoPlayback): Autoplay, Loop, the sound (muted). */
export interface VideoPlayback {
  autoplay?: boolean;
  mediaLoop?: boolean;
  muted?: boolean;
  showControls?: boolean;
  startTimeMs?: number;
  endTimeMs?: number;
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

/** The video triggers, offered on a video (help: "available for any connection that begins on a video"). */
export const VIDEO_TRIGGERS: { value: InteractionType; label: string }[] = [
  { value: "ON_MEDIA_HIT", label: "When video hits" },
  { value: "ON_MEDIA_END", label: "When video ends" },
];

export function triggerLabel(t: InteractionType | undefined): string {
  if (t === "MOUSE_IN") return "Mouse enter";
  if (t === "MOUSE_OUT") return "Mouse leave";
  return [...TRIGGERS, ...VIDEO_TRIGGERS].find((x) => x.value === (t ?? "ON_CLICK"))?.label ?? "On click";
}

/** A video time as Figma's fields show it: m:ss (seconds with a fraction when there is one). */
export function formatMediaTime(seconds: number | undefined): string {
  const t = Math.max(0, seconds ?? 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${m}:${ss}`;
}

/** "1:05", "65", "65.5", "0:03.5" → seconds; null when it isn't a time. */
export function parseMediaTime(text: string): number | null {
  const t = text.trim();
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

/** The panel's actions (one per menu entry): a connectionType, with a navigationType for node actions. */
export type ActionKind =
  | "NAVIGATE" | "CHANGE_TO" | "BACK" | "SCROLL_TO" | "URL" | "OVERLAY" | "SWAP" | "CLOSE" | "SET_VARIABLE" | "SET_VARIABLE_MODE"
  | "CONDITIONAL" | "VIDEO_PLAY" | "VIDEO_SOUND" | "VIDEO_SET_TIME" | "VIDEO_JUMP" | "NONE";

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

/**
 * The video actions (help.figma.com 360040035874), offered "for any interaction that ends on a video": one entry each,
 * the choice inside it (Play video / Pause video / Toggle play/pause, …) a second menu.
 */
export const VIDEO_ACTIONS: { value: ActionKind; label: string }[] = [
  { value: "VIDEO_PLAY", label: "Play/pause video" },
  { value: "VIDEO_SOUND", label: "Mute/unmute video" },
  { value: "VIDEO_SET_TIME", label: "Set to specific time" },
  { value: "VIDEO_JUMP", label: "Jump forward/backward in time" },
];

/**
 * Each trigger's and action's glyph (24, Figma's own, read from live Figma's Trigger / Action lists and interaction
 * rows on 2026-10-10; the owner's 83–84.png). The video ones are unverified (live had no video).
 */
export const TRIGGER_ICON: Record<InteractionType, IconName> = {
  NONE: "24.proto.none",
  ON_CLICK: "24.proto.click",
  DRAG: "24.proto.drag",
  ON_HOVER: "24.proto.hover",
  ON_PRESS: "24.proto.press",
  ON_KEY_DOWN: "24.proto.key",
  MOUSE_ENTER: "24.proto.mouse.enter",
  MOUSE_IN: "24.proto.mouse.enter",
  MOUSE_LEAVE: "24.proto.mouse.leave",
  MOUSE_OUT: "24.proto.mouse.leave",
  MOUSE_DOWN: "24.proto.mouse.down",
  MOUSE_UP: "24.proto.mouse.up",
  AFTER_TIMEOUT: "24.proto.delay",
  ON_MEDIA_HIT: "24.proto.animation.play",
  ON_MEDIA_END: "24.proto.animation.play",
};
export const ACTION_ICON: Record<ActionKind, IconName> = {
  NONE: "24.proto.none",
  NAVIGATE: "24.proto.navigate",
  CHANGE_TO: "24.proto.change.to",
  BACK: "24.proto.back",
  SCROLL_TO: "24.proto.scroll.to",
  URL: "24.proto.link",
  SET_VARIABLE: "24.proto.set.variable",
  SET_VARIABLE_MODE: "24.proto.set.variable.mode",
  CONDITIONAL: "24.proto.conditional",
  OVERLAY: "24.proto.overlay.open",
  SWAP: "24.proto.overlay.swap",
  CLOSE: "24.proto.overlay.close",
  VIDEO_PLAY: "24.proto.animation.play",
  VIDEO_SOUND: "24.proto.animation.play",
  VIDEO_SET_TIME: "24.proto.playhead",
  VIDEO_JUMP: "24.proto.playhead",
};

type MenuEntry = { value: string; label: string; icon: IconName; disabled?: boolean } | "-";

/**
 * Interaction details' Trigger list as live (84.png; live 2026-10-10: 166 wide, rows 24, groups 15 apart): None |
 * On click, On drag, While hovering, While pressing, Key/Gamepad | Mouse enter, Mouse leave, Mouse down, Mouse up |
 * After delay — each with its glyph; on a video the video triggers after (unverified).
 */
export function triggerMenu(video: boolean, disabled: ReadonlySet<InteractionType> = new Set()): MenuEntry[] {
  const t = (v: InteractionType): MenuEntry => ({ value: v, label: triggerLabel(v), icon: TRIGGER_ICON[v], ...(disabled.has(v) ? { disabled: true } : {}) });
  return [
    { value: "NONE", label: "None", icon: TRIGGER_ICON.NONE },
    "-",
    t("ON_CLICK"), t("DRAG"), t("ON_HOVER"), t("ON_PRESS"), t("ON_KEY_DOWN"),
    "-",
    t("MOUSE_ENTER"), t("MOUSE_LEAVE"), t("MOUSE_DOWN"), t("MOUSE_UP"),
    "-",
    t("AFTER_TIMEOUT"),
    ...(video ? ["-" as const, t("ON_MEDIA_HIT"), t("ON_MEDIA_END")] : []),
  ];
}

/**
 * A trigger's identity on a layer (atlas 13 §3.2, figma_app 821376): mouse triggers with whether they wait, keys with
 * their device and codes, After delay with its delay, the others by type.
 */
export function triggerIdentity(e: PrototypeInteraction["event"]): string {
  const type = e?.interactionType === "MOUSE_IN" ? "MOUSE_ENTER" : e?.interactionType === "MOUSE_OUT" ? "MOUSE_LEAVE" : (e?.interactionType ?? "ON_CLICK");
  if (takesDelay(type)) return `${type}:${mouseDelayOf(e) > 0}`;
  if (type === "ON_KEY_DOWN") return `${type}:${e?.keyTrigger?.triggerDevice ?? "KEYBOARD"}:${[...(e?.keyTrigger?.keyCodes ?? [])].sort((a, b) => a - b).join(",")}`;
  if (type === "AFTER_TIMEOUT") return `${type}:${e?.transitionTimeout || 0.8}`;
  return type;
}

/** Every action of an interaction, those inside its Conditional's blocks too. */
function allActions(actions: readonly PrototypeAction[] | undefined): PrototypeAction[] {
  return (actions ?? []).flatMap((a) => [a, ...(a.conditionalActions ?? []).flatMap((b) => allActions(b.actions))]);
}

/**
 * The triggers the Trigger list disables for `interaction` (atlas 13 §3.2, Figma's `eI`): one another interaction of
 * the layer uses (Key/Gamepad, On drag and When video hits may repeat; After delay never disabled); with Open link
 * only On click and Mouse up; with a video action no While hovering, While pressing or On drag; a lone Back no While
 * hovering or While pressing.
 */
export function disabledTriggers(interaction: PrototypeInteraction, others: readonly PrototypeInteraction[]): Set<InteractionType> {
  const out = new Set<InteractionType>();
  const all: InteractionType[] = ["ON_CLICK", "DRAG", "ON_HOVER", "ON_PRESS", "ON_KEY_DOWN", "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_DOWN", "MOUSE_UP", "ON_MEDIA_HIT", "ON_MEDIA_END"];
  const repeats = new Set<InteractionType>(["ON_KEY_DOWN", "DRAG", "ON_MEDIA_HIT"]);
  // Same trigger: the identity this interaction would have with it (its delay kept) against the others'.
  const used = new Set(others.filter((o) => o !== interaction).map((o) => triggerIdentity(o.event)));
  for (const t of all) if (!repeats.has(t) && used.has(triggerIdentity({ ...interaction.event, interactionType: t }))) out.add(t);
  const actions = allActions(interaction.actions);
  if (actions.some((a) => a.connectionType === "URL")) for (const t of all) if (t !== "ON_CLICK" && t !== "MOUSE_UP") out.add(t);
  if (actions.some((a) => a.connectionType === "UPDATE_MEDIA_RUNTIME")) for (const t of ["ON_HOVER", "ON_PRESS", "DRAG"] as const) out.add(t);
  if (interaction.actions?.length === 1 && interaction.actions[0].connectionType === "BACK") for (const t of ["ON_HOVER", "ON_PRESS"] as const) out.add(t);
  out.delete(interaction.event?.interactionType ?? "ON_CLICK");
  return out;
}

/**
 * The Action list as live (83.png; live 2026-10-10): None | Navigate to, Change to (disabled unless the hotspot is a
 * variant or in one), Back, Scroll to, Open link | Set variable, Set variable mode, Conditional | Open overlay, Swap
 * overlay, Close overlay | Play/Pause animation, Set playhead. The last two (Figma's object animations — the schema's
 * dropped OBJECT_ANIMATION) aren't built: listed, disabled. Conditional isn't offered inside a Conditional; the video
 * actions (where the frame has a video) after the overlays — their place unverified.
 */
export function actionMenu({ changeTo, conditional, video }: { changeTo: boolean; conditional: boolean; video: boolean }): MenuEntry[] {
  const a = (v: ActionKind, disabled = false): MenuEntry => ({ value: v, label: actionLabel(v), icon: ACTION_ICON[v], ...(disabled ? { disabled } : {}) });
  return [
    a("NONE"),
    "-",
    a("NAVIGATE"), a("CHANGE_TO", !changeTo), a("BACK"), a("SCROLL_TO"), a("URL"),
    "-",
    a("SET_VARIABLE"), a("SET_VARIABLE_MODE"), ...(conditional ? [a("CONDITIONAL")] : []),
    "-",
    a("OVERLAY"), a("SWAP"), a("CLOSE"),
    ...(video ? ["-" as const, ...VIDEO_ACTIONS.map((v) => a(v.value))] : []),
    "-",
    { value: "ANIMATION_PLAY", label: "Play/Pause animation", icon: "24.proto.animation.play", disabled: true },
    { value: "ANIMATION_PLAYHEAD", label: "Set playhead", icon: "24.proto.playhead", disabled: true },
  ];
}

/** Each video action's choices, in Figma's words. */
export const MEDIA_CHOICES: Partial<Record<ActionKind, { value: MediaAction; label: string }[]>> = {
  VIDEO_PLAY: [
    { value: "PLAY", label: "Play video" },
    { value: "PAUSE", label: "Pause video" },
    { value: "TOGGLE_PLAY_PAUSE", label: "Toggle play/pause" },
  ],
  VIDEO_SOUND: [
    { value: "MUTE", label: "Mute video" },
    { value: "UNMUTE", label: "Unmute video" },
    { value: "TOGGLE_MUTE_UNMUTE", label: "Toggle mute/unmute" },
  ],
  VIDEO_JUMP: [
    { value: "SKIP_FORWARD", label: "Jump forward" },
    { value: "SKIP_BACKWARD", label: "Jump backward" },
  ],
};

export function mediaKind(m: MediaAction | undefined): ActionKind {
  switch (m ?? "PLAY") {
    case "MUTE":
    case "UNMUTE":
    case "TOGGLE_MUTE_UNMUTE":
      return "VIDEO_SOUND";
    case "SKIP_TO":
      return "VIDEO_SET_TIME";
    case "SKIP_FORWARD":
    case "SKIP_BACKWARD":
      return "VIDEO_JUMP";
    default:
      return "VIDEO_PLAY";
  }
}

export const isVideoAction = (k: ActionKind): boolean => k === "VIDEO_PLAY" || k === "VIDEO_SOUND" || k === "VIDEO_SET_TIME" || k === "VIDEO_JUMP";

/** The label of a video action's choice ("Play video", "Jump forward 5s", "Set to 0:10"). */
export function mediaChoiceLabel(a: PrototypeAction): string {
  const k = mediaKind(a.mediaAction);
  if (k === "VIDEO_SET_TIME") return tr("Set to {time}", { time: formatMediaTime(a.mediaSkipToTime) });
  const label = MEDIA_CHOICES[k]?.find((c) => c.value === (a.mediaAction ?? "PLAY"))?.label ?? "Play video";
  return k === "VIDEO_JUMP" ? `${tr(label)} ${a.mediaSkipByAmount ?? 0}s` : label;
}

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
    case "UPDATE_MEDIA_RUNTIME": return mediaKind(a.mediaAction);
    default: return "NONE";
  }
}

export function actionLabel(k: ActionKind): string {
  if (k === "NONE") return "None";
  for (const a of [...ACTIONS, ...VIDEO_ACTIONS]) if (a !== "-" && a.value === k) return a.label;
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
    transitionDuration: prev.transitionDuration || 0.3,
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
    case "VIDEO_PLAY":
    case "VIDEO_SOUND":
    case "VIDEO_SET_TIME":
    case "VIDEO_JUMP": {
      // On the same video as before when there was one.
      const video = prev.connectionType === "UPDATE_MEDIA_RUNTIME" && prev.transitionNodeID ? { transitionNodeID: prev.transitionNodeID } : {};
      const first: Record<string, MediaAction> = { VIDEO_PLAY: "PLAY", VIDEO_SOUND: "MUTE", VIDEO_SET_TIME: "SKIP_TO", VIDEO_JUMP: "SKIP_FORWARD" };
      const a: PrototypeAction = { connectionType: "UPDATE_MEDIA_RUNTIME", ...video, mediaAction: first[k] };
      if (k === "VIDEO_SET_TIME") a.mediaSkipToTime = 0;
      if (k === "VIDEO_JUMP") a.mediaSkipByAmount = 5;
      return a;
    }
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

// The arrows name the way the layers move; the stored type names the other side (atlas 13 §5.2, Figma's panel): Move in
// left is MOVE_FROM_RIGHT, Move out left MOVE_OUT_TO_RIGHT — the _OUT_TO_ types are the reversed _FROM_ ones, so the old
// screen leaves to the left (§5.3). No direction yet: left (Figma's stored RIGHT).
const OPPOSITE: Record<Direction, Side> = { LEFT: "RIGHT", RIGHT: "LEFT", UP: "BOTTOM", DOWN: "TOP" };

export function transitionOf(animation: Animation, direction: Direction = "LEFT"): TransitionType {
  switch (animation) {
    case "INSTANT": return "INSTANT_TRANSITION";
    case "DISSOLVE": return "DISSOLVE";
    case "SMART_ANIMATE": return "SMART_ANIMATE";
    case "MOVE_IN": return `MOVE_FROM_${OPPOSITE[direction]}`;
    case "PUSH": return `PUSH_FROM_${OPPOSITE[direction]}`;
    case "SLIDE_IN": return `SLIDE_FROM_${OPPOSITE[direction]}`;
    case "MOVE_OUT": return `MOVE_OUT_TO_${OPPOSITE[direction]}`;
    case "SLIDE_OUT": return `SLIDE_OUT_TO_${OPPOSITE[direction]}`;
  }
}

export function animationOf(t: TransitionType | undefined): { animation: Animation; direction: Direction } {
  const fromSide = (s: string): Direction => (s === "RIGHT" ? "LEFT" : s === "LEFT" ? "RIGHT" : s === "BOTTOM" ? "UP" : "DOWN");
  const toSide = fromSide;
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

/**
 * The animations an action offers (atlas 13 §5.1, Figma's `en`): Open overlay Instant, Dissolve and Move in; Swap
 * overlay those and Smart animate; Change to Instant, Dissolve and Smart animate; the others all; On drag needs a moving
 * one (Instant and Dissolve disabled). Scroll to's own pair is the panel's.
 */
export function animationsFor(kind: ActionKind, trigger: InteractionType | undefined): { value: Animation; label: string; disabled?: boolean }[] {
  const allowed: Partial<Record<ActionKind, Animation[]>> = {
    OVERLAY: ["INSTANT", "DISSOLVE", "MOVE_IN"],
    SWAP: ["INSTANT", "DISSOLVE", "SMART_ANIMATE", "MOVE_IN"],
    CHANGE_TO: ["INSTANT", "DISSOLVE", "SMART_ANIMATE"],
  };
  const list = allowed[kind];
  return ANIMATIONS.map((a) => {
    const off = (list && !list.includes(a.value)) || (trigger === "DRAG" && (a.value === "INSTANT" || a.value === "DISSOLVE"));
    return off ? { ...a, disabled: true } : a;
  });
}

// Springs (atlas 13 §5.4, motion/Easing): ω₀ = √(k/m), ζ = c / (2√(km)).
const springParts = (f: readonly number[]) => {
  const [m, k, c] = [f[0] ?? 1, f[1] ?? 100, f[2] ?? 15];
  const w0 = Math.sqrt(k / m);
  return { m, w0, zeta: c / (2 * Math.sqrt(k * m)) };
};

/**
 * A spring's [mass, stiffness, damping] as Figma's viewer reads it (`easingFunctionValues`): the action's own
 * `easingFunction` for Gentle, Quick, Bouncy, Slow and Custom spring — a preset whose Duration was edited keeps its type
 * and stores the rescaled spring there —, else the preset's numbers (Figma's tables; legacy SPRING is Gentle; an
 * unreadable custom spring its fallback).
 */
export function springOf(e: EasingType, fn?: readonly number[]): number[] {
  if (e !== "SPRING" && fn && fn.length >= 3 && fn.slice(0, 3).every(Number.isFinite) && fn[0] > 0 && fn[1] > 0 && fn[2] >= 0) return [fn[0], fn[1], fn[2]];
  switch (e) {
    case "GENTLE_SPRING":
    case "SPRING": return [1, 100, 15];
    case "SPRING_PRESET_ONE": return [1, 300, 20];
    case "SPRING_PRESET_TWO": return [1, 600, 15];
    case "SPRING_PRESET_THREE": return [1, 80, 20];
    default: return [1, 100, 10];
  }
}

/**
 * What `transitionDuration` holds for a spring (Figma's `J5`): its settle time T = (−ln 0.001 + ln(1 + ζω₀ / ω_d)) /
 * (ζω₀), ζ ≤ 0.9999 — Gentle 1.022 s, Quick 0.744 s, Bouncy 0.958 s, Slow 1.250 s.
 */
export function springSettleTime(f: readonly number[]): number {
  const { w0, zeta: z } = springParts(f);
  const zeta = Math.min(0.9999, z);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return (-Math.log(0.001) + Math.log(1 + (zeta * w0) / wd)) / (zeta * w0);
}

/** The spring editor's Duration: 6 / (ζω₀). */
export function springEditorDuration(f: readonly number[]): number {
  const { w0, zeta } = springParts(f);
  return 6 / (zeta * w0);
}

/** The spring with an editor Duration of `seconds`: ω₀ = 6 / (d·ζ) to 4 significant digits, mass and ζ kept. */
export function springWithEditorDuration(f: readonly number[], seconds: number): number[] {
  const { m, zeta } = springParts(f);
  let w0 = 6 / (seconds * zeta);
  if (w0 > 0) {
    const scale = 10 ** (4 - (Math.floor(Math.log10(w0)) + 1));
    w0 = Math.round(w0 * scale) / scale;
  }
  w0 = Math.min(1000, Math.max(0.1, w0));
  return [m, w0 * w0 * m, 2 * zeta * w0 * m];
}

/**
 * The Easing editor's graph in the Prototype panel (docs/motion.md §6.3, round 8j: easing/CurveEditor shared with
 * Motion): a custom bezier as Motion's CUSTOM_CUBIC_BEZIER, a custom spring as its bounce clamp(1 − ζ, 0, 1) — the
 * graph's one spring handle [ours: the prototype's ω₀ stays on its Mass / Stiffness fields and Duration].
 */
export function prototypeCurve(e: EasingType, fn: readonly number[]): MotionEasing | null {
  if (e === "CUSTOM_CUBIC") return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: fn[0] ?? 0, y1: fn[1] ?? 0, x2: fn[2] ?? 0.58, y2: fn[3] ?? 1 } };
  if (e === "CUSTOM_SPRING") return { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: Math.min(1, Math.max(0, 1 - springParts(springOf(e, fn)).zeta)) } };
  return null;
}

/**
 * The graph's edit as the action's `easingFunction`: a bezier's four numbers; a spring's damping for the dragged
 * bounce, mass and stiffness kept (ζ = 1 − bounce, at least 0.01; damping 0.01…1000, the spring editor's limits).
 */
export function easingFunctionOfCurve(curve: MotionEasing, fn: readonly number[]): number[] {
  const b = curve.easingFunctionCubicBezier;
  if (curve.type === "CUSTOM_CUBIC_BEZIER" && b) return [b.x1, b.y1, b.x2, b.y2];
  const [m, k] = springOf("CUSTOM_SPRING", fn);
  const zeta = Math.max(0.01, 1 - (curve.easingFunctionSpring?.bounce ?? 0));
  const damping = Math.min(1000, Math.max(0.01, Math.round(zeta * 2 * Math.sqrt(k * m) * 100) / 100));
  return [m, k, damping, ...fn.slice(3)];
}

/** Custom bezier / spring defaults when picked (Figma's: its ease out curve [0, 0, 0.58, 1], a gentle spring). */
export function easingFunctionFor(e: EasingType): number[] | undefined {
  if (e === "CUSTOM_CUBIC") return [0, 0, 0.58, 1];
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
    stateManagementVersion: 1,
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

/** The triggers with a delay of their own (Figma's interactionMaintained): mouse enter, leave, down and up. */
export const takesDelay = (t: InteractionType | undefined): boolean =>
  t === "MOUSE_ENTER" || t === "MOUSE_LEAVE" || t === "MOUSE_DOWN" || t === "MOUSE_UP" || t === "MOUSE_IN" || t === "MOUSE_OUT";

/**
 * A mouse trigger's delay in seconds, as Figma reads it: interactionDuration when interactionMaintained (0.3 without
 * one), else 0; files Wecra wrote before kept it in transitionTimeout.
 */
export function mouseDelayOf(e: PrototypeInteraction["event"]): number {
  if (!takesDelay(e?.interactionType)) return 0;
  if (e?.interactionMaintained) return e.interactionDuration || 0.3;
  return Math.max(0, e?.transitionTimeout ?? 0);
}

/** The event with a mouse delay (seconds; 0 = none) in Figma's placement. */
export function withMouseDelay(e: NonNullable<PrototypeInteraction["event"]>, seconds: number): NonNullable<PrototypeInteraction["event"]> {
  const out = { ...e };
  delete out.transitionTimeout;
  if (seconds > 0) {
    out.interactionMaintained = true;
    out.interactionDuration = seconds;
  } else {
    delete out.interactionMaintained;
    delete out.interactionDuration;
  }
  return out;
}

/** An interaction with its trigger changed (the event's other fields kept where they still mean something). */
export function withTrigger(i: PrototypeInteraction, t: InteractionType): PrototypeInteraction {
  const event: NonNullable<PrototypeInteraction["event"]> = { ...(i.event ?? {}), interactionType: t };
  if (t === "AFTER_TIMEOUT") event.transitionTimeout = i.event?.transitionTimeout || 0.8;
  else delete event.transitionTimeout;
  if (!takesDelay(t)) {
    delete event.interactionMaintained;
    delete event.interactionDuration;
  } else if (takesDelay(i.event?.interactionType)) {
    // Mouse trigger to mouse trigger: the delay kept, moved to Figma's placement when it sat in transitionTimeout.
    Object.assign(event, withMouseDelay(event, mouseDelayOf(i.event)));
  }
  if (t !== "ON_KEY_DOWN") delete event.keyTrigger;
  if (t === "ON_MEDIA_HIT") event.mediaHitTime = i.event?.mediaHitTime ?? 0;
  else delete event.mediaHitTime;
  return { ...i, event };
}

/**
 * The short trigger names of the Prototype panel's interaction rows (live Figma 2026-10-10, prototype_interaction_list:
 * "Click", "Drag", "Hover", "Press", "Key (A)", "Delay", "Mouse enter"…; the video triggers' are unverified).
 */
export function triggerShortLabel(i: PrototypeInteraction): string {
  const t = i.event?.interactionType ?? "ON_CLICK";
  switch (t) {
    case "ON_CLICK": return tr("Click");
    case "DRAG": return tr("Drag");
    case "ON_HOVER": return tr("Hover");
    case "ON_PRESS": return tr("Press");
    case "ON_KEY_DOWN": {
      const key = keyTriggerLabel(i.event?.keyTrigger?.keyCodes);
      return key ? tr("Key ({key})", { key }) : tr("Key");
    }
    case "AFTER_TIMEOUT": return tr("Delay");
    case "NONE": return tr("None");
    case "ON_MEDIA_HIT": return tr("Video hits {time}", { time: formatMediaTime(i.event?.mediaHitTime) });
    case "ON_MEDIA_END": return tr("Video ends");
    default: return triggerLabel(t);
  }
}

/** A variant's name as its property values ("State=Hover, Size=Large" → "Hover, Large"), as live's rows show it. */
export function variantValues(name: string): string {
  const parts = name.split(",").map((p) => p.trim());
  if (!parts.length || !parts.every((p) => p.includes("="))) return name;
  return parts.map((p) => p.slice(p.indexOf("=") + 1).trim()).join(", ");
}

/**
 * An interaction row as live Figma's (2026-10-10): the short trigger, the first action's glyph (`kind`), and where it
 * goes — the destination's name (a variant's values for Change to), "None" without one, "Back", "Close overlay", the
 * link without its scheme; later actions aren't shown.
 */
export function interactionSummary(i: PrototypeInteraction, nameOf: (id: Guid) => string | null): { trigger: string; action: string; kind: ActionKind } {
  const trigger = triggerShortLabel(i);
  const a = i.actions?.[0];
  const k = actionKind(a);
  let action = actionLabel(k);
  if (a && takesDestination(k)) {
    const dest = guidOf(a.transitionNodeID);
    const name = dest ? nameOf(dest) : null;
    action = name === null ? "None" : k === "CHANGE_TO" ? variantValues(name) : name;
  } else if (k === "URL") {
    action = (a?.connectionURL ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") || "None";
  } else if (a && isVideoAction(k)) {
    action = mediaChoiceLabel(a);
  }
  return { trigger, action, kind: k };
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
  return d.size ? tr("Custom size {w}×{h}", { w: Math.round(d.size.x), h: Math.round(d.size.y) }) : tr("Custom size");
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

/** Overlay › Fit to window (Wecra-only): None keeps the overlay's size. */
export const OVERLAY_FITS: { value: OverlayFitWindow; label: string }[] = [
  { value: "NONE", label: "None" },
  { value: "WIDTH", label: "Width" },
  { value: "HEIGHT", label: "Height" },
  { value: "BOTH", label: "Width and height" },
];

/** Prototype › Text input › Type (Wecra-only). */
export const TEXT_INPUT_TYPES: { value: TextInputType; label: string }[] = [
  { value: "TEXT", label: "Text" },
  { value: "PASSWORD", label: "Password" },
  { value: "EMAIL", label: "Email" },
  { value: "NUMBER", label: "Number" },
  { value: "MULTI_LINE", label: "Multi-line" },
];

/** Prototype › Cursor (Wecra-only): Auto follows the layer (a hand over hotspots, text over inputs…). */
export const PROTOTYPE_CURSORS: { value: PrototypeCursor; label: string }[] = [
  { value: "AUTO", label: "Auto" },
  { value: "DEFAULT", label: "Default" },
  { value: "POINTER", label: "Pointer" },
  { value: "TEXT", label: "Text" },
  { value: "GRAB", label: "Grab" },
  { value: "MOVE", label: "Move" },
  { value: "NOT_ALLOWED", label: "Not allowed" },
  { value: "HELP", label: "Help" },
  { value: "ZOOM_IN", label: "Zoom in" },
  { value: "ZOOM_OUT", label: "Zoom out" },
  { value: "CROSSHAIR", label: "Crosshair" },
  { value: "NONE", label: "None" },
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
