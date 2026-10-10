/**
 * The agents' prototype shapes (Figma's Plugin API Reaction / Trigger / Action / Transition / Easing — the mapping is
 * documented in src/shared/agents/prototypeSchema.ts) to and from the document's PrototypeInteraction as the engine
 * reads and writes it (model/prototype.ts). Writes are validated: every error names the path and what it takes.
 */
import type { Guid } from "@/engine/codec";
import { colorToHex, fromTool, parseColorValue } from "@shared/agents/docSchema";
import { ACTION_ALIASES, ACTION_TYPES, DIRECTIONS, EASING_TYPES, MEDIA_ACTIONS, NAVIGATIONS, OVERLAY_POSITIONS, TRANSITION_TYPES, TRIGGER_ALIASES, TRIGGER_TYPES } from "@shared/agents/prototypeSchema";
import { animationOf, guidJson, guidOf, liveInteractions, transitionOf, type Animation, type Direction, type EasingType, type GuidJson, type InteractionType, type PrototypeAction, type PrototypeInteraction, type TransitionType, type VariableDataJson } from "../model/prototype";

type Obj = Record<string, unknown>;
export type Errors = string[];

export interface ProtoNodeInfo {
  id: Guid;
  name: string;
  /** The document's type (FRAME, SYMBOL, INSTANCE, TEXT …) */
  type: string;
  isStateGroup: boolean;
  parentType: string | null;
  parentIsStateGroup: boolean;
  pageId: Guid | null;
}

export interface ProtoLookup {
  node(id: Guid): ProtoNodeInfo | null;
  collection(ref: string): { id: Guid; name: string; modes: { modeId: Guid; name: string }[] } | null;
  variable(ref: string): { id: Guid; name: string; resolvedType: string } | null;
  newId(): GuidJson;
}

/** Overlay settings an action asked for, to write on its destination frame. */
export interface OverlayWrite {
  frame: Guid;
  fields: Obj;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const normRef = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/^(\d+)-(\d+)$/, "$1:$2") : "");
const up = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : "");
const round = (v: number) => Math.round(v * 10000) / 10000;

function strict(o: Obj, allowed: readonly string[], path: string, errors: Errors, what: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown field (${what} takes ${allowed.join(", ")})`);
}

// ---- Easing / transition ----------------------------------------------------------------------------------------------

const EASING_IN: Record<string, EasingType> = {
  EASE_IN: "IN_CUBIC", EASE_OUT: "OUT_CUBIC", EASE_IN_AND_OUT: "INOUT_CUBIC", EASE_IN_OUT: "INOUT_CUBIC", LINEAR: "LINEAR",
  EASE_IN_BACK: "IN_BACK_CUBIC", EASE_OUT_BACK: "OUT_BACK_CUBIC", EASE_IN_AND_OUT_BACK: "INOUT_BACK_CUBIC", CUSTOM_CUBIC_BEZIER: "CUSTOM_CUBIC", CUSTOM_BEZIER: "CUSTOM_CUBIC",
  GENTLE: "GENTLE_SPRING", QUICK: "SPRING_PRESET_ONE", BOUNCY: "SPRING_PRESET_TWO", SLOW: "SPRING_PRESET_THREE", CUSTOM_SPRING: "CUSTOM_SPRING",
};
const EASING_OUT: Partial<Record<EasingType, string>> = {
  IN_CUBIC: "EASE_IN", EASE_IN: "EASE_IN", OUT_CUBIC: "EASE_OUT", INOUT_CUBIC: "EASE_IN_AND_OUT", LINEAR: "LINEAR", IN_BACK_CUBIC: "EASE_IN_BACK", OUT_BACK_CUBIC: "EASE_OUT_BACK",
  INOUT_BACK_CUBIC: "EASE_IN_AND_OUT_BACK", CUSTOM_CUBIC: "CUSTOM_CUBIC_BEZIER", SPRING: "GENTLE", GENTLE_SPRING: "GENTLE", SPRING_PRESET_ONE: "QUICK", SPRING_PRESET_TWO: "BOUNCY",
  SPRING_PRESET_THREE: "SLOW", CUSTOM_SPRING: "CUSTOM_SPRING", HOLD: "LINEAR",
};

function easingToDoc(v: unknown, path: string, errors: Errors): Pick<PrototypeAction, "easingType" | "easingFunction"> {
  const o = isObj(v) ? v : { type: v };
  if (isObj(v)) strict(v, ["type", "easingFunctionCubicBezier", "easingFunctionSpring"], path, errors, "an easing");
  const t = up(o.type);
  const easingType = EASING_IN[t] ?? ((Object.values(EASING_IN) as string[]).includes(t) ? (t as EasingType) : undefined);
  if (!easingType) {
    errors.push(`${path}: ${JSON.stringify(o.type)} is not an easing (${EASING_TYPES.join(", ")})`);
    return {};
  }
  if (easingType === "CUSTOM_CUBIC") {
    const b = isObj(o.easingFunctionCubicBezier) ? o.easingFunctionCubicBezier : { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    const f = [b.x1, b.y1, b.x2, b.y2].map(Number);
    if (f.some((x) => !Number.isFinite(x))) return void errors.push(`${path}.easingFunctionCubicBezier: {x1, y1, x2, y2} numbers`), {};
    return { easingType, easingFunction: f };
  }
  if (easingType === "CUSTOM_SPRING") {
    const s = isObj(o.easingFunctionSpring) ? o.easingFunctionSpring : { mass: 1, stiffness: 100, damping: 15 };
    const f = [s.mass ?? 1, s.stiffness ?? 100, s.damping ?? 15].map(Number);
    if (f.some((x) => !Number.isFinite(x))) return void errors.push(`${path}.easingFunctionSpring: {mass, stiffness, damping} numbers`), {};
    return { easingType, easingFunction: [...f, 0] };
  }
  return { easingType };
}

function easingFromDoc(a: PrototypeAction): unknown {
  const type = EASING_OUT[a.easingType ?? "OUT_CUBIC"] ?? "EASE_OUT";
  const f = a.easingFunction;
  if (type === "CUSTOM_CUBIC_BEZIER" && f?.length === 4) return { type, easingFunctionCubicBezier: { x1: f[0], y1: f[1], x2: f[2], y2: f[3] } };
  if (type === "CUSTOM_SPRING" && f && f.length >= 3) return { type, easingFunctionSpring: { mass: f[0], stiffness: f[1], damping: f[2], initialVelocity: 0 } };
  return { type };
}

const PLUGIN_DIR: Record<string, Direction> = { LEFT: "LEFT", RIGHT: "RIGHT", TOP: "UP", BOTTOM: "DOWN", UP: "UP", DOWN: "DOWN" };
const DOC_TRANSITIONS: readonly string[] = [
  "INSTANT_TRANSITION", "DISSOLVE", "FADE", "SMART_ANIMATE", "MAGIC_MOVE", "SCROLL_ANIMATE",
  ...["MOVE_FROM_", "MOVE_OUT_TO_", "PUSH_FROM_", "SLIDE_FROM_", "SLIDE_OUT_TO_"].flatMap((p) => ["LEFT", "RIGHT", "TOP", "BOTTOM"].map((s) => p + s)),
];

type TransitionFields = Pick<PrototypeAction, "transitionType" | "transitionDuration" | "easingType" | "easingFunction" | "transitionShouldSmartAnimate">;

function transitionToDoc(v: unknown, path: string, errors: Errors): TransitionFields {
  const base: TransitionFields = { transitionType: "INSTANT_TRANSITION", transitionDuration: 0.3, easingType: "OUT_CUBIC" };
  if (v === null || v === undefined) return base;
  const o = isObj(v) ? v : { type: v };
  if (isObj(v)) strict(v, ["type", "direction", "matchLayers", "duration", "durationMs", "easing"], path, errors, "a transition");
  const t = up(o.type);
  let transitionType: TransitionType;
  if (t === "INSTANT" || t === "NONE" || t === "INSTANT_TRANSITION") transitionType = "INSTANT_TRANSITION";
  else if (DOC_TRANSITIONS.includes(t)) transitionType = t as TransitionType;
  else if ((TRANSITION_TYPES as readonly string[]).includes(t)) {
    const directional = ["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"].includes(t);
    let dir: Direction = "LEFT";
    if (directional) {
      const d = PLUGIN_DIR[up(o.direction ?? "LEFT")];
      if (!d) errors.push(`${path}.direction: ${JSON.stringify(o.direction)} is not one of ${DIRECTIONS.join(", ")}`);
      else dir = d;
    } else if (o.direction !== undefined) errors.push(`${path}.direction: only MOVE_IN, MOVE_OUT, PUSH, SLIDE_IN and SLIDE_OUT take a direction`);
    transitionType = transitionOf(t as Animation, dir);
  } else {
    errors.push(`${path}.type: ${JSON.stringify(o.type)} is not a transition (${TRANSITION_TYPES.join(", ")}, or null for instant)`);
    return base;
  }
  const out: TransitionFields = { ...base, transitionType };
  if (o.durationMs !== undefined) {
    if (typeof o.durationMs !== "number" || o.durationMs < 0 || o.durationMs > 10000) errors.push(`${path}.durationMs: 0–10000`);
    else out.transitionDuration = o.durationMs / 1000;
  } else if (o.duration !== undefined) {
    if (typeof o.duration !== "number" || o.duration < 0) errors.push(`${path}.duration: seconds, a number ≥ 0`);
    else if (o.duration > 10) errors.push(`${path}.duration: seconds (0–10; Figma's longest is 10 s) — got ${o.duration}; for milliseconds pass durationMs`);
    else out.transitionDuration = o.duration;
  }
  if (o.easing !== undefined) Object.assign(out, easingToDoc(o.easing, `${path}.easing`, errors));
  if (o.matchLayers !== undefined) {
    if (typeof o.matchLayers !== "boolean") errors.push(`${path}.matchLayers: true or false`);
    else if (o.matchLayers) out.transitionShouldSmartAnimate = true;
  }
  return out;
}

function transitionFromDoc(a: PrototypeAction): unknown {
  const t = a.transitionType ?? "INSTANT_TRANSITION";
  if (t === "INSTANT_TRANSITION") return null;
  const { animation, direction } = animationOf(t);
  const out: Obj = { type: t === "SCROLL_ANIMATE" ? "SCROLL_ANIMATE" : animation };
  if (["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"].includes(animation)) {
    out.direction = direction === "UP" ? "TOP" : direction === "DOWN" ? "BOTTOM" : direction;
    out.matchLayers = !!a.transitionShouldSmartAnimate;
  }
  out.duration = round(a.transitionDuration ?? 0.3);
  out.easing = easingFromDoc(a);
  return out;
}

// ---- Trigger ----------------------------------------------------------------------------------------------------------

const KEY_NAMES: Record<string, number> = {
  BACKSPACE: 8, TAB: 9, ENTER: 13, RETURN: 13, SHIFT: 16, CONTROL: 17, CTRL: 17, ALT: 18, OPTION: 18, ESCAPE: 27, ESC: 27, SPACE: 32, " ": 32,
  PAGEUP: 33, PAGEDOWN: 34, END: 35, HOME: 36, ARROWLEFT: 37, LEFT: 37, ARROWUP: 38, UP: 38, ARROWRIGHT: 39, RIGHT: 39, ARROWDOWN: 40, DOWN: 40,
  DELETE: 46, META: 91, CMD: 91, COMMAND: 91, ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222,
};

function keyCodesOf(keys: unknown, path: string, errors: Errors): number[] {
  const parts = (Array.isArray(keys) ? keys : [keys]).flatMap((k) => (typeof k === "string" ? k.split("+").map((x) => x.trim()).filter(Boolean) : [k]));
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p !== "string") {
      errors.push(`${path}: key names as strings ("Shift+K", "ArrowRight")`);
      continue;
    }
    const u = p.toUpperCase();
    if (/^[A-Z0-9]$/.test(u)) out.push(u.charCodeAt(0));
    else if (/^F([1-9]|1[0-2])$/.test(u)) out.push(111 + Number(u.slice(1)));
    else if (KEY_NAMES[u] !== undefined) out.push(KEY_NAMES[u]);
    else errors.push(`${path}: unknown key ${JSON.stringify(p)} (A–Z, 0–9, F1–F12, ArrowLeft/Right/Up/Down, Enter, Escape, Space, Tab, Backspace, Delete, Shift, Control, Alt, Meta, punctuation)`);
  }
  return out;
}

function triggerToDoc(v: unknown, path: string, errors: Errors): NonNullable<PrototypeInteraction["event"]> {
  if (v === null) return { interactionType: "NONE" };
  const o = isObj(v) ? v : { type: v };
  if (isObj(v)) strict(v, ["type", "timeout", "timeoutMs", "delay", "keyCodes", "keys", "device", "mediaHitTime", "deprecatedVersion"], path, errors, "a trigger");
  const t0 = up(o.type);
  const t = TRIGGER_ALIASES[t0] ?? t0;
  if (!(TRIGGER_TYPES as readonly string[]).includes(t)) {
    errors.push(`${path}.type: ${JSON.stringify(o.type)} is not a trigger (${TRIGGER_TYPES.join(", ")})`);
    return { interactionType: "ON_CLICK" };
  }
  const deprecated = o.deprecatedVersion === true;
  const docType: InteractionType = t === "ON_DRAG" ? "DRAG" : t === "MOUSE_ENTER" && deprecated ? "MOUSE_IN" : t === "MOUSE_LEAVE" && deprecated ? "MOUSE_OUT" : (t as InteractionType);
  const event: NonNullable<PrototypeInteraction["event"]> = { interactionType: docType };
  const only = (k: string, types: string[]) => {
    if (o[k] !== undefined && !types.includes(t)) errors.push(`${path}.${k}: only for ${types.join(" / ")} triggers`);
  };
  only("timeout", ["AFTER_TIMEOUT"]);
  only("timeoutMs", ["AFTER_TIMEOUT"]);
  only("delay", ["MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_DOWN", "MOUSE_UP"]);
  only("keyCodes", ["ON_KEY_DOWN"]);
  only("keys", ["ON_KEY_DOWN"]);
  only("device", ["ON_KEY_DOWN"]);
  only("mediaHitTime", ["ON_MEDIA_HIT"]);
  if (t === "AFTER_TIMEOUT") {
    const s = o.timeoutMs !== undefined ? (typeof o.timeoutMs === "number" ? o.timeoutMs / 1000 : NaN) : o.timeout !== undefined ? Number(o.timeout) : 0.8;
    if (!Number.isFinite(s) || s <= 0 || s > 10) errors.push(`${path}.timeout: seconds, more than 0 and at most 10 (or timeoutMs 1–10000)`);
    else event.transitionTimeout = s;
  }
  if (o.delay !== undefined && t !== "AFTER_TIMEOUT") {
    if (typeof o.delay !== "number" || o.delay < 0 || o.delay > 10) errors.push(`${path}.delay: seconds 0–10`);
    else if (o.delay > 0) event.transitionTimeout = o.delay;
  }
  if (t === "ON_KEY_DOWN") {
    let codes: number[] = [];
    if (o.keyCodes !== undefined) {
      if (!Array.isArray(o.keyCodes) || !o.keyCodes.every((c) => Number.isInteger(c) && c > 0)) errors.push(`${path}.keyCodes: a list of JavaScript keyCodes (65 = A, 39 = ArrowRight)`);
      else codes = o.keyCodes as number[];
    } else if (o.keys !== undefined) codes = keyCodesOf(o.keys, `${path}.keys`, errors);
    if (!codes.length) errors.push(`${path}: ON_KEY_DOWN needs keyCodes or keys`);
    const device = o.device === undefined ? "KEYBOARD" : up(o.device);
    if (!["KEYBOARD", "UNKNOWN_CONTROLLER", "XBOX_ONE", "PS4", "SWITCH_PRO"].includes(device)) errors.push(`${path}.device: KEYBOARD, UNKNOWN_CONTROLLER, XBOX_ONE, PS4 or SWITCH_PRO`);
    event.keyTrigger = { keyCodes: codes, triggerDevice: device };
  }
  if (t === "ON_MEDIA_HIT") {
    const s = o.mediaHitTime === undefined ? 0 : Number(o.mediaHitTime);
    if (!Number.isFinite(s) || s < 0) errors.push(`${path}.mediaHitTime: seconds ≥ 0`);
    else event.mediaHitTime = s;
  }
  return event;
}

function triggerFromDoc(e: PrototypeInteraction["event"]): unknown {
  const t = e?.interactionType ?? "ON_CLICK";
  if (t === "NONE") return null;
  if (t === "DRAG") return { type: "ON_DRAG" };
  if (t === "AFTER_TIMEOUT") return { type: t, timeout: round(e?.transitionTimeout ?? 0.8) };
  if (t === "MOUSE_IN" || t === "MOUSE_OUT") return { type: t === "MOUSE_IN" ? "MOUSE_ENTER" : "MOUSE_LEAVE", delay: round(e?.transitionTimeout ?? 0), deprecatedVersion: true };
  if (t === "MOUSE_ENTER" || t === "MOUSE_LEAVE" || t === "MOUSE_DOWN" || t === "MOUSE_UP") return { type: t, delay: round(e?.transitionTimeout ?? 0) };
  if (t === "ON_KEY_DOWN") return { type: t, device: e?.keyTrigger?.triggerDevice ?? "KEYBOARD", keyCodes: e?.keyTrigger?.keyCodes ?? [] };
  if (t === "ON_MEDIA_HIT") return { type: t, mediaHitTime: e?.mediaHitTime ?? 0 };
  return { type: t };
}

// ---- Variable data ----------------------------------------------------------------------------------------------------

const BOOL_FUNCTIONS = ["EQUALS", "NOT_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "AND", "OR", "NOT", "IS_TRUTHY"];
const EXPRESSION_FUNCTIONS = ["ADDITION", "SUBTRACTION", "MULTIPLY", "DIVIDE", ...BOOL_FUNCTIONS, "STRINGIFY", "TERNARY", "NEGATE", "VAR_MODE_LOOKUP"];

/** A Plugin API VariableData (or a bare literal / {alias}) as the document's VariableData; `expected`: the resolved type it must have. */
export function variableDataToDoc(v: unknown, expected: string | null, path: string, errors: Errors, look: ProtoLookup): VariableDataJson | undefined {
  const literal = (type: string, value: unknown): VariableDataJson | undefined => {
    if (expected && expected !== type) return void errors.push(`${path}: a ${expected} value (got ${type} ${JSON.stringify(value)})`);
    if (type === "BOOLEAN") return typeof value === "boolean" ? { value: { boolValue: value }, dataType: "BOOLEAN", resolvedDataType: "BOOLEAN" } : void errors.push(`${path}: true or false`);
    if (type === "FLOAT") return typeof value === "number" && Number.isFinite(value) ? { value: { floatValue: value }, dataType: "FLOAT", resolvedDataType: "FLOAT" } : void errors.push(`${path}: a number`);
    if (type === "STRING") return typeof value === "string" ? { value: { textValue: value }, dataType: "STRING", resolvedDataType: "STRING" } : void errors.push(`${path}: a string`);
    if (type === "COLOR") {
      const c = parseColorValue(value);
      return c ? { value: { colorValue: c }, dataType: "COLOR", resolvedDataType: "COLOR" } : void errors.push(`${path}: a colour "#RRGGBB(AA)"`);
    }
    return void errors.push(`${path}: type ${type} is not BOOLEAN, FLOAT, STRING, COLOR, VARIABLE_ALIAS or EXPRESSION`);
  };
  if (v === undefined || v === null) return void errors.push(`${path}: a value (a literal, {type: "VARIABLE_ALIAS", id} or an EXPRESSION)`);
  if (typeof v === "boolean") return literal("BOOLEAN", v);
  if (typeof v === "number") return literal("FLOAT", v);
  if (typeof v === "string") return expected === "COLOR" ? literal("COLOR", v) : literal("STRING", v);
  if (!isObj(v)) return void errors.push(`${path}: a literal or an object`);
  // Already the document's shape.
  if ("dataType" in v) return fromTool("VariableData", false, v, path, errors) as VariableDataJson | undefined;
  const type = up(v.type);
  if (type === "VARIABLE_ALIAS" || type === "ALIAS" || ("alias" in v && !("type" in v))) {
    const ref = normRef(isObj(v.value) ? v.value.id : (v.id ?? v.alias));
    const target = look.variable(ref);
    if (!target) return void errors.push(`${path}: no variable ${JSON.stringify(ref)} (get_variable_defs lists them)`);
    if (expected && target.resolvedType !== expected) return void errors.push(`${path}: ${target.name} is ${target.resolvedType}, a ${expected} is needed here`);
    return { value: { alias: { guid: guidJson(target.id) } }, dataType: "ALIAS", resolvedDataType: target.resolvedType };
  }
  const exprOf = (e: unknown): Obj | null => (isObj(e) && "expressionFunction" in e ? e : null);
  const expr = type === "EXPRESSION" ? exprOf(v.value) : exprOf(v);
  if (expr) {
    const fn = up(expr.expressionFunction);
    if (!EXPRESSION_FUNCTIONS.includes(fn)) return void errors.push(`${path}.expressionFunction: ${JSON.stringify(expr.expressionFunction)} is not one of ${EXPRESSION_FUNCTIONS.join(", ")}`);
    const args = Array.isArray(expr.expressionArguments) ? expr.expressionArguments : null;
    if (!args?.length) return void errors.push(`${path}.expressionArguments: a list of values`);
    const docArgs = args.map((a, i) => variableDataToDoc(a, fn === "AND" || fn === "OR" || fn === "NOT" ? "BOOLEAN" : null, `${path}.expressionArguments[${i}]`, errors, look));
    const resolved = BOOL_FUNCTIONS.includes(fn) ? "BOOLEAN" : fn === "STRINGIFY" ? "STRING" : fn === "TERNARY" ? (docArgs[1]?.resolvedDataType ?? expected ?? "FLOAT") : docArgs.some((a) => a?.resolvedDataType === "STRING") ? "STRING" : "FLOAT";
    if (expected && resolved !== expected) return void errors.push(`${path}: the expression gives a ${resolved}, a ${expected} is needed here`);
    return { value: { expressionValue: { expressionFunction: fn, expressionArguments: docArgs.filter(Boolean) } }, dataType: "EXPRESSION", resolvedDataType: resolved };
  }
  if (["BOOLEAN", "FLOAT", "STRING", "COLOR"].includes(type)) return literal(type, v.value);
  return void errors.push(`${path}: a literal, {type: "VARIABLE_ALIAS", id}, {type: BOOLEAN | FLOAT | STRING | COLOR, value} or {type: "EXPRESSION", value: {expressionFunction, expressionArguments}}`);
}

export function variableDataFromDoc(d: VariableDataJson | undefined): unknown {
  if (!d) return undefined;
  const v = d.value ?? {};
  switch (d.dataType) {
    case "BOOLEAN": return { type: "BOOLEAN", value: !!v.boolValue };
    case "FLOAT": return { type: "FLOAT", value: v.floatValue ?? 0 };
    case "STRING": return { type: "STRING", value: v.textValue ?? "" };
    case "COLOR": return { type: "COLOR", value: colorToHex(v.colorValue as never) };
    case "ALIAS": return { type: "VARIABLE_ALIAS", id: guidOf(v.alias?.guid ?? null) ?? v.alias?.assetRef?.key ?? null };
    case "EXPRESSION": {
      const e = v.expressionValue as { expressionFunction?: string; expressionArguments?: VariableDataJson[] } | undefined;
      return { type: "EXPRESSION", resolvedType: d.resolvedDataType, value: { expressionFunction: e?.expressionFunction, expressionArguments: (e?.expressionArguments ?? []).map(variableDataFromDoc) } };
    }
  }
  return d;
}

// ---- Actions ----------------------------------------------------------------------------------------------------------

const NODE_FIELDS = ["type", "destinationId", "navigation", "transition", "preserveScrollPosition", "resetScrollPosition", "resetInteractiveComponents", "resetVideoPosition", "overlayRelativePosition", "extraScrollOffset", "overlay"];
const SHORT_NAV: Record<string, string> = { NAVIGATE: "NAVIGATE", CHANGE_TO: "CHANGE_TO", SCROLL_TO: "SCROLL_TO", OPEN_OVERLAY: "OVERLAY", SWAP_OVERLAY: "SWAP" };

const isFrameLike = (n: ProtoNodeInfo) => ["FRAME", "SYMBOL", "INSTANCE"].includes(n.type) && !n.isStateGroup;
const isScreen = (n: ProtoNodeInfo) => isFrameLike(n) && (n.parentType === "CANVAS" || n.parentType === "SECTION");
const kind = (n: ProtoNodeInfo) => (n.type === "SYMBOL" ? "COMPONENT" : n.isStateGroup ? "COMPONENT_SET" : n.type);

interface Ctx {
  look: ProtoLookup;
  /** The layer the interaction is on */
  source: ProtoNodeInfo;
  overlays: OverlayWrite[];
}

function destination(ctx: Ctx, v: unknown, nav: string, path: string, errors: Errors): GuidJson | undefined {
  if (v === undefined || v === null || v === "") {
    errors.push(`${path}: a destination layer id is needed for ${nav}`);
    return undefined;
  }
  const id = normRef(v);
  const n = ctx.look.node(id);
  if (!n) return void errors.push(`${path}: no layer ${JSON.stringify(v)} in this file (get_metadata / get_prototype list ids)`);
  if (n.pageId !== ctx.source.pageId) return void errors.push(`${path}: "${n.name}" is on another page — prototypes connect layers on one page`);
  if ((nav === "NAVIGATE" || nav === "OVERLAY" || nav === "SWAP") && !isScreen(n))
    return void errors.push(`${path}: "${n.name}" (${kind(n)}) is not a top-level frame — ${nav} goes to a frame (or component) directly on the page or in a section`);
  if (nav === "CHANGE_TO" && !(n.type === "SYMBOL" && n.parentIsStateGroup)) return void errors.push(`${path}: "${n.name}" (${kind(n)}) is not a variant — CHANGE_TO goes to a variant of the component set the source belongs to`);
  if (n.id === ctx.source.id && nav !== "CHANGE_TO") return void errors.push(`${path}: a layer can't ${nav === "SCROLL_TO" ? "scroll" : "navigate"} to itself`);
  return guidJson(n.id);
}

function bool(o: Obj, k: string, path: string, errors: Errors): boolean | undefined {
  if (o[k] === undefined) return undefined;
  if (typeof o[k] !== "boolean") return void errors.push(`${path}.${k}: true or false`);
  return o[k] as boolean;
}

function vector(o: Obj, k: string, path: string, errors: Errors): { x: number; y: number } | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v.x !== "number" || typeof v.y !== "number") return void errors.push(`${path}.${k}: {x, y} numbers`);
  return { x: v.x, y: v.y };
}

function overlaySettings(ctx: Ctx, dest: GuidJson | undefined, v: unknown, path: string, errors: Errors) {
  if (v === undefined) return;
  if (!isObj(v)) return void errors.push(`${path}: {position, background, closeOnClickOutside}`);
  strict(v, ["position", "background", "closeOnClickOutside"], path, errors, "overlay");
  const fields: Obj = {};
  if (v.position !== undefined) {
    const p = up(v.position);
    if (!(OVERLAY_POSITIONS as readonly string[]).includes(p)) errors.push(`${path}.position: one of ${OVERLAY_POSITIONS.join(", ")}`);
    else fields.overlayPositionType = p;
  }
  if (v.background !== undefined) {
    if (v.background === null || v.background === "NONE") fields.overlayBackgroundAppearance = { backgroundType: "NONE" };
    else {
      const c = parseColorValue(isObj(v.background) ? v.background.color : v.background);
      if (!c) errors.push(`${path}.background: a colour "#RRGGBBAA" (e.g. "#00000066"), or null for none`);
      else fields.overlayBackgroundAppearance = { backgroundType: "SOLID_COLOR", backgroundColor: c };
    }
  }
  const close = bool(v, "closeOnClickOutside", path, errors);
  if (close !== undefined) fields.overlayBackgroundInteraction = close ? "CLOSE_ON_CLICK_OUTSIDE" : "NONE";
  if (dest && Object.keys(fields).length) ctx.overlays.push({ frame: guidOf(dest)!, fields });
}

function actionToDoc(ctx: Ctx, v: unknown, path: string, errors: Errors): PrototypeAction | undefined {
  if (!isObj(v)) return void errors.push(`${path}: an action object {type, …}`);
  const t0 = up(v.type);
  const t = ACTION_ALIASES[t0] ?? t0;
  if (!(ACTION_TYPES as readonly string[]).includes(t)) return void errors.push(`${path}.type: ${JSON.stringify(v.type)} is not an action (${ACTION_TYPES.join(", ")})`);
  if (t === "NODE" || SHORT_NAV[t]) {
    strict(v, t === "NODE" ? NODE_FIELDS : NODE_FIELDS.filter((k) => k !== "navigation"), path, errors, `a ${t} action`);
    const nav0 = t === "NODE" ? up(v.navigation ?? "NAVIGATE") : SHORT_NAV[t];
    if (!(NAVIGATIONS as readonly string[]).includes(nav0)) return void errors.push(`${path}.navigation: one of ${NAVIGATIONS.join(", ")}`);
    const dest = destination(ctx, v.destinationId, nav0, `${path}.destinationId`, errors);
    const a: PrototypeAction = {
      connectionType: "INTERNAL_NODE",
      navigationType: nav0 === "CHANGE_TO" ? "SWAP_STATE" : (nav0 as PrototypeAction["navigationType"]),
      ...(dest ? { transitionNodeID: dest } : {}),
      ...transitionToDoc(v.transition, `${path}.transition`, errors),
    };
    const flags: [string, keyof PrototypeAction][] = [["preserveScrollPosition", "transitionPreserveScroll"], ["resetScrollPosition", "transitionResetScrollPosition"], ["resetInteractiveComponents", "transitionResetInteractiveComponents"], ["resetVideoPosition", "transitionResetVideoPosition"]];
    for (const [k, f] of flags) {
      const b = bool(v, k, path, errors);
      if (b) a[f] = true as never;
    }
    const orp = vector(v, "overlayRelativePosition", path, errors);
    if (orp) a.overlayRelativePosition = orp;
    const off = vector(v, "extraScrollOffset", path, errors);
    if (off) {
      if (nav0 !== "SCROLL_TO") errors.push(`${path}.extraScrollOffset: only for SCROLL_TO`);
      a.extraScrollOffset = off;
    }
    if (v.overlay !== undefined && nav0 !== "OVERLAY" && nav0 !== "SWAP") errors.push(`${path}.overlay: only for OVERLAY / SWAP (OPEN_OVERLAY, SWAP_OVERLAY)`);
    else overlaySettings(ctx, dest, v.overlay, `${path}.overlay`, errors);
    if (orp && dest) ctx.overlays.push({ frame: guidOf(dest)!, fields: { overlayPositionType: "MANUAL" } });
    return a;
  }
  if (t === "BACK" || t === "CLOSE") {
    strict(v, ["type", "transition"], path, errors, `a ${t} action`);
    return { connectionType: t, ...transitionToDoc(v.transition, `${path}.transition`, errors) };
  }
  if (t === "NONE") {
    strict(v, ["type"], path, errors, "a NONE action");
    return { connectionType: "NONE" };
  }
  if (t === "URL") {
    strict(v, ["type", "url", "openInNewTab"], path, errors, "a URL action");
    if (typeof v.url !== "string" || !v.url.trim()) errors.push(`${path}.url: the link ("https://…")`);
    const newTab = bool(v, "openInNewTab", path, errors);
    return { connectionType: "URL", connectionURL: String(v.url ?? ""), openUrlInNewTab: newTab ?? true };
  }
  if (t === "SET_VARIABLE") {
    strict(v, ["type", "variableId", "variableValue", "value"], path, errors, "a SET_VARIABLE action");
    const target = ctx.look.variable(normRef(v.variableId));
    if (!target) return void errors.push(`${path}.variableId: no variable ${JSON.stringify(v.variableId)} (get_variable_defs lists them; a name works too)`);
    const raw = v.variableValue !== undefined ? v.variableValue : v.value;
    const data = variableDataToDoc(raw, target.resolvedType, `${path}.${v.variableValue !== undefined ? "variableValue" : "value"}`, errors, ctx.look);
    return { connectionType: "SET_VARIABLE", targetVariable: { id: { guid: guidJson(target.id) } }, ...(data ? { targetVariableData: data } : {}) };
  }
  if (t === "SET_VARIABLE_MODE") {
    strict(v, ["type", "variableCollectionId", "collectionId", "variableModeId", "modeId", "mode"], path, errors, "a SET_VARIABLE_MODE action");
    const cref = v.variableCollectionId ?? v.collectionId;
    const c = ctx.look.collection(normRef(cref));
    if (!c) return void errors.push(`${path}.variableCollectionId: no collection ${JSON.stringify(cref)} (get_variable_defs with all: true lists them; a name works too)`);
    const mref = v.variableModeId ?? v.modeId ?? v.mode;
    const m = c.modes.find((x) => x.modeId === normRef(mref) || x.name === mref);
    if (!m) return void errors.push(`${path}.variableModeId: collection "${c.name}" has no mode ${JSON.stringify(mref)} (it has ${c.modes.map((x) => `${x.name} (${x.modeId})`).join(", ")})`);
    return { connectionType: "SET_VARIABLE_MODE", targetVariableSetID: { guid: guidJson(c.id) }, targetVariableModeID: guidJson(m.modeId) };
  }
  if (t === "CONDITIONAL") {
    strict(v, ["type", "conditionalBlocks"], path, errors, "a CONDITIONAL action");
    const blocks = Array.isArray(v.conditionalBlocks) ? v.conditionalBlocks : null;
    if (!blocks?.length) return void errors.push(`${path}.conditionalBlocks: [{condition, actions}, …, {actions} (else)]`);
    const out: NonNullable<PrototypeAction["conditionalActions"]> = [];
    blocks.forEach((b, i) => {
      const p = `${path}.conditionalBlocks[${i}]`;
      if (!isObj(b)) return void errors.push(`${p}: {condition?, actions}`);
      strict(b, ["condition", "actions"], p, errors, "a conditional block");
      if (b.condition === undefined && i < blocks.length - 1) errors.push(`${p}.condition: only the last block may leave it out (else)`);
      const condition = b.condition === undefined ? undefined : variableDataToDoc(b.condition, "BOOLEAN", `${p}.condition`, errors, ctx.look);
      const actions = actionsToDoc(ctx, b.actions ?? [], `${p}.actions`, errors);
      out.push({ actions, ...(condition ? { condition } : {}) });
    });
    return { connectionType: "CONDITIONAL", conditionalActions: out };
  }
  // UPDATE_MEDIA_RUNTIME
  strict(v, ["type", "destinationId", "mediaAction", "amountToSkip", "newTimestamp"], path, errors, "an UPDATE_MEDIA_RUNTIME action");
  const m = up(v.mediaAction);
  if (!(MEDIA_ACTIONS as readonly string[]).includes(m)) errors.push(`${path}.mediaAction: one of ${MEDIA_ACTIONS.join(", ")}`);
  const id = normRef(v.destinationId);
  const n = id ? ctx.look.node(id) : null;
  if (v.destinationId !== undefined && !n) errors.push(`${path}.destinationId: no layer ${JSON.stringify(v.destinationId)}`);
  const a: PrototypeAction = { connectionType: "UPDATE_MEDIA_RUNTIME", mediaAction: m as PrototypeAction["mediaAction"], ...(n ? { transitionNodeID: guidJson(n.id) } : {}) };
  if (m === "SKIP_FORWARD" || m === "SKIP_BACKWARD") a.mediaSkipByAmount = typeof v.amountToSkip === "number" ? v.amountToSkip : 5;
  if (m === "SKIP_TO") a.mediaSkipToTime = typeof v.newTimestamp === "number" ? v.newTimestamp : 0;
  return a;
}

function actionsToDoc(ctx: Ctx, v: unknown, path: string, errors: Errors): PrototypeAction[] {
  if (!Array.isArray(v)) {
    errors.push(`${path}: a list of actions`);
    return [];
  }
  return v.map((a, i) => actionToDoc(ctx, a, `${path}[${i}]`, errors)).filter((a): a is PrototypeAction => !!a);
}

export function actionFromDoc(a: PrototypeAction): Obj {
  const c = a.connectionType ?? "NONE";
  const dest = guidOf(a.transitionNodeID as never);
  switch (c) {
    case "INTERNAL_NODE": {
      const out: Obj = { type: "NODE", destinationId: dest, navigation: a.navigationType === "SWAP_STATE" ? "CHANGE_TO" : (a.navigationType ?? "NAVIGATE"), transition: transitionFromDoc(a) };
      if (a.transitionPreserveScroll) out.preserveScrollPosition = true;
      if (a.transitionResetScrollPosition) out.resetScrollPosition = true;
      if (a.transitionResetInteractiveComponents) out.resetInteractiveComponents = true;
      if (a.transitionResetVideoPosition) out.resetVideoPosition = true;
      if (a.overlayRelativePosition) out.overlayRelativePosition = a.overlayRelativePosition;
      if (a.extraScrollOffset) out.extraScrollOffset = a.extraScrollOffset;
      return out;
    }
    case "BACK":
    case "CLOSE": {
      const tr = transitionFromDoc(a);
      return tr ? { type: c, transition: tr } : { type: c };
    }
    case "URL": return { type: "URL", url: a.connectionURL ?? "", openInNewTab: a.openUrlInNewTab ?? false };
    case "SET_VARIABLE": return { type: "SET_VARIABLE", variableId: guidOf(a.targetVariable?.id?.guid ?? null), variableValue: variableDataFromDoc(a.targetVariableData) };
    case "SET_VARIABLE_MODE": return { type: "SET_VARIABLE_MODE", variableCollectionId: guidOf(a.targetVariableSetID?.guid ?? null) ?? a.targetVariableSetID?.assetRef?.key ?? null, variableModeId: guidOf(a.targetVariableModeID ?? null) };
    case "CONDITIONAL": return { type: "CONDITIONAL", conditionalBlocks: (a.conditionalActions ?? []).map((b) => ({ ...(b.condition ? { condition: variableDataFromDoc(b.condition) } : {}), actions: (b.actions ?? []).map(actionFromDoc) })) };
    case "UPDATE_MEDIA_RUNTIME": {
      const out: Obj = { type: "UPDATE_MEDIA_RUNTIME", destinationId: dest, mediaAction: a.mediaAction ?? "PLAY" };
      if (a.mediaSkipByAmount !== undefined) out.amountToSkip = a.mediaSkipByAmount;
      if (a.mediaSkipToTime !== undefined) out.newTimestamp = a.mediaSkipToTime;
      return out;
    }
  }
  return { type: "NONE" };
}

// ---- Reactions --------------------------------------------------------------------------------------------------------

/** Whether a list looks like the document's PrototypeInteraction[] (event / connectionType) rather than Reactions. */
export const isDocShape = (v: unknown): boolean => Array.isArray(v) && v.some((x) => isObj(x) && ("event" in x || (Array.isArray(x.actions) && x.actions.some((a) => isObj(a) && "connectionType" in a))));

/** One Reaction as the document's interaction (keeping `id` when it replaces one). */
export function reactionToDoc(v: unknown, look: ProtoLookup, source: ProtoNodeInfo, path: string, errors: Errors, overlays: OverlayWrite[], id?: GuidJson | string): PrototypeInteraction | undefined {
  if (!isObj(v)) return void errors.push(`${path}: a reaction {trigger, actions}`);
  strict(v, ["trigger", "actions", "action", "id", "index"], path, errors, "a reaction");
  const ctx: Ctx = { look, source, overlays };
  if (!("trigger" in v)) errors.push(`${path}.trigger: needed ({type: "ON_CLICK"} …)`);
  const event = triggerToDoc(v.trigger, `${path}.trigger`, errors);
  const list = v.actions !== undefined ? v.actions : v.action !== undefined ? [v.action] : null;
  if (list === null) errors.push(`${path}.actions: needed (a list of actions)`);
  const actions = list === null ? [] : actionsToDoc(ctx, list, `${path}.${v.actions !== undefined ? "actions" : "action"}`, errors);
  return { id: id ?? look.newId(), event, actions };
}

/** The document's interactions (live ones) as Reactions, with their index and id. */
export function reactionsFromDoc(list: readonly PrototypeInteraction[] | undefined): Obj[] {
  return liveInteractions(list).map((i, index) => ({ index, id: guidOf(i.id as never), trigger: triggerFromDoc(i.event), actions: (i.actions ?? []).map(actionFromDoc) }));
}

/** The document's shape given to set_properties: through the schema (GUID strings, enums by name), ids added. */
export function docInteractions(v: unknown, look: ProtoLookup, path: string, errors: Errors): PrototypeInteraction[] | undefined {
  const out = fromTool("PrototypeInteraction", true, v, path, errors) as PrototypeInteraction[] | undefined;
  return out?.map((i) => (i.id ? i : { ...i, id: look.newId() }));
}

// ---- Node settings ----------------------------------------------------------------------------------------------------

/** A layer's prototype settings in the Plugin API's names (only what's set). */
export function settingsFromDoc(n: Obj): Obj {
  const out: Obj = {};
  if (n.scrollDirection && n.scrollDirection !== "NONE") out.overflowDirection = n.scrollDirection;
  if (n.scrollBehavior && n.scrollBehavior !== "SCROLLS") out.scrollBehavior = n.scrollBehavior === "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" ? "FIXED" : n.scrollBehavior;
  if (n.overlayPositionType && n.overlayPositionType !== "CENTER") out.overlayPositionType = n.overlayPositionType;
  const bg = n.overlayBackgroundAppearance as { backgroundType?: string; backgroundColor?: never } | undefined;
  if (bg?.backgroundType === "SOLID_COLOR") out.overlayBackground = { type: "SOLID_COLOR", color: colorToHex(bg.backgroundColor) };
  if (n.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE") out.overlayBackgroundInteraction = "CLOSE_ON_CLICK_OUTSIDE";
  const sp = n.prototypeStartingPoint as { name?: string; description?: string } | undefined;
  if (sp) out.flowStartingPoint = { name: sp.name ?? "", ...(sp.description ? { description: sp.description } : {}) };
  return out;
}

export const SETTING_KEYS = ["overflowDirection", "scrollBehavior", "overlayPositionType", "overlayBackground", "overlayBackgroundInteraction"] as const;

/** A layer's prototype settings (Plugin API names) as document fields; null clears a field. */
export function settingsToDoc(v: Obj, path: string, errors: Errors): Obj {
  const out: Obj = {};
  if (v.overflowDirection !== undefined) {
    const d = up(v.overflowDirection ?? "NONE");
    if (!["NONE", "HORIZONTAL", "VERTICAL", "BOTH"].includes(d)) errors.push(`${path}.overflowDirection: NONE, HORIZONTAL, VERTICAL or BOTH`);
    else out.scrollDirection = d === "NONE" ? null : d;
  }
  if (v.scrollBehavior !== undefined) {
    const s = up(v.scrollBehavior ?? "SCROLLS");
    const doc = s === "FIXED" || s === "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" ? "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" : s === "STICKY" || s === "STICKY_SCROLLS" ? "STICKY_SCROLLS" : s === "SCROLLS" ? null : undefined;
    if (doc === undefined) errors.push(`${path}.scrollBehavior: SCROLLS, FIXED or STICKY_SCROLLS`);
    else out.scrollBehavior = doc;
  }
  if (v.overlayPositionType !== undefined) {
    const p = up(v.overlayPositionType ?? "CENTER");
    if (!(OVERLAY_POSITIONS as readonly string[]).includes(p)) errors.push(`${path}.overlayPositionType: one of ${OVERLAY_POSITIONS.join(", ")}`);
    else out.overlayPositionType = p === "CENTER" ? null : p;
  }
  if (v.overlayBackground !== undefined) {
    const b = v.overlayBackground;
    const color = isObj(b) ? (up(b.type) === "NONE" ? null : b.color) : b === "NONE" ? null : b;
    if (color === null || color === undefined) out.overlayBackgroundAppearance = null;
    else {
      const c = parseColorValue(color);
      if (!c) errors.push(`${path}.overlayBackground: {type: "SOLID_COLOR", color: "#RRGGBBAA"}, a colour, or {type: "NONE"}`);
      else out.overlayBackgroundAppearance = { backgroundType: "SOLID_COLOR", backgroundColor: c };
    }
  }
  if (v.overlayBackgroundInteraction !== undefined) {
    const i = up(v.overlayBackgroundInteraction ?? "NONE");
    if (i !== "NONE" && i !== "CLOSE_ON_CLICK_OUTSIDE") errors.push(`${path}.overlayBackgroundInteraction: NONE or CLOSE_ON_CLICK_OUTSIDE`);
    else out.overlayBackgroundInteraction = i === "NONE" ? null : i;
  }
  return out;
}
