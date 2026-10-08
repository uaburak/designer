/**
 * fieldmeta: engine-only metadata about schema fields (docs/engine.md §2.3) — the one place that maps a schema field
 * name to where the engine keeps it. Read by schemagen, which generates from it:
 *
 *   <build>/generated/schema/facet_readers.h      typed C++ readers: one flat f64 record per facet and node
 *   src/renderer/src/engine/facets.generated.ts   their TS twins: slot layout, decoders into NodeChange's shapes
 *
 * These are Figma's generated per-facet bindings (NodeTsApi / *FacetTsApiGenerated, research R1 §c) in our flat-ABI
 * form: `engine_read_facets(h, ids, count, facetMask)` writes, per node, a presence slot then each requested facet's
 * slots as f64 (no JSON); the TS decoder turns them into the same field shapes `engine_read_nodes` gives the panels
 * (enum names, {x, y}, {m00 … m12}, {value, units}), so a panel's cached node can be patched in place.
 *
 * Kinds: f64, bool, enum (the schema enum's numeric value; the engine's enums are numbered as the schema's — a test
 * checks), opt (std::optional<double>: NaN when absent → the field left out), vector (2 slots), limit (an
 * OptionalVector {value: {x, y}}: 2), matrix (6), number (Number {value, units}: 2), arc (ArcData: 3). `cpp` is an
 * expression over `const NodeProps& p`.
 */

export type FieldKind = "f64" | "bool" | "enum" | "opt" | "vector" | "limit" | "matrix" | "number" | "arc";

export interface FacetField {
  /** The schema NodeChange field name (what the panels read) */
  key: string;
  kind: FieldKind;
  /** For enums: the schema enum's name */
  enumType?: string;
  /** The C++ expression reading it from `const NodeProps& p` */
  cpp: string;
}

export interface FacetReader {
  /** The facet's name in TS (`engine.readFacets(refs, ["geometry"])`) */
  name: string;
  /** Its bit in engine_read_facets' facet mask (1 << id) */
  id: number;
  doc: string;
  fields: FacetField[];
}

const f64 = (key: string, cpp: string): FacetField => ({ key, kind: "f64", cpp });
const bool = (key: string, cpp: string): FacetField => ({ key, kind: "bool", cpp });
const en = (key: string, enumType: string, cpp: string): FacetField => ({ key, kind: "enum", enumType, cpp });

/**
 * What a gesture's frames change (NODES_CHANGED's GEOMETRY group) and what the Design panel shows for it: the
 * node's place and size, its kind, its corners, its constraints and its place in auto layout. Core fields: no facet
 * allocation behind them.
 */
const GEOMETRY: FacetReader = {
  name: "geometry",
  id: 0,
  doc: "Place, size, kind, corners, constraints, auto-layout child (core fields)",
  fields: [
    en("type", "NodeType", "p.type"),
    bool("visible", "p.visible"),
    bool("locked", "p.locked"),
    f64("opacity", "p.opacity"),
    { key: "transform", kind: "matrix", cpp: "p.transform" },
    { key: "size", kind: "vector", cpp: "p.size" },
    f64("cornerRadius", "p.cornerRadii[0]"),
    bool("rectangleCornerRadiiIndependent",
      "!(p.cornerRadii[0] == p.cornerRadii[1] && p.cornerRadii[1] == p.cornerRadii[2] && p.cornerRadii[2] == p.cornerRadii[3])"),
    f64("rectangleTopLeftCornerRadius", "p.cornerRadii[0]"),
    f64("rectangleTopRightCornerRadius", "p.cornerRadii[1]"),
    f64("rectangleBottomRightCornerRadius", "p.cornerRadii[2]"),
    f64("rectangleBottomLeftCornerRadius", "p.cornerRadii[3]"),
    en("horizontalConstraint", "ConstraintType", "p.horizontalConstraint"),
    en("verticalConstraint", "ConstraintType", "p.verticalConstraint"),
    bool("proportionsConstrained", "p.proportionsConstrained"),
    f64("stackChildPrimaryGrow", "p.stackChildPrimaryGrow"),
    en("stackChildAlignSelf", "StackCounterAlign", "p.stackChildAlignSelf"),
    en("stackPositioning", "StackPositioning", "p.stackPositioning"),
  ],
};

/** Shapes' own geometry (the ellipse's arc, a polygon's or star's points). */
const SHAPE: FacetReader = {
  name: "shape",
  id: 1,
  doc: "Arc, point count, star ratio (ShapeFacet)",
  fields: [
    { key: "arcData", kind: "arc", cpp: "p.shape().arcData" },
    f64("count", "p.shape().count"),
    f64("starInnerScale", "p.shape().starInnerScale"),
  ],
};

/** Auto layout, as a container (StackFacet), and the size limits. */
const STACK: FacetReader = {
  name: "stack",
  id: 2,
  doc: "Auto layout container fields and min / max sizes (StackFacet, RareFacet)",
  fields: [
    en("stackMode", "StackMode", "p.stack().stackMode"),
    f64("stackSpacing", "p.stack().stackSpacing"),
    { key: "stackCounterSpacing", kind: "opt", cpp: "p.stack().stackCounterSpacing" },
    f64("stackHorizontalPadding", "p.stack().stackPaddingLeft"),
    f64("stackVerticalPadding", "p.stack().stackPaddingTop"),
    f64("stackPaddingRight", "p.stack().stackPaddingRight"),
    f64("stackPaddingBottom", "p.stack().stackPaddingBottom"),
    en("stackPrimarySizing", "StackSize", "p.stack().stackPrimarySizing"),
    en("stackCounterSizing", "StackSize", "p.stack().stackCounterSizing"),
    en("stackPrimaryAlignItems", "StackJustify", "p.stack().stackPrimaryAlignItems"),
    en("stackCounterAlignItems", "StackAlign", "p.stack().stackCounterAlignItems"),
    en("stackCounterAlignContent", "StackCounterAlignContent", "p.stack().stackCounterAlignContent"),
    en("stackWrap", "StackWrap", "p.stack().stackWrap"),
    bool("stackReverseZIndex", "p.stack().stackReverseZIndex"),
    bool("bordersTakeSpace", "p.stack().bordersTakeSpace"),
    { key: "minSize", kind: "limit", cpp: "p.rare().minSize" },
    { key: "maxSize", kind: "limit", cpp: "p.rare().maxSize" },
  ],
};

/** Strokes: the common ones (core) and the per-side weights (StrokeFacet). */
const STROKE: FacetReader = {
  name: "stroke",
  id: 3,
  doc: "Stroke weight, align, caps, joins, per-side weights, corner smoothing",
  fields: [
    f64("strokeWeight", "p.strokeWeight"),
    en("strokeAlign", "StrokeAlign", "p.strokeAlign"),
    en("strokeCap", "StrokeCap", "p.strokeCap"),
    en("strokeJoin", "StrokeJoin", "p.strokeJoin"),
    f64("miterLimit", "p.miterLimit"),
    f64("borderTopWeight", "p.stroke().borderWeights[0]"),
    f64("borderRightWeight", "p.stroke().borderWeights[1]"),
    f64("borderBottomWeight", "p.stroke().borderWeights[2]"),
    f64("borderLeftWeight", "p.stroke().borderWeights[3]"),
    bool("borderStrokeWeightsIndependent", "p.stroke().borderStrokeWeightsIndependent"),
    f64("cornerSmoothing", "p.stroke().cornerSmoothing"),
    en("blendMode", "BlendMode", "p.blendMode"),
    bool("mask", "p.mask"),
    bool("frameMaskDisabled", "p.frameMaskDisabled"),
  ],
};

/** Text's scalar fields (TextFacet; the characters, runs and font name stay with engine_read_nodes). */
const TEXT: FacetReader = {
  name: "text",
  id: 4,
  doc: "Text's scalar fields (TextFacet)",
  fields: [
    f64("fontSize", "p.text().fontSize"),
    { key: "lineHeight", kind: "number", cpp: "p.text().lineHeight" },
    { key: "letterSpacing", kind: "number", cpp: "p.text().letterSpacing" },
    f64("paragraphSpacing", "p.text().paragraphSpacing"),
    f64("paragraphIndent", "p.text().paragraphIndent"),
    en("textAlignHorizontal", "TextAlignHorizontal", "p.text().textAlignHorizontal"),
    en("textAlignVertical", "TextAlignVertical", "p.text().textAlignVertical"),
    en("textAutoResize", "TextAutoResize", "p.text().textAutoResize"),
    en("textTruncation", "TextTruncation", "p.text().textTruncation"),
    f64("maxLines", "p.text().maxLines"),
    en("textCase", "TextCase", "p.text().textCase"),
    en("textDecoration", "TextDecoration", "p.text().textDecoration"),
    bool("autoRename", "p.text().autoRename"),
  ],
};

export const FACET_READERS: readonly FacetReader[] = [GEOMETRY, SHAPE, STACK, STROKE, TEXT];

export const SLOTS: Record<FieldKind, number> = { f64: 1, bool: 1, enum: 1, opt: 1, vector: 2, limit: 2, matrix: 6, number: 2, arc: 3 };

/** The number of f64 slots a facet's record takes. */
export function slotCount(f: FacetReader): number {
  return f.fields.reduce((n, x) => n + SLOTS[x.kind], 0);
}
