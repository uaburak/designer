// Design system v2, step 2 (docs/design-system-v2.md §a, "Collections and modes"): the Brand collection (the primary
// colour's scale per theme: Blue, Yellow) and the Color collection (the semantic roles in Light and Dark). Every brand
// role in Color aliases Brand, so a page's Brand mode and its Color mode switch independently; status colours
// (danger, success, warning, component) and folder colours stay on fixed hues.
import { session, upsert } from "./lib.mjs";

const s = await session();
const P = "Primitives";

// ── Brand ──
const scale = ["50", "100", "200", "300", "500", "550", "600", "700", "800", "a10", "a40"];
const brand = [
  ...scale.map((k) => ({ name: `brand/${k}`, type: "COLOR", values: { Blue: `blue/${k}`, Yellow: `yellow/${k}` } })),
  // What sits on the brand colour (white on blue, near-black on yellow)
  { name: "brand/on", type: "COLOR", values: { Blue: "white", Yellow: "black/a90" } },
  { name: "brand/on-secondary", type: "COLOR", values: { Blue: "white/a80", Yellow: "black/a50" } },
  // Dark mode's selection tints follow the brand (slate for blue, olive for yellow)
  { name: "brand/dark-tint", type: "COLOR", values: { Blue: "slate/800", Yellow: "olive/800" } },
  { name: "brand/dark-tint-secondary", type: "COLOR", values: { Blue: "slate/900", Yellow: "olive/900" } },
  { name: "brand/dark-tint-hover", type: "COLOR", values: { Blue: "slate/700", Yellow: "olive/700" } },
];
const okBrand = await upsert(s, "Brand", ["Blue", "Yellow"], brand, [P]);

// ── Color: [name, light, dark, scopes] ──
const T = ["TEXT_FILL"];
const I = ["SHAPE_FILL", "STROKE_COLOR"];
const B = ["FRAME_FILL", "SHAPE_FILL"];
const S = ["STROKE_COLOR"];
const rows = [
  // text (16)
  ["text/default", "black/a90", "white", T],
  ["text/secondary", "black/a50", "white/a70", T],
  ["text/tertiary", "black/a30", "white/a40", T],
  ["text/disabled", "black/a30", "white/a40", T],
  ["text/brand", "brand/600", "brand/300", T],
  ["text/danger", "red/600", "red/300", T],
  ["text/success", "green/600", "green/300", T],
  ["text/warning", "yellow/800", "yellow/300", T],
  ["text/component", "purple/600", "purple/300", T],
  ["text/onbrand", "brand/on", "brand/on", T],
  ["text/onbrand-secondary", "brand/on-secondary", "brand/on-secondary", T],
  ["text/oncolor", "white", "white", T],
  ["text/oninverse", "white/a90", "black/a90", T],
  ["text/onwarning", "black/a90", "black/a90", T],
  ["text/menu-secondary", "white/a70", "white/a70", T],
  ["text/menu-disabled", "white/a40", "white/a40", T],
  // icon (12)
  ["icon/default", "black/a90", "white", I],
  ["icon/secondary", "black/a50", "white/a70", I],
  ["icon/tertiary", "black/a30", "white/a40", I],
  ["icon/disabled", "black/a30", "white/a40", I],
  ["icon/brand", "brand/600", "brand/300", I],
  ["icon/danger", "red/500", "red/600", I],
  ["icon/success", "green/500", "green/600", I],
  ["icon/warning", "yellow/500", "yellow/500", I],
  ["icon/component", "purple/600", "purple/300", I],
  ["icon/onbrand", "brand/on", "brand/on", I],
  ["icon/oncolor", "white", "white", I],
  ["icon/oninverse", "white/a90", "black/a90", I],
  // bg (32)
  ["bg/default", "white", "gray/900", B],
  ["bg/secondary", "gray/100", "gray/850", B],
  ["bg/tertiary", "gray/200", "gray/800", B],
  ["bg/hover", "gray/100", "gray/850", B],
  ["bg/transparent-hover", "black/a5", "white/a5", B],
  ["bg/transparent-pressed", "black/a10", "white/a10", B],
  ["bg/selected", "brand/100", "brand/dark-tint", B],
  ["bg/selected-secondary", "brand/50", "brand/dark-tint-secondary", B],
  ["bg/selected-hover", "brand/200", "brand/dark-tint-hover", B],
  ["bg/brand", "brand/500", "brand/550", B],
  ["bg/brand-hover", "brand/600", "brand/700", B],
  ["bg/danger", "red/500", "red/600", B],
  ["bg/danger-hover", "red/600", "red/700", B],
  ["bg/danger-tertiary", "red/100", "red/900", B],
  ["bg/success", "green/500", "green/600", B],
  ["bg/success-tertiary", "green/100", "green/900", B],
  ["bg/warning", "yellow/500", "yellow/500", B],
  ["bg/warning-tertiary", "yellow/100", "yellow/700", B],
  ["bg/component", "purple/500", "purple/600", B],
  ["bg/component-hover", "purple/600", "purple/700", B],
  ["bg/component-tertiary", "purple/100", "purple/900", B],
  ["bg/disabled", "gray/300", "gray/700", B],
  ["bg/inverse", "gray/900", "white", B],
  ["bg/canvas", "gray/100", "gray/950", B],
  ["bg/menu", "gray/950", "gray/950", B],
  ["bg/menu-highlight", "brand/550", "brand/550", B],
  ["bg/tabbar", "gray/200", "gray/850", B],
  ["bg/tabbar-hover", "gray/300", "gray/800", B],
  ["bg/switch-hover", "gray/100", "gray/750", B],
  ["bg/knob", "white", "white", B],
  ["bg/scrim", "black/a40", "black/a40", B],
  ["bg/overlay", "black/a50", "black/a50", B],
  // border (16)
  ["border/default", "gray/200", "gray/800", S],
  ["border/strong", "gray/900", "white/a90", S],
  ["border/hover", "gray/400", "gray/750", S],
  ["border/selected", "brand/500", "brand/550", S],
  ["border/selected-strong", "brand/600", "brand/300", S],
  ["border/brand", "brand/200", "brand/800", S],
  ["border/danger", "red/200", "red/800", S],
  ["border/danger-strong", "red/600", "red/300", S],
  ["border/warning", "yellow/200", "yellow/900", S],
  ["border/component", "purple/200", "purple/800", S],
  ["border/disabled", "black/a30", "white/a40", S],
  ["border/oncolor", "white", "white", S],
  ["border/translucent", "black/a10", "white/a10", S],
  ["border/translucent-strong", "black/a20", "white/a20", S],
  ["border/tabbar", "gray/300", "gray/800", S],
  ["border/menu", "gray/850", "gray/850", S],
  // component (17)
  ["scrollbar/thumb", "black/a20", "white/a20", B],
  ["scrollbar/thumb-hover", "black/a40", "white/a40", B],
  ["selection/text", "brand/a40", "brand/a40", B],
  ["selection/marquee", "brand/a10", "brand/a10", B],
  ["picker/ring", "black/a30", "black/a30", S],
  ["picker/stop-shadow", "black/a20", "black/a20", B],
  ["picker/empty", "gray/300", "gray/300", B],
  ["ai/shine", "white/a70", "white/a30", B],
  ["folder/blue", "blue/500", "blue/550", B],
  ["folder/red", "red/500", "red/600", B],
  ["folder/green", "green/500", "green/600", B],
  ["folder/yellow", "yellow/500", "yellow/500", B],
  ["folder/purple", "purple/500", "purple/600", B],
  ["folder/orange", "orange/500", "orange/500", B],
  ["folder/teal", "teal/500", "teal/500", B],
  ["folder/pink", "pink/500", "pink/500", B],
  ["folder/gray", "gray/500", "gray/500", B],
];
const color = rows.map(([name, light, dark, scopes]) => ({ name, type: "COLOR", values: { Light: light, Dark: dark }, scopes }));
const okColor = await upsert(s, "Color", ["Light", "Dark"], color, ["Brand", P]);
process.exit(okBrand && okColor ? 0 : 1);
