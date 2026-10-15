// Design system v2, step 3 (docs/design-system-v2.md §b, "Collections and modes"): the size collections, each its own
// set of modes so a page can be Round and Compact independently — Radius (Sharp | Default | Round), Size (Compact |
// Default | Comfortable: control and row heights, a control's padding and gap; icon, panel and dialog sizes are the
// same in every density) and Space (the spacing scale). Every value aliases Primitives' number scale.
import { session, upsert } from "./lib.mjs";

const s = await session();
const P = ["Primitives"];
const n = (x) => `number/${x}`;
const each = (modes, values) => Object.fromEntries(modes.map((m, i) => [m, n(Array.isArray(values) ? values[i] : values)]));

const R = ["Sharp", "Default", "Round"];
const radius = [
  ["radius/none", [0, 0, 0]],
  ["radius/small", [0, 2, 4]],
  ["radius/medium", [2, 5, 8]],
  ["radius/large", [4, 9, 13]],
  ["radius/xlarge", [6, 13, 20]],
  ["radius/full", ["full", "full", "full"]],
].map(([name, v]) => ({ name, type: "FLOAT", values: each(R, v), scopes: ["CORNER_RADIUS"] }));

const D = ["Compact", "Default", "Comfortable"];
const WH = ["WIDTH_HEIGHT"];
const size = [
  // Heights that follow the density
  ["size/control", [20, 24, 28], WH],
  ["size/control-large", [28, 32, 36], WH],
  ["size/row", [28, 32, 36], WH],
  ["size/row-large", [36, 40, 44], WH],
  ["size/nav", [24, 28, 32], WH],
  ["size/toolbar", [40, 48, 56], WH],
  ["padding/control", [6, 8, 12], ["GAP"]],
  ["gap/control", [2, 4, 6], ["GAP"]],
  // The same in every density
  ["size/icon", 16, WH],
  ["size/icon-large", 24, WH],
  ["size/checkbox", 16, WH],
  ["size/switch-width", 28, WH],
  ["size/switch-height", 16, WH],
  ["size/tabbar", 38, WH],
  ["size/rail", 56, WH],
  ["size/panel", 240, WH],
  ["size/popover", 240, WH],
  ["size/menu-max", 320, WH],
  ["size/dialog-small", 320, WH],
  ["size/dialog", 480, WH],
  ["size/dialog-large", 640, WH],
  ["stroke/default", 1, ["STROKE_FLOAT"]],
  ["stroke/strong", 2, ["STROKE_FLOAT"]],
].map(([name, v, scopes]) => ({ name, type: "FLOAT", values: each(D, v), scopes }));

const space = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64].map((x) => ({ name: `space/${x}`, type: "FLOAT", values: { Value: n(x) }, scopes: ["GAP"] }));

const ok = [await upsert(s, "Radius", R, radius, P), await upsert(s, "Size", D, size, P), await upsert(s, "Space", ["Value"], space, P)];
// "Default" is each collection's default mode (a page with no mode set looks like the app today)
for (const c of ["Radius", "Size"]) await s.call("edit_variable_collection", { collectionId: c, action: "set_default_mode", mode: "Default" });
process.exit(ok.every(Boolean) ? 0 : 1);
