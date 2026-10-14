/**
 * A captured DOM tree (walker.js) as create_nodes specs (src/shared/agents/tools.ts): boxes → frames (flex → auto
 * layout when the captured positions prove it, else absolute positions), text runs → text, pictures → rectangles the
 * caller fills. Pure, no I/O. Shared by agents' `capture_web_design` (src/main/agents/reach/web.ts, docs/agents-reach.md
 * §5.3) and tools/ui-kit (convert.mjs adds Wecra's tokens and ds components on top).
 */

/** A node as walker.js captures it (boxes, text runs, icons, SVGs, images, rasters). Loose on purpose: it is page data. */
export interface WNode {
  i?: number;
  kind: "box" | "text" | "icon" | "svg" | "img" | "raster";
  tag?: string;
  ds?: string | null;
  cls?: string[];
  name?: string;
  label?: string | null;
  state?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  op?: number;
  /** Colours: background, borders, outline, text, placeholder */
  c?: Record<string, string | null | undefined | unknown>;
  /** Dark colours (ui-kit's second pass) */
  cd?: Record<string, string | null | undefined | unknown>;
  children: WNode[];
  d?: string;
  pos?: string;
  fd?: string;
  fw?: string;
  jc?: string;
  ai?: string;
  as?: string;
  fg?: number;
  gap?: [number, number];
  pad?: number[];
  bw?: number[];
  mar?: number[];
  ow?: number;
  rad?: number[];
  sh?: { inset: boolean; x: number; y: number; blur: number; spread: number; color: string }[];
  clip?: boolean;
  bgi?: string | null;
  ts?: TextStyle;
  abs?: boolean;
  // text
  chars?: string;
  lines?: number;
  fixed?: boolean;
  multi?: boolean;
  useph?: boolean;
  boxW?: boolean;
  vcenter?: boolean;
  // pictures
  icon?: string;
  svg?: string;
  src?: string;
  image?: unknown;
  // pseudo-elements
  bg?: string | null;
  bc?: string | null;
  [k: string]: unknown;
}

export interface TextStyle {
  font?: string;
  size: number;
  weight: number;
  lh?: number | null;
  ls?: number;
  align?: string;
  tt?: string;
  td?: string;
  ws?: string;
  ell?: boolean;
  italic?: boolean;
}

export type Spec = Record<string, unknown> & { type: string; children?: Spec[]; _?: SpecNotes };
export interface SpecNotes {
  src: WNode;
  binds?: { field: string; light: unknown; dark: unknown; usage: string }[];
  slot?: unknown;
  sizing?: { w: string; h: string };
  textStyle?: string | null;
  image?: unknown;
}

export interface SpecContext {
  parentAL: "HORIZONTAL" | "VERTICAL" | "NONE";
  fill?: boolean;
  grow?: boolean;
  px: number;
  py: number;
  depth: number;
}

export interface SpecOptions {
  /** ds components that become instances (ui-kit): a node's slot, or null */
  slotFor?: (n: WNode) => ({ hugW?: boolean; hugH?: boolean } & Record<string, unknown>) | null;
  /** Which boxes slotFor is asked about (ui-kit: ds leaves) */
  isLeaf?: (n: WNode) => boolean;
  /** The font family a CSS font-family list becomes (default: Inter) */
  font?: (cssFamily: string | undefined) => string;
}

const col = (c: WNode["c"], k: string) => (c?.[k] as string | null | undefined) ?? null;

// ---- tree prep -------------------------------------------------------------------------------------------------------
const cleanCls = (c: string) => {
  const m = /^_([A-Za-z0-9]+)_[a-z0-9]{5}_\d+$/.exec(c);
  return m ? m[1] : /^[a-z][A-Za-z0-9]+$/.test(c) ? c : null;
};
const visual = (n: WNode) => n.kind === "box" && !!(col(n.c, "bg") || (n.bw ?? []).some((w) => w > 0) || n.sh?.length || n.bgi || n.ow || n.op != null);
const same = (a: WNode, b: WNode) => Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6 && Math.abs(a.w - b.w) < 0.6 && Math.abs(a.h - b.h) < 0.6;
const ABS = (n: WNode) => !!n.abs || n.pos === "absolute" || n.pos === "fixed";

/** Cleans class names and folds wrappers that draw nothing around one child of the same box. */
export function prep(n: WNode): WNode {
  if (!n) return n;
  if (n.tag === "::before" || n.tag === "::after") {
    // A pseudo-element: a plain box in its element's colours
    const bt = n.bc;
    n.c = { bg: n.bg, bt, br: bt, bb: bt, bl: bt };
    n.cd = n.cd ? { bg: n.cd.bg, bt: n.cd.bt, br: n.cd.bt, bb: n.cd.bt, bl: n.cd.bt } : undefined;
    Object.assign(n, { sh: [], pad: [0, 0, 0, 0], mar: [0, 0, 0, 0], gap: [0, 0], d: "block", pos: "absolute", cls: [n.name ?? ""], ow: 0 });
  }
  if (n.cls) n.cls = n.cls.map(cleanCls).filter((c): c is string => !!c);
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

export const nameOf = (n: WNode): string => (n.kind === "text" ? (n.chars ?? "").slice(0, 40) : (n.ds ?? (n.cls?.[0] || null) ?? (n.kind === "box" ? (n.tag ?? "box") : n.kind)));

/** A node's shape: what has to match for an occurrence to be an instance of a main (text, icons and pictures vary). */
export function sig(n: WNode): string {
  if (n.kind === "text") return "T";
  if (n.kind === "icon") return "I";
  if (n.kind !== "box") return "P";
  return `${n.ds ?? ""}.${(n.cls ?? []).join(".")}${n.state ? `[${n.state}]` : ""}${Math.round(n.op ?? 1) !== 1 ? "~" : ""}(${n.children.map(sig).join(",")})`;
}

// ---- layout ----------------------------------------------------------------------------------------------------------
const tol = 1.6;
const P_ALIGN: Record<string, string> = { normal: "MIN", "flex-start": "MIN", start: "MIN", left: "MIN", center: "CENTER", "flex-end": "MAX", end: "MAX", right: "MAX", "space-between": "SPACE_BETWEEN" };
const C_ALIGN: Record<string, string> = { center: "CENTER", "flex-end": "MAX", end: "MAX", "self-end": "MAX", "flex-start": "MIN", start: "MIN", "self-start": "MIN", baseline: "MIN", stretch: "STRETCH", normal: "STRETCH" };

export interface AutoLayout {
  mode: "HORIZONTAL" | "VERTICAL";
  pad: number[];
  gap: number;
  pAlign: string;
  cAlign: string;
  flow: WNode[];
  fill: boolean[];
  grows: boolean[];
  hugP: boolean;
  hugC: boolean;
}

/** Auto layout for a box when its flex settings reproduce the captured positions; null otherwise. */
export function autoLayout(n: WNode): AutoLayout | null {
  if (n.kind !== "box" || !/flex$/.test(n.d ?? "") || n.fw !== "nowrap") return null;
  const flow = n.children.filter((c) => !ABS(c));
  if (!flow.length) return null;
  if (n.fd !== "row" && n.fd !== "column") return null;
  if (flow.some((c) => c.mar && c.mar.some((m) => Math.abs(m) > 0.1))) return null;
  const H = n.fd === "row";
  const p = n.pad ?? [0, 0, 0, 0];
  const b = n.bw ?? [0, 0, 0, 0];
  const pad = [p[0] + b[0], p[1] + b[1], p[2] + b[2], p[3] + b[3]];
  const x0 = n.x + pad[3],
    y0 = n.y + pad[0];
  const iw = n.w - pad[1] - pad[3],
    ih = n.h - pad[0] - pad[2];
  const inner = H ? iw : ih,
    cross = H ? ih : iw;
  const gaps = n.gap ?? [0, 0];
  const gap = H ? gaps[1] : gaps[0];
  let pAlign = P_ALIGN[n.jc ?? ""];
  if (!pAlign) return null;
  const sizes = flow.map((c) => (H ? c.w : c.h));
  const sum = sizes.reduce((a, v) => a + v, 0);
  const total = sum + gap * (flow.length - 1);
  const start = pAlign === "CENTER" ? (inner - total) / 2 : pAlign === "MAX" ? inner - total : 0;
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
  let cAlign: string | null = null;
  const fill: boolean[] = [];
  for (const c of flow) {
    const a = C_ALIGN[c.as && c.as !== "auto" ? c.as : (n.ai ?? "")] ?? "MIN";
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
  const grows = flow.map((c) => (c.fg ?? 0) > 0 && Math.abs(H ? c.w : c.h) > 0);
  const hugP = pAlign !== "SPACE_BETWEEN" && Math.abs(inner - total) < 1 && !grows.some(Boolean);
  const maxCross = Math.max(...flow.map((c) => (H ? c.h : c.w)));
  const hugC = Math.abs(cross - maxCross) < 1 && !fill.every(Boolean);
  return { mode: H ? "HORIZONTAL" : "VERTICAL", pad, gap: pAlign === "SPACE_BETWEEN" ? 0 : Math.max(0, gap), pAlign, cAlign: cAlign ?? "MIN", flow, fill, grows, hugP, hugC: hugC || (fill.every(Boolean) && Math.abs(cross - maxCross) < 1) };
}

// ---- specs -----------------------------------------------------------------------------------------------------------
const r2 = (v: number) => Math.round(v * 100) / 100;
const WEIGHTS: Record<number, string> = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 450: "Regular", 500: "Medium", 550: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
const fontStyle = (w: number, italic?: boolean) => {
  const base = WEIGHTS[w] ?? (w < 450 ? "Regular" : w < 600 ? "Medium" : "Bold");
  return italic ? (base === "Regular" ? "Italic" : `${base} Italic`) : base;
};

type Sizing = { w: string; h: string };

/**
 * The spec of a node. ctx: how its parent lays it out. Specs carry notes under `_` (the source node, colour binds,
 * slots, text styles) for the caller; `stripNotes` removes them before create_nodes.
 */
export function toSpec(n: WNode, ctx: SpecContext, opts: SpecOptions = {}): Spec | null {
  const { slotFor } = opts;
  const inAL = ctx.parentAL && ctx.parentAL !== "NONE";
  const abs = ABS(n);
  const place: Record<string, unknown> = {};
  if (!inAL || abs) {
    place.x = r2(n.x - ctx.px);
    place.y = r2(n.y - ctx.py);
    if (inAL) place.layoutPositioning = "ABSOLUTE";
  }
  const H = ctx.parentAL === "HORIZONTAL";
  /** Sizing in an auto layout parent from (fill across, grow along, hug flags). */
  const sizing = (hugW: boolean, hugH: boolean): Sizing => {
    if (!inAL || abs) return { w: hugW ? "HUG" : "FIXED", h: hugH ? "HUG" : "FIXED" };
    const along = ctx.grow ? "FILL" : null;
    const across = ctx.fill ? "FILL" : null;
    const w = H ? along : across;
    const h = H ? across : along;
    return { w: w ?? (hugW ? "HUG" : "FIXED"), h: h ?? (hugH ? "HUG" : "FIXED") };
  };
  const applySizing = (spec: Spec, s: Sizing, isFrameOrText: boolean) => {
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

  if (n.kind === "text") return textSpec(n, place, sizing, applySizing, opts);

  if (n.kind === "icon" || (opts.isLeaf?.(n) && slotFor && ctx.depth > 0)) {
    const slot = n.kind === "icon" ? { icon: n.icon, src: n } : slotFor?.(n);
    if (slot) {
      const spec: Spec = { type: "FRAME", name: "__slot", fills: [], ...place, _: { src: n, slot } };
      // An instance's own sizing: a hugging main hugs, else its captured size.
      const s = sizing(!!(slot as { hugW?: boolean }).hugW, !!(slot as { hugH?: boolean }).hugH);
      spec._!.sizing = s;
      spec.width = r2(Math.max(0.01, n.w));
      spec.height = r2(Math.max(0.01, n.h));
      if (inAL && !abs) {
        spec.layoutSizingHorizontal = s.w === "HUG" ? "FIXED" : s.w;
        spec.layoutSizingVertical = s.h === "HUG" ? "FIXED" : s.h;
      }
      return spec;
    }
  }

  if (n.kind === "svg" || n.kind === "img" || n.kind === "raster" || n.kind === "icon") {
    const spec: Spec = { type: "RECTANGLE", name: n.kind === "raster" ? "Canvas" : n.kind === "img" ? "Image" : "Graphic", ...place, _: { src: n, image: n.image } };
    applySizing(spec, sizing(false, false), false);
    if (n.rad && n.rad.some((v) => v > 0)) spec.cornerRadius = n.rad.every((v) => v === n.rad![0]) ? r2(n.rad[0]) : n.rad.map(r2);
    if (n.op != null) spec.opacity = n.op;
    if (inAL && !abs && (ctx.fill || ctx.grow)) applySizing(spec, sizing(false, false), true);
    return spec;
  }

  // A box: a frame.
  const binds: NonNullable<SpecNotes["binds"]> = [];
  const spec: Spec = { type: "FRAME", name: nameOf(n), ...place, _: { src: n, binds } };
  const bg = col(n.c, "bg");
  const fills: unknown[] = bg ? [bg] : [];
  if (bg) binds.push({ field: "fills[0]", light: bg, dark: n.cd?.bg, usage: "fill" });
  if (n.bgi) fills.push(...gradients(n.bgi));
  spec.fills = fills;
  const bw = n.bw ?? [0, 0, 0, 0];
  if (bw.some((w) => w > 0)) {
    const c = n.c ?? {};
    const color = (col(c, "bt") && bw[0] ? col(c, "bt") : col(c, "bl") && bw[3] ? col(c, "bl") : col(c, "bb") && bw[2] ? col(c, "bb") : col(c, "br")) as string | null;
    const dcol = n.cd ? (bw[0] ? n.cd.bt : bw[3] ? n.cd.bl : bw[2] ? n.cd.bb : n.cd.br) : null;
    if (color) {
      spec.strokes = [color];
      spec.strokeAlign = "INSIDE";
      binds.push({ field: "strokes[0]", light: color, dark: dcol, usage: "stroke" });
      if (bw.every((w) => w === bw[0])) spec.strokeWeight = bw[0];
      else Object.assign(spec, { strokeTopWeight: bw[0], strokeRightWeight: bw[1], strokeBottomWeight: bw[2], strokeLeftWeight: bw[3] });
    }
  } else if ((n.ow ?? 0) > 0 && col(n.c, "oc")) {
    spec.strokes = [col(n.c, "oc")];
    spec.strokeAlign = "OUTSIDE";
    spec.strokeWeight = n.ow;
    binds.push({ field: "strokes[0]", light: col(n.c, "oc"), dark: n.cd?.oc, usage: "stroke" });
  }
  const rad = n.rad ?? [0, 0, 0, 0];
  if (rad.some((v) => v > 0)) spec.cornerRadius = rad.every((v) => v === rad[0]) ? r2(rad[0]) : rad.map(r2);
  if (n.sh?.length) spec.effects = n.sh.map((s) => ({ type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW", color: s.color.length === 7 ? `${s.color}ff` : s.color, offset: { x: s.x, y: s.y }, radius: s.blur, spread: s.spread, visible: true, blendMode: "NORMAL" }));
  if (n.op != null) spec.opacity = r2(n.op);
  spec.clipsContent = !!n.clip;

  const al = autoLayout(n);
  let hugW = false,
    hugH = false;
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
  if (al && (!inAL || abs)) {
    // primaryAxisSizingMode / counterAxisSizingMode for frames outside auto layout
    const HH = al.mode === "HORIZONTAL";
    spec.primaryAxisSizingMode = (HH ? hugW : hugH) ? "AUTO" : "FIXED";
    spec.counterAxisSizingMode = (HH ? hugH : hugW) ? "AUTO" : "FIXED";
  }
  const flowIdx = new Map((al?.flow ?? []).map((c, i) => [c, i]));
  spec.children = n.children
    .map((c) => {
      const i = flowIdx.get(c);
      const cctx: SpecContext = al ? { parentAL: al.mode, fill: i != null && al.fill[i], grow: i != null && al.grows[i], px: n.x, py: n.y, depth: ctx.depth + 1 } : { parentAL: "NONE", px: n.x, py: n.y, depth: ctx.depth + 1 };
      return toSpec(c, cctx, opts);
    })
    .filter((x): x is Spec => !!x);
  return spec;
}

const hex2 = (c: string) => {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
};
const DIRS: Record<string, Record<string, number>> = {
  "to right": { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  "90deg": { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  "to left": { m00: -1, m01: 0, m02: 1, m10: 0, m11: -1, m12: 1 },
  "270deg": { m00: -1, m01: 0, m02: 1, m10: 0, m11: -1, m12: 1 },
  "to bottom": { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
  "180deg": { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
  "to top": { m00: 0, m01: -1, m02: 1, m10: 1, m11: 0, m12: 0 },
  "0deg": { m00: 0, m01: -1, m02: 1, m10: 1, m11: 0, m12: 0 },
};
/** CSS linear gradients as paints, bottom first (other gradients and url() images are left to the caller). */
export function gradients(bgi: string): Record<string, unknown>[] {
  const layers = bgi.split(/,\s*(?=linear-gradient|repeating|radial|conic|url)/);
  const out: Record<string, unknown>[] = [];
  for (const l of layers.reverse()) {
    const m = /^linear-gradient\((.*)\)$/.exec(l.trim());
    if (!m) continue;
    const parts = m[1].split(/,(?![^(]*\))/).map((x) => x.trim());
    let dir = DIRS["180deg"];
    if (DIRS[parts[0]]) dir = DIRS[parts.shift()!];
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

function textSpec(n: WNode, place: Record<string, unknown>, sizing: (w: boolean, h: boolean) => Sizing, applySizing: (s: Spec, z: Sizing, f: boolean) => void, opts: SpecOptions): Spec {
  const ts = n.ts ?? { size: 14, weight: 400 };
  const fg = n.useph ? col(n.c, "ph") : col(n.c, "fg");
  const chars = n.chars ?? "";
  const spec: Spec = {
    type: "TEXT",
    name: chars.slice(0, 40),
    characters: chars,
    fontFamily: opts.font ? opts.font(ts.font) : "Inter",
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
    spec._!.binds!.push({ field: "fills[0]", light: fg, dark: n.useph ? n.cd?.ph : n.cd?.fg, usage: "text" });
  }
  const al = ({ left: "LEFT", start: "LEFT", center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" } as Record<string, string>)[ts.align ?? ""];
  if (al && al !== "LEFT" && (n.fixed || n.boxW)) spec.textAlignHorizontal = al;
  if (ts.tt === "uppercase") spec.textCase = "UPPER";
  if (ts.tt === "lowercase") spec.textCase = "LOWER";
  if (ts.tt === "capitalize") spec.textCase = "TITLE";
  if (/underline/.test(ts.td ?? "")) spec.textDecoration = "UNDERLINE";
  if (/line-through/.test(ts.td ?? "")) spec.textDecoration = "STRIKETHROUGH";
  const multi = (n.lines ?? 1) > 1 || n.multi;
  const hugW = !n.fixed && !multi && !n.boxW;
  const s = sizing(hugW, !n.fixed || !!multi);
  spec.textAutoResize = s.w === "HUG" ? "WIDTH_AND_HEIGHT" : s.h === "HUG" ? "HEIGHT" : "NONE";
  applySizing(spec, s, true);
  if (spec.textAutoResize === "WIDTH_AND_HEIGHT") {
    delete spec.width;
    delete spec.height;
  } else if (spec.textAutoResize === "HEIGHT") delete spec.height;
  if (spec.textAutoResize === "NONE" && n.h > (spec.lineHeight as number) + 1) spec.textAlignVertical = n.vcenter ? "CENTER" : "TOP";
  if (ts.ell && spec.textAutoResize !== "WIDTH_AND_HEIGHT") {
    spec.textTruncation = "ENDING";
    spec.maxLines = 1;
  }
  return spec;
}

/**
 * A text-only box becomes the text itself, laid out as the box was (its width, its place in the parent): a box that
 * draws nothing and holds one text run.
 */
export function foldText(n: WNode): WNode {
  if (!n) return n;
  n.children = (n.children ?? []).map(foldText);
  if (n.kind === "box" && !n.ds && !visual(n) && n.children.length === 1 && n.children[0].kind === "text" && (n.pad ?? [0]).every((p) => p === 0)) {
    const t = n.children[0];
    const boxW = Math.abs(n.w - t.w) > 1.5;
    const flex = /flex/.test(n.d ?? "");
    const tts = t.ts ?? { size: 14, weight: 400 };
    return { ...t, x: n.x, y: n.y, w: n.w, h: n.h, boxW, fixed: t.fixed, vcenter: flex && n.ai === "center", fg: n.fg, as: n.as, pos: n.pos, mar: n.mar, lines: t.lines, ts: { ...tts, align: flex && n.fd === "row" && n.jc === "center" ? "center" : flex && n.fd === "row" && /end$/.test(n.jc ?? "") ? "right" : (n.ts?.align ?? tts.align), ell: n.ts?.ell || tts.ell } };
  }
  return n;
}

/** A spec tree without the `_` notes (what create_nodes takes). */
export function stripNotes(s: Spec): Spec {
  const { _: _notes, children, ...rest } = s;
  return { ...rest, ...(children ? { children: children.map(stripNotes) } : {}) } as Spec;
}

/** Layers in a spec tree. */
export const countSpecs = (s: Spec): number => 1 + (s.children ?? []).reduce((a, c) => a + countSpecs(c), 0);
