// Design system v2, step 4 (docs/design-system-v2.md §c and the effect styles): 9 text styles (Inter on its variable
// weight axis, as the app draws 450 / 550; SF Mono for code) and the elevation effect styles (each built for Light and
// Dark: effect styles have no modes, and Dark's shadows carry an inset highlight). Idempotent: a style of the same
// name is left as is when it matches, recreated otherwise. Read back by applying each to a specimen on a "Foundations"
// page (the styles' documentation) and reading the specimen's typography / effects.
import { session } from "./lib.mjs";

const s = await session();
const WGHT = 0x77676874; // 'wght'
const inter = (weight) => ({ fontFamily: "Inter", fontStyle: weight >= 500 ? "Medium" : "Regular", fontVariations: [{ axisTag: WGHT, axisName: "Weight", value: weight }] });

const TEXT = [
  ["Body/Small", { ...inter(450), fontSize: 9, lineHeight: 14, letterSpacing: 0.045 * 9 }],
  ["Body/Medium", { ...inter(450), fontSize: 11, lineHeight: 16, letterSpacing: 0.055 * 11 }],
  ["Body/Medium strong", { ...inter(550), fontSize: 11, lineHeight: 16, letterSpacing: 0.055 * 11 }],
  ["Body/Large", { ...inter(450), fontSize: 13, lineHeight: 22, letterSpacing: -0.0325 * 13 }],
  ["Body/Large strong", { ...inter(550), fontSize: 13, lineHeight: 22, letterSpacing: -0.0325 * 13 }],
  ["Heading/Medium", { ...inter(550), fontSize: 15, lineHeight: 25, letterSpacing: -0.13 }],
  ["Heading/Large", { ...inter(550), fontSize: 24, lineHeight: 32, letterSpacing: -0.47 }],
  ["Code", { fontFamily: "SF Mono", fontStyle: "Regular", fontSize: 11, lineHeight: 16, letterSpacing: 0 }],
  ["Key", { ...inter(400), fontSize: 12, lineHeight: 15, letterSpacing: 0 }],
];

// The app's --ds-elevation-* (src/renderer/src/ds/tokens.css), layer by layer
const sh = (x, y, radius, color, inner = false) => ({ type: inner ? "INNER_SHADOW" : "DROP_SHADOW", color, offset: { x, y }, radius, spread: 0, visible: true, blendMode: "NORMAL" });
const EFFECTS = [
  ["Elevation/100/Light", [sh(0, 0, 0.5, "#0000004D"), sh(0, 1, 3, "#00000026")]],
  ["Elevation/100/Dark", [sh(0, 0, 0.5, "#00000080"), sh(0, 0.75, 0, "#FFFFFF1A", true), sh(0, 1, 3, "#00000066")]],
  ["Elevation/200/Light", [sh(0, 0, 0.5, "#0000002E"), sh(0, 3, 8, "#0000001A"), sh(0, 1, 3, "#0000001A")]],
  ["Elevation/200/Dark", [sh(0, 3, 8, "#00000059"), sh(0, 1, 3, "#00000080"), sh(0, 0.5, 0, "#FFFFFF14", true), sh(0, 0, 0.5, "#FFFFFF4D", true)]],
  ["Elevation/400 Panel/Light", [sh(0, 0, 0.5, "#0000001F"), sh(0, 10, 16, "#0000001F"), sh(0, 2, 5, "#00000026")]],
  ["Elevation/400 Panel/Dark", [sh(0, 10, 16, "#00000059"), sh(0, 2, 5, "#00000059"), sh(0, 0.5, 0, "#FFFFFF14", true), sh(0, 0.75, 0, "#FFFFFF1A", true)]],
  ["Elevation/500 Modal/Light", [sh(0, 0, 0.5, "#00000014"), sh(0, 10, 24, "#0000002E"), sh(0, 2, 5, "#00000026")]],
  ["Elevation/500 Modal/Dark", [sh(0, 10, 24, "#00000073"), sh(0, 3, 5, "#00000059"), sh(0, 0.75, 0, "#FFFFFF1A", true)]],
  ["Elevation/Menu", [sh(0, 0, 0.5, "#0000004D"), sh(0, 5, 17, "#00000040"), sh(0, 2, 7, "#00000026")]],
];

const existing = new Set(((await s.call("get_variable_defs", { all: true })).styles ?? []).map((x) => x.name));
for (const [name, props] of TEXT) if (!existing.has(name)) console.log("text style", name, JSON.stringify(await s.call("create_text_style", { name, ...props })).slice(0, 160));
for (const [name, effects] of EFFECTS) if (!existing.has(name)) console.log("effect style", name, JSON.stringify(await s.call("create_effect_style", { name, effects })).slice(0, 160));
const styles = (await s.call("get_variable_defs", { all: true })).styles ?? [];
const names = new Set(styles.map((x) => x.name));
const missing = [...TEXT, ...EFFECTS].map(([n]) => n).filter((n) => !names.has(n));
console.log(`styles: ${TEXT.length + EFFECTS.length - missing.length}/${TEXT.length + EFFECTS.length} present${missing.length ? "; missing " + missing.join(", ") : ""}`);
process.exit(missing.length ? 1 : 0);
