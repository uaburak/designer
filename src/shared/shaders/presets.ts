/**
 * Figma's shader presets ("By Figma"): the Fill picker's Shader fills and the Effects browser's Shader effects, in the
 * browsers' order (live docs/research/figma/live/popovers/fill-picker-custom.txt, effects-add-shader-effects.txt).
 * presets.json is the one definition: the panels read it here, the engine's renderer reads the table
 * engine/tools/shaderpresets.mjs makes from it. Names are live's; keys, parameters and defaults are ours (unverified).
 */
import data from "./presets.json";

export type ShaderParamType = "number" | "color" | "choice" | "toggle";

export interface ShaderParam {
  /** The defID's localID (sessionID 0) its componentPropAssignment carries */
  id: number;
  name: string;
  type: ShaderParamType;
  /** number / choice: a number (a choice's index); color: "#RRGGBB" or "#RRGGBBAA"; toggle: a boolean */
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** "%", "°" or "px": the value is stored in the units shown */
  unit?: string;
  /** choice: the options' names */
  options?: string[];
}

export interface ShaderPreset {
  key: string;
  name: string;
  kind: "fill" | "effect";
  params: ShaderParam[];
}

type Raw = { key: string; name: string; params: ShaderParam[] };
const read = (list: Raw[], kind: ShaderPreset["kind"]): ShaderPreset[] => list.map((p) => ({ key: p.key, name: p.name, kind, params: p.params }));

/** The Fill picker's "Shader fills" (10). */
export const SHADER_FILLS: readonly ShaderPreset[] = read(data.fills as Raw[], "fill");
/** The Effects browser's "Shader effects" (25). */
export const SHADER_EFFECTS: readonly ShaderPreset[] = read(data.effects as Raw[], "effect");

const byKey = new Map([...SHADER_FILLS, ...SHADER_EFFECTS].map((p) => [p.key, p]));

/** The preset a key names (a paint's / effect's customEffectId.assetRef.key), or undefined. */
export const shaderPreset = (key: string | undefined | null): ShaderPreset | undefined => (key ? byKey.get(key) : undefined);
