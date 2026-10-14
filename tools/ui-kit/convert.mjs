// Turns a captured DOM tree (walker.js) into create_nodes specs (src/shared/agents/tools.ts): boxes → frames (flex →
// auto layout when the captured positions prove it, else absolute positions), text runs → text, ds icons and ds
// components → slots that build.mjs fills with instances, other pictures → image rectangles. Pure: no I/O.
import { figmaColor, appColor, text as textStyles, radius as radiusTokens } from "../../src/renderer/src/ds/tokens.ts";

/** ds components drawn as plain layers (their content varies screen to screen); the rest become components. */
export const CONTAINERS = new Set(["Rail", "EditorToolbar", "Toolbar", "Dialog", "Popover", "Menu", "ScrollArea", "VirtualList", "CollectionView", "PanelSection", "PropertyGrid", "TabBar", "Overlay", "ColorPicker", "ListView", "Gallery"]);
export const isLeaf = (n) => n && n.kind === "box" && n.ds && n.ds !== "Icon" && !CONTAINERS.has(n.ds);

// ---- colours → tokens ------------------------------------------------------------------------------------------------
const norm = (h) => {
  if (!h) return null;
  h = h.toLowerCase();
  return h.length === 9 && h.endsWith("ff") ? h.slice(0, 7) : h;
};
export const TOKENS = [];
for (const [name, [l, d]] of Object.entries(figmaColor)) TOKENS.push({ name, css: `--figma-color-${name}`, light: norm(l), dark: norm(d), group: name.split("-")[0] });
for (const [name, [l, d]] of Object.entries(appColor)) TOKENS.push({ name, css: `--ds-color-${name}`, light: norm(l), dark: norm(d), group: "app" });
export const variableName = (t) => `${t.group}/${t.name}`;
const byPair = new Map();
const byLight = new Map();
for (const t of TOKENS) {
  const k = `${t.light}|${t.dark}`;
  byPair.set(k, [...(byPair.get(k) ?? []), t]);
  byLight.set(t.light, [...(byLight.get(t.light) ?? []), t]);
}
const PREFIX = { fill: ["bg", "app"], stroke: ["border", "app"], text: ["text", "app"], icon: ["icon", "text", "app"] };
/** The token a colour stands for: its light and dark values together, the usage's family first, the plainest name. */
export function tokenFor(light, dark, usage) {
  light = norm(light);
  dark = norm(dark);
  if (!light) return null;
  let cands = byPair.get(`${light}|${dark}`);
  if (!cands && dark == null) cands = byLight.get(light);
  if (!cands?.length) return null;
  const pref = PREFIX[usage] ?? [];
  const score = (t) => {
    const p = pref.indexOf(t.group);
    return (p < 0 ? 100 : p * 10) + (/-(hover|pressed)$/.test(t.name) ? 5 : 0) + t.name.split("-").length;
  };
  return [...cands].sort((a, b) => score(a) - score(b) || a.name.length - b.name.length)[0];
}

/** The text style a run matches (size, line height, weight, tracking), or null. */
export function textStyleFor(ts) {
  for (const [name, s] of Object.entries(textStyles)) {
    if (s.mono) continue;
    if (s.size === ts.size && s.line === Math.round(ts.lh ?? 0) && s.weight === ts.weight && Math.abs(parseFloat(s.tracking) - (ts.ls ?? 0)) < 0.01) return name;
  }
  return null;
}
export const RADII = Object.entries(radiusTokens).filter(([, v]) => v > 0 && v < 100);

// ---- the tree → specs: the app's converter (src/shared/agents/web/convert.ts, also agents' capture_web_design) ----------
import * as shared from "../../src/shared/agents/web/convert.ts";
export const { prep, nameOf, sig, autoLayout, gradients, foldText } = shared;

/** The spec of a node with Wecra's ds components as slots and each text run's text style noted (`_.textStyle`). */
export function toSpec(n, ctx, opts = {}) {
  const spec = shared.toSpec(n, ctx, { isLeaf, ...opts });
  const note = (s) => {
    if (s.type === "TEXT" && s._?.src?.ts) s._.textStyle = textStyleFor({ ...s._.src.ts, lh: s.lineHeight });
    for (const c of s.children ?? []) note(c);
  };
  if (spec) note(spec);
  return spec;
}
