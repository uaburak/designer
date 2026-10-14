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

// ---- tree prep -------------------------------------------------------------------------------------------------------
const cleanCls = (c) => {
  const m = /^_([A-Za-z0-9]+)_[a-z0-9]{5}_\d+$/.exec(c);
  return m ? m[1] : /^[a-z][A-Za-z0-9]+$/.test(c) ? c : null;
};
const visual = (n) => n.kind === "box" && (n.c.bg || n.bw.some((w) => w > 0) || n.sh.length || n.bgi || n.ow || n.op != null);
const same = (a, b) => Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6 && Math.abs(a.w - b.w) < 0.6 && Math.abs(a.h - b.h) < 0.6;
const ABS = (n) => n.abs || n.pos === "absolute" || n.pos === "fixed";

/** Cleans class names and folds wrappers that draw nothing around one child of the same box. */
export function prep(n) {
  if (!n) return n;
  if (n.tag === "::before" || n.tag === "::after") {
    // A pseudo-element: a plain box in its element's colours
    const bt = n.bc;
    n.c = { bg: n.bg, bt, br: bt, bb: bt, bl: bt };
    n.cd = n.cd ? { bg: n.cd.bg, bt: n.cd.bt, br: n.cd.bt, bb: n.cd.bt, bl: n.cd.bt } : undefined;
    Object.assign(n, { sh: [], pad: [0, 0, 0, 0], mar: [0, 0, 0, 0], gap: [0, 0], d: "block", pos: "absolute", cls: [n.name], ow: 0 });
  }
  if (n.cls) n.cls = n.cls.map(cleanCls).filter(Boolean);
  n.children = (n.children ?? []).map(prep).filter(Boolean);
  if (n.kind === "box" && !n.ds && !visual(n) && !n.clip && n.children.length === 1) {
    const c = n.children[0];
    if (c.kind === "box" && same(n, c)) {
      // The child takes the wrapper's place in its parent.
      return { ...c, fg: Math.max(n.fg ?? 0, c.fg ?? 0), as: n.as !== "auto" ? n.as : c.as, pos: n.pos, mar: n.mar, cls: c.cls?.length ? c.cls : n.cls };
    }
  }
  return n;
}

export const nameOf = (n) => (n.kind === "text" ? n.chars.slice(0, 40) : n.ds ?? (n.cls?.[0] || null) ?? (n.kind === "box" ? n.tag : n.kind));

/** A node's shape: what has to match for an occurrence to be an instance of a main (text, icons and pictures vary). */
export function sig(n) {
  if (n.kind === "text") return "T";
  if (n.kind === "icon") return "I";
  if (n.kind !== "box") return "P";
  return `${n.ds ?? ""}.${(n.cls ?? []).join(".")}${n.state ? `[${n.state}]` : ""}${Math.round(n.op ?? 1) !== 1 ? "~" : ""}(${n.children.map(sig).join(",")})`;
}

// ---- layout ----------------------------------------------------------------------------------------------------------
const tol = 1.6;
const P_ALIGN = { normal: "MIN", "flex-start": "MIN", start: "MIN", left: "MIN", center: "CENTER", "flex-end": "MAX", end: "MAX", right: "MAX", "space-between": "SPACE_BETWEEN" };
const C_ALIGN = { center: "CENTER", "flex-end": "MAX", end: "MAX", "self-end": "MAX", "flex-start": "MIN", start: "MIN", "self-start": "MIN", baseline: "MIN", stretch: "STRETCH", normal: "STRETCH" };

/** Auto layout for a box when its flex settings reproduce the captured positions; null otherwise. */
export function autoLayout(n) {
  if (n.kind !== "box" || !/flex$/.test(n.d ?? "") || n.fw !== "nowrap") return null;
  const flow = n.children.filter((c) => !ABS(c));
  if (!flow.length) return null;
  if (!["row", "column"].includes(n.fd)) return null;
  if (flow.some((c) => c.mar && c.mar.some((m) => Math.abs(m) > 0.1))) return null;
  const H = n.fd === "row";
  const pad = [n.pad[0] + n.bw[0], n.pad[1] + n.bw[1], n.pad[2] + n.bw[2], n.pad[3] + n.bw[3]];
  const x0 = n.x + pad[3], y0 = n.y + pad[0];
  const iw = n.w - pad[1] - pad[3], ih = n.h - pad[0] - pad[2];
  const inner = H ? iw : ih, cross = H ? ih : iw;
  const gap = H ? n.gap[1] : n.gap[0];
  let pAlign = P_ALIGN[n.jc];
  if (!pAlign) return null;
  const sizes = flow.map((c) => (H ? c.w : c.h));
  const sum = sizes.reduce((a, b) => a + b, 0);
  const total = sum + gap * (flow.length - 1);
  let start = pAlign === "CENTER" ? (inner - total) / 2 : pAlign === "MAX" ? inner - total : 0;
  let step = gap;
  if (pAlign === "SPACE_BETWEEN") {
    step = flow.length > 1 ? (inner - sum) / (flow.length - 1) : 0;
    if (flow.length === 1) pAlign = "MIN";
  }
  let at = start;
  for (let i = 0; i < flow.length; i++) {
    const c = flow[i];
    const actual = H ? c.x - x0 : c.y - y0;
    if (Math.abs(actual - at) > tol) return null;
    at += sizes[i] + step;
  }
  // Cross axis: one alignment for all (stretched children fill).
  let cAlign = null;
  const fill = [];
  for (const c of flow) {
    const a = C_ALIGN[c.as && c.as !== "auto" ? c.as : n.ai] ?? "MIN";
    const cs = H ? c.h : c.w;
    const pos = H ? c.y - y0 : c.x - x0;
    if (a === "STRETCH" && Math.abs(cs - cross) < tol && Math.abs(pos) < tol) {
      fill.push(true);
      continue;
    }
    fill.push(false);
    const want = a === "STRETCH" ? "MIN" : a;
    const exp = want === "CENTER" ? (cross - cs) / 2 : want === "MAX" ? cross - cs : 0;
    if (Math.abs(pos - exp) > tol) {
      // Its own alignment doesn't hold (baseline, auto margins): any alignment that does?
      const alt = ["MIN", "CENTER", "MAX"].find((k) => Math.abs(pos - (k === "CENTER" ? (cross - cs) / 2 : k === "MAX" ? cross - cs : 0)) <= tol);
      if (!alt || (cAlign && cAlign !== alt && Math.abs(cross - cs) > tol)) return null;
      if (Math.abs(cross - cs) > tol) cAlign = alt;
      continue;
    }
    if (Math.abs(cross - cs) <= tol) continue; // any alignment fits
    if (cAlign && cAlign !== want) return null;
    cAlign = want;
  }
  const grows = flow.map((c) => (c.fg ?? 0) > 0 && Math.abs((H ? c.w : c.h) - 0) > 0);
  const hugP = pAlign !== "SPACE_BETWEEN" && Math.abs(inner - total) < 1 && !grows.some(Boolean);
  const maxCross = Math.max(...flow.map((c) => (H ? c.h : c.w)));
  const hugC = Math.abs(cross - maxCross) < 1 && !fill.every(Boolean);
  return { mode: H ? "HORIZONTAL" : "VERTICAL", pad, gap: pAlign === "SPACE_BETWEEN" ? 0 : Math.max(0, gap), pAlign, cAlign: cAlign ?? "MIN", flow, fill, grows, hugP, hugC: hugC || (fill.every(Boolean) && Math.abs(cross - maxCross) < 1) };
}

// ---- specs -----------------------------------------------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100;
const WEIGHTS = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 450: "Regular", 500: "Medium", 550: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
const fontStyle = (w, italic) => {
  const base = WEIGHTS[w] ?? (w < 450 ? "Regular" : w < 600 ? "Medium" : "Bold");
  return italic ? (base === "Regular" ? "Italic" : `${base} Italic`) : base;
};

/**
 * The spec of a node. ctx: { parentAL, parentFlowIndex?, fill?, grow?, px, py } — how its parent lays it out.
 * Specs carry build.mjs's notes under `_`: { src, binds: [{field, light, dark, usage}], slot, textStyle }.
 */
export function toSpec(n, ctx, opts) {
  const { slotFor } = opts;
  const inAL = ctx.parentAL && ctx.parentAL !== "NONE";
  const abs = ABS(n);
  const place = {};
  if (!inAL || abs) {
    place.x = r2(n.x - ctx.px);
    place.y = r2(n.y - ctx.py);
    if (inAL) place.layoutPositioning = "ABSOLUTE";
  }
  const H = ctx.parentAL === "HORIZONTAL";
  /** Sizing in an auto layout parent from (fill across, grow along, hug flags). */
  const sizing = (hugW, hugH) => {
    if (!inAL || abs) return { w: hugW ? "HUG" : "FIXED", h: hugH ? "HUG" : "FIXED" };
    const along = ctx.grow ? "FILL" : null;
    const across = ctx.fill ? "FILL" : null;
    const w = H ? along : across;
    const h = H ? across : along;
    return { w: w ?? (hugW ? "HUG" : "FIXED"), h: h ?? (hugH ? "HUG" : "FIXED") };
  };
  const applySizing = (spec, s, isFrameOrText) => {
    if (inAL && !abs) {
      spec.layoutSizingHorizontal = s.w;
      spec.layoutSizingVertical = s.h;
    }
    if (s.w === "FIXED" || (!inAL && s.w !== "HUG")) spec.width = r2(Math.max(0.01, n.w));
    if (s.h === "FIXED" || (!inAL && s.h !== "HUG")) spec.height = r2(Math.max(0.01, n.h));
    if (!isFrameOrText) {
      spec.width = r2(Math.max(0.01, n.w));
      spec.height = r2(Math.max(0.01, n.h));
    }
  };

  if (n.kind === "text") return textSpec(n, ctx, place, sizing, applySizing);

  if (n.kind === "icon" || (isLeaf(n) && slotFor && ctx.depth > 0)) {
    const slot = n.kind === "icon" ? { icon: n.icon, src: n } : slotFor(n);
    if (slot) {
      const spec = { type: "FRAME", name: "__slot", fills: [], ...place, _: { src: n, slot } };
      // An instance's own sizing: a hugging main hugs, else its captured size.
      const s = sizing(slot.hugW ?? false, slot.hugH ?? false);
      spec._.sizing = s;
      spec.width = r2(Math.max(0.01, n.w));
      spec.height = r2(Math.max(0.01, n.h));
      if (inAL && !abs) {
        spec.layoutSizingHorizontal = s.w === "HUG" ? "FIXED" : s.w;
        spec.layoutSizingVertical = s.h === "HUG" ? "FIXED" : s.h;
      }
      return spec;
    }
  }

  if (n.kind === "svg" || n.kind === "img" || n.kind === "raster") {
    const spec = { type: "RECTANGLE", name: n.kind === "raster" ? "Canvas" : n.kind === "img" ? "Image" : "Graphic", ...place, _: { src: n, image: n.image } };
    applySizing(spec, sizing(false, false), false);
    if (n.rad && n.rad.some((v) => v > 0)) spec.cornerRadius = n.rad.every((v) => v === n.rad[0]) ? r2(n.rad[0]) : n.rad.map(r2);
    if (n.op != null) spec.opacity = n.op;
    if (inAL && !abs) {
      if (ctx.fill || ctx.grow) applySizing(spec, sizing(false, false), true);
    }
    return spec;
  }

  // A box: a frame.
  const binds = [];
  const spec = { type: "FRAME", name: nameOf(n), ...place, _: { src: n, binds } };
  const bg = n.c.bg;
  spec.fills = bg ? [bg] : [];
  if (bg) binds.push({ field: "fills[0]", light: bg, dark: n.cd?.bg, usage: "fill" });
  if (n.bgi) spec.fills.push(...gradients(n.bgi));
  const bw = n.bw;
  if (bw.some((w) => w > 0)) {
    const col = n.c.bt && bw[0] ? n.c.bt : n.c.bl && bw[3] ? n.c.bl : n.c.bb && bw[2] ? n.c.bb : n.c.br;
    const dcol = n.cd ? (bw[0] ? n.cd.bt : bw[3] ? n.cd.bl : bw[2] ? n.cd.bb : n.cd.br) : null;
    if (col) {
      spec.strokes = [col];
      spec.strokeAlign = "INSIDE";
      binds.push({ field: "strokes[0]", light: col, dark: dcol, usage: "stroke" });
      if (bw.every((w) => w === bw[0])) spec.strokeWeight = bw[0];
      else Object.assign(spec, { strokeTopWeight: bw[0], strokeRightWeight: bw[1], strokeBottomWeight: bw[2], strokeLeftWeight: bw[3] });
    }
  } else if (n.ow > 0 && n.c.oc) {
    spec.strokes = [n.c.oc];
    spec.strokeAlign = "OUTSIDE";
    spec.strokeWeight = n.ow;
    binds.push({ field: "strokes[0]", light: n.c.oc, dark: n.cd?.oc, usage: "stroke" });
  }
  if (n.rad.some((v) => v > 0)) spec.cornerRadius = n.rad.every((v) => v === n.rad[0]) ? r2(n.rad[0]) : n.rad.map(r2);
  if (n.sh.length) spec.effects = n.sh.map((s) => ({ type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW", color: s.color.length === 7 ? s.color + "ff" : s.color, offset: { x: s.x, y: s.y }, radius: s.blur, spread: s.spread, visible: true, blendMode: "NORMAL" }));
  if (n.op != null) spec.opacity = r2(n.op);
  spec.clipsContent = !!n.clip;

  const al = autoLayout(n);
  let hugW = false, hugH = false;
  if (al) {
    Object.assign(spec, { layoutMode: al.mode, itemSpacing: r2(al.gap), padding: al.pad.map(r2), primaryAxisAlignItems: al.pAlign, counterAxisAlignItems: al.cAlign });
    const HH = al.mode === "HORIZONTAL";
    // A frame can't hug along an axis a child fills.
    const anyGrow = al.grows.some(Boolean);
    hugW = HH ? al.hugP && !anyGrow : al.hugC && !al.fill.some(Boolean);
    hugH = HH ? al.hugC && !al.fill.some(Boolean) : al.hugP && !anyGrow;
  }
  const s = sizing(hugW, hugH);
  applySizing(spec, s, true);
  if (al) {
    // primaryAxisSizingMode / counterAxisSizingMode for frames outside auto layout
    if (!inAL || abs) {
      const HH = al.mode === "HORIZONTAL";
      spec.primaryAxisSizingMode = (HH ? hugW : hugH) ? "AUTO" : "FIXED";
      spec.counterAxisSizingMode = (HH ? hugH : hugW) ? "AUTO" : "FIXED";
    }
  }
  const flowIdx = new Map((al?.flow ?? []).map((c, i) => [c, i]));
  spec.children = n.children
    .map((c) => {
      const i = flowIdx.get(c);
      const cctx = al
        ? { parentAL: al.mode, fill: i != null && al.fill[i], grow: i != null && al.grows[i], px: n.x, py: n.y, depth: ctx.depth + 1 }
        : { parentAL: "NONE", px: n.x, py: n.y, depth: ctx.depth + 1 };
      return toSpec(c, cctx, opts);
    })
    .filter(Boolean);
  return spec;
}

const hex2 = (c) => {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const h = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
};
const DIRS = {
  "to right": { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  "90deg": { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  "to left": { m00: -1, m01: 0, m02: 1, m10: 0, m11: -1, m12: 1 },
  "270deg": { m00: -1, m01: 0, m02: 1, m10: 0, m11: -1, m12: 1 },
  "to bottom": { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
  "180deg": { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
  "to top": { m00: 0, m01: -1, m02: 1, m10: 1, m11: 0, m12: 0 },
  "0deg": { m00: 0, m01: -1, m02: 1, m10: 1, m11: 0, m12: 0 },
};
/** CSS linear gradients (the colour picker's fields, the gradient bar) as paints, bottom first. */
export function gradients(bgi) {
  const layers = bgi.split(/,\s*(?=linear-gradient|repeating|radial|conic|url)/);
  const out = [];
  for (const l of layers.reverse()) {
    const m = /^linear-gradient\((.*)\)$/.exec(l.trim());
    if (!m) continue;
    const parts = m[1].split(/,(?![^(]*\))/).map((x) => x.trim());
    let dir = DIRS["180deg"];
    if (DIRS[parts[0]]) dir = DIRS[parts.shift()];
    else if (/^(to |-?\d)/.test(parts[0])) continue;
    const stops = parts.map((p, i) => {
      const pos = /(-?[\d.]+)%\s*$/.exec(p);
      return { color: hex2(p), position: pos ? Number(pos[1]) / 100 : parts.length > 1 ? i / (parts.length - 1) : 0 };
    });
    if (stops.length < 2 || stops.some((s) => !s.color)) continue;
    out.push({ type: "GRADIENT_LINEAR", stops, transform: dir });
  }
  return out;
}

function textSpec(n, ctx, place, sizing, applySizing) {
  const ts = n.ts;
  const fg = n.useph ? n.c?.ph : n.c?.fg;
  const spec = {
    type: "TEXT",
    name: n.chars.slice(0, 40),
    characters: n.chars,
    fontFamily: "Inter",
    fontStyle: fontStyle(ts.weight, ts.italic),
    fontSize: ts.size,
    lineHeight: r2(ts.lh ?? n.h / Math.max(1, n.lines ?? 1)),
    letterSpacing: r2(ts.ls ?? 0),
    ...place,
    _: { src: n, binds: [] },
  };
  if (ts.weight % 100 !== 0) spec.fontVariations = [{ axisTag: 0x77676874, axisName: "Weight", value: ts.weight }];
  if (fg) {
    spec.fills = [fg];
    spec._.binds.push({ field: "fills[0]", light: fg, dark: n.useph ? n.cd?.ph : n.cd?.fg, usage: "text" });
  }
  const al = { left: "LEFT", start: "LEFT", center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" }[ts.align];
  if (al && al !== "LEFT" && (n.fixed || n.boxW)) spec.textAlignHorizontal = al;
  if (ts.tt === "uppercase") spec.textCase = "UPPER";
  if (ts.tt === "lowercase") spec.textCase = "LOWER";
  if (ts.tt === "capitalize") spec.textCase = "TITLE";
  if (/underline/.test(ts.td)) spec.textDecoration = "UNDERLINE";
  if (/line-through/.test(ts.td)) spec.textDecoration = "STRIKETHROUGH";
  const multi = (n.lines ?? 1) > 1 || n.multi;
  const hugW = !n.fixed && !multi && !n.boxW;
  const s = sizing(hugW, !n.fixed || multi);
  spec.textAutoResize = s.w === "HUG" ? "WIDTH_AND_HEIGHT" : s.h === "HUG" ? "HEIGHT" : "NONE";
  applySizing(spec, s, true);
  if (spec.textAutoResize === "WIDTH_AND_HEIGHT") {
    delete spec.width;
    delete spec.height;
  } else if (spec.textAutoResize === "HEIGHT") delete spec.height;
  if (spec.textAutoResize === "NONE" && n.h > spec.lineHeight + 1) spec.textAlignVertical = n.vcenter ? "CENTER" : "TOP";
  if (ts.ell && spec.textAutoResize !== "WIDTH_AND_HEIGHT") {
    spec.textTruncation = "ENDING";
    spec.maxLines = 1;
  }
  spec._.textStyle = textStyleFor({ ...ts, lh: spec.lineHeight });
  return spec;
}

/**
 * A text-only box becomes the text itself, laid out as the box was (its width, its place in the parent): a box that
 * draws nothing and holds one text run.
 */
export function foldText(n) {
  if (!n) return n;
  n.children = (n.children ?? []).map(foldText);
  if (n.kind === "box" && !n.ds && !visual(n) && n.children.length === 1 && n.children[0].kind === "text" && n.pad.every((p) => p === 0)) {
    const t = n.children[0];
    const boxW = Math.abs(n.w - t.w) > 1.5;
    return { ...t, x: n.x, y: n.y, w: n.w, h: n.h, boxW, fixed: t.fixed, vcenter: /flex/.test(n.d) && n.ai === "center", fg: n.fg, as: n.as, pos: n.pos, mar: n.mar, lines: t.lines, ts: { ...t.ts, align: /flex/.test(n.d) && n.fd === "row" && n.jc === "center" ? "center" : /flex/.test(n.d) && n.fd === "row" && /end$/.test(n.jc) ? "right" : (n.ts?.align ?? t.ts.align), ell: n.ts?.ell || t.ts.ell } };
  }
  return n;
}
