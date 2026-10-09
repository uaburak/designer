/**
 * Shader fills and effects as the document stores them (Figma's schema, round 11): a Paint or Effect of type CUSTOM
 * whose `customEffectId.assetRef.key` names the preset (src/shared/shaders/presets.json) and whose
 * `componentPropAssignments` hold its parameters — `{defID: {sessionID: 0, localID: id}}` with `value.floatValue`
 * (a number in the units shown, a choice's index), `value.boolValue` (a toggle) or `varValue` (a colour: a COLOR
 * literal). New ones carry every parameter (the engine's defaults are the same presets.json's).
 */
import { SHADER_EFFECTS, SHADER_FILLS, shaderPreset, type ShaderParam, type ShaderPreset } from "@shared/shaders/presets";
import type { Color } from "@/engine/codec";
import { hexToColor } from "./color";

export { SHADER_EFFECTS, SHADER_FILLS, shaderPreset };
export type { ShaderParam, ShaderPreset };

/** A parameter's value: a number (number, choice), a colour, or a boolean (toggle). */
export type ShaderValue = number | boolean | Color;

interface Assignment {
  defID: { sessionID: number; localID: number } | string;
  value?: { floatValue?: number; boolValue?: boolean };
  varValue?: { dataType?: string; resolvedDataType?: string; value?: { colorValue?: Color } };
}

/** What a paint or effect needs to be a shader. */
export interface ShaderFields {
  type?: string;
  customEffectId?: { guid?: unknown; assetRef?: { key?: string; version?: string } };
  componentPropAssignments?: Assignment[];
  [k: string]: unknown;
}

const localOf = (id: Assignment["defID"]): number | null => {
  if (typeof id === "string") {
    const m = /^0:(\d+)$/.exec(id);
    return m ? Number(m[1]) : null;
  }
  return id && id.sessionID === 0 ? id.localID : null;
};

/** A parameter's default as a value. */
export function defaultValue(p: ShaderParam): ShaderValue {
  if (p.type === "color") return hexToColor(String(p.default), String(p.default).length > 7 ? parseInt(String(p.default).slice(7, 9), 16) / 255 : 1);
  if (p.type === "toggle") return p.default === true;
  return Number(p.default);
}

/** One parameter's assignment (Figma's ComponentPropAssignment). */
export function assignment(p: ShaderParam, v: ShaderValue): Assignment {
  const defID = { sessionID: 0, localID: p.id };
  if (p.type === "color") {
    const c = v as Color;
    return { defID, varValue: { dataType: "COLOR", resolvedDataType: "COLOR", value: { colorValue: { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 } } } };
  }
  if (p.type === "toggle") return { defID, value: { boolValue: v === true } };
  return { defID, value: { floatValue: Number(v) } };
}

/** The fields that make a paint or an effect `preset`, every parameter at its default. */
export function shaderFields(preset: ShaderPreset): Required<Pick<ShaderFields, "type" | "customEffectId" | "componentPropAssignments">> {
  return {
    type: "CUSTOM",
    customEffectId: { assetRef: { key: preset.key, version: "" } },
    componentPropAssignments: preset.params.map((p) => assignment(p, defaultValue(p))),
  };
}

/** The preset a CUSTOM paint or effect uses (undefined: not a shader, or one this app doesn't know). */
export const presetOf = (x: ShaderFields | null | undefined): ShaderPreset | undefined =>
  x?.type === "CUSTOM" ? shaderPreset(x.customEffectId?.assetRef?.key) : undefined;

/** A parameter's value on a paint or effect: its assignment's, else the preset's default. */
export function shaderValue(x: ShaderFields, p: ShaderParam): ShaderValue {
  const a = (x.componentPropAssignments ?? []).find((q) => localOf(q.defID) === p.id);
  if (a) {
    if (p.type === "color" && a.varValue?.value?.colorValue) return { ...a.varValue.value.colorValue, a: a.varValue.value.colorValue.a ?? 1 };
    if (p.type === "toggle" && typeof a.value?.boolValue === "boolean") return a.value.boolValue;
    if ((p.type === "number" || p.type === "choice") && typeof a.value?.floatValue === "number") return a.value.floatValue;
  }
  return defaultValue(p);
}

/** The paint or effect with one parameter set (its other assignments kept, in the preset's order). */
export function withShaderValue<T extends ShaderFields>(x: T, p: ShaderParam, v: ShaderValue): T {
  const preset = presetOf(x);
  const list = (x.componentPropAssignments ?? []).filter((q) => localOf(q.defID) !== p.id);
  list.push(assignment(p, v));
  const order = (a: Assignment) => preset?.params.findIndex((q) => q.id === localOf(a.defID)) ?? 0;
  list.sort((a, b) => order(a) - order(b));
  return { ...x, componentPropAssignments: list };
}

/** A shader fill of `preset` in place of `base` (its opacity, visibility and blend mode kept; its own type's fields gone). */
export function shaderPaint<T extends ShaderFields & { opacity?: number; visible?: boolean; blendMode?: string }>(base: T | null, preset: ShaderPreset): ShaderFields {
  return { opacity: base?.opacity ?? 1, visible: base?.visible ?? true, ...(base?.blendMode ? { blendMode: base.blendMode } : {}), ...shaderFields(preset) };
}

/** A shader effect of `preset` (visible; in place of `base`, its visibility kept). */
export function shaderEffect(base: { visible?: boolean } | null, preset: ShaderPreset): ShaderFields {
  return { visible: base?.visible ?? true, blendMode: "NORMAL", ...shaderFields(preset) };
}

/** Leaving CUSTOM: the shader's fields go. */
export function dropShader<T extends ShaderFields>(x: T): T {
  const out = { ...x };
  delete out.customEffectId;
  delete out.componentPropAssignments;
  return out;
}

/** A swatch for a shader fill (its colours as a gradient; one colour or none: the panel's tertiary). */
export function shaderSwatch(x: ShaderFields): string {
  const preset = presetOf(x);
  const colors = (preset?.params ?? []).filter((p) => p.type === "color").map((p) => shaderValue(x, p) as Color);
  const css = (c: Color) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a ?? 1})`;
  if (colors.length >= 2) return `linear-gradient(135deg, ${colors.map(css).join(", ")})`;
  if (colors.length === 1) return css(colors[0]);
  return "var(--figma-color-bg-tertiary)";
}
