/**
 * Dev Mode's UIKit and Android XML code for one layer — the two languages Figma still generates in C++
 * (`generateIOSSwiftCodeForNode`, `generateAndroidCodeForNode`; docs/research/atlas/14-dev-mode.md §7, §9). Both start
 * with the line "Auto layout, grids, variables, and unit scale are not yet supported" as a comment and lay the layer
 * out absolutely in its parent.
 *
 * Only the building blocks are known from the wasm's format strings; the order of the statements here follows them
 * (the view, its frame, its layers, its text, then the constraints in the parent — XML: the view's attributes, then a
 * text style) and is to be checked against a live Figma (§18 question 4).
 */
import type { Color, Paint } from "@/engine/codec";
import { COLLAPSE_AFTER, type CodeLine, type CodeSection } from "./code";
import { cornersOf, isTextLike, round, rotationOf, typographyOf, visibleEffects, visiblePaints, words, type InspectInput } from "./model";

/** The first line both write (a literal, not translated). */
export const NOT_SUPPORTED = "Auto layout, grids, variables, and unit scale are not yet supported";

const n = (v: number) => round(v, 2);
const L = (code: string, indent = 0): CodeLine => ({ code, indent });

const uiColor = (c: Color, opacity = 1) => `UIColor(red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, alpha: ${n((c.a ?? 1) * opacity)})`;
const firstSolid = (paints: readonly Paint[] | undefined) => visiblePaints(paints).find((p) => p.type === "SOLID" && p.color);
const swiftString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** UIKit: a UIView (UILabel for text), its frame, its layers (fills, shadows, corners, border), then its constraints. */
export function uikitSections(input: InspectInput): CodeSection[] {
  const node = input.node;
  const size = node.size ?? { x: 0, y: 0 };
  const text = isTextLike(node);
  const lines: CodeLine[] = [L(`// ${NOT_SUPPORTED}`), L(`var view = ${text ? "UILabel" : "UIView"}()`), L(`view.frame = CGRect(x: 0, y: 0, width: ${n(size.x)}, height: ${n(size.y)})`)];
  let layer = 0;
  if (!text) {
    for (const e of visibleEffects(node.effects).filter((x) => x.type === "DROP_SHADOW")) {
      const name = `layer${layer++}`;
      const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
      const corners = cornersOf(node);
      lines.push(
        L(""),
        L(`let ${name} = CALayer()`),
        L(`${name}.shadowPath = UIBezierPath(roundedRect: view.bounds, cornerRadius: ${n(corners?.tl ?? 0)}).cgPath`),
        L(`${name}.shadowColor = ${uiColor({ ...c, a: 1 })}.cgColor`),
        L(`${name}.shadowOpacity = ${n(c.a ?? 1)}`),
        L(`${name}.shadowRadius = ${n((e.radius ?? 0) / 2)}`),
        L(`${name}.shadowOffset = CGSize(width: ${n(e.offset?.x ?? 0)}, height: ${n(e.offset?.y ?? 0)})`),
        L(`${name}.bounds = view.bounds`),
        L(`${name}.position = view.center`),
        L(`view.layer.addSublayer(${name})`),
      );
    }
    for (const p of visiblePaints(node.fillPaints)) {
      const name = `layer${layer++}`;
      if (p.type === "SOLID" && p.color) lines.push(L(""), L(`let ${name} = CALayer()`), L(`${name}.backgroundColor = ${uiColor(p.color, p.opacity ?? 1)}.cgColor`));
      else if (p.type?.startsWith("GRADIENT_")) {
        lines.push(
          L(""),
          L(`let ${name} = CAGradientLayer()`),
          L(`${name}.colors = [`),
          ...(p.stops ?? []).map((s) => L(`${uiColor(s.color, p.opacity ?? 1)}.cgColor,`, 1)),
          L("]"),
          L(`${name}.locations = [${(p.stops ?? []).map((s) => n(s.position)).join(", ")}]`),
          L(`${name}.startPoint = CGPoint(x: 0.25, y: 0.5)`),
          L(`${name}.endPoint = CGPoint(x: 0.75, y: 0.5)`),
        );
      } else if (p.type === "IMAGE") lines.push(L(""), L(`let ${name} = CALayer()`), L(`${name}.contents = UIImage(named: ${swiftString(node.name ?? "image")})?.cgImage`));
      else continue;
      lines.push(L(`${name}.bounds = view.bounds`), L(`${name}.position = view.center`), L(`view.layer.addSublayer(${name})`));
    }
    const corners = cornersOf(node);
    if (corners) lines.push(L(""), L(`view.layer.cornerRadius = ${n(corners.tl)}`));
    const stroke = firstSolid(node.strokePaints);
    if (stroke?.color) lines.push(L(`view.layer.borderWidth = ${n(node.strokeWeight ?? 1)}`), L(`view.layer.borderColor = ${uiColor(stroke.color, stroke.opacity ?? 1)}.cgColor`));
  } else {
    const t = typographyOf(node);
    const fill = firstSolid(node.fillPaints);
    lines.push(L(`view.textColor = ${fill?.color ? uiColor(fill.color, fill.opacity ?? 1) : uiColor({ r: 0, g: 0, b: 0, a: 1 })}`), L(`view.font = UIFont(name: ${swiftString(`${t.family.replace(/\s+/g, "")}-${t.style.replace(/\s+/g, "")}`)}, size: ${n(t.size)})`));
    const attributes = [
      ...(t.letterSpacingPx ? [`NSAttributedString.Key.kern: ${n(t.letterSpacingPx)}`] : []),
      ...(t.decoration === "UNDERLINE" ? ["NSAttributedString.Key.underlineStyle: NSUnderlineStyle.single.rawValue"] : t.decoration === "STRIKETHROUGH" ? ["NSAttributedString.Key.strikethroughStyle: NSUnderlineStyle.single.rawValue"] : []),
    ];
    if (t.lineHeightPx !== null) {
      lines.push(L("var paragraphStyle = NSMutableParagraphStyle()"), L(`paragraphStyle.lineHeightMultiple = ${n(t.lineHeightPx / (t.size * 1.21))}`));
      attributes.push("NSAttributedString.Key.paragraphStyle: paragraphStyle");
    }
    lines.push(L(`view.attributedText = NSMutableAttributedString(string: ${swiftString(node.textData?.characters ?? "")}, attributes: [${attributes.join(", ")}])`));
    if (t.align !== "LEFT") lines.push(L(`view.textAlignment = .${t.align === "CENTER" ? "center" : t.align === "RIGHT" ? "right" : "justified"}`));
  }
  if (node.opacity !== undefined && node.opacity !== 1) lines.push(L(`view.alpha = ${round(node.opacity, 4)}`));
  const rot = rotationOf(node);
  if (rot) lines.push(L(`view.transform = CGAffineTransform(rotationAngle: ${round((-rot * Math.PI) / 180, 4)})`));
  const x = node.transform?.m02 ?? 0;
  const y = node.transform?.m12 ?? 0;
  lines.push(
    L(""),
    L("var parent = self.view!"),
    L("parent.addSubview(view)"),
    L("view.translatesAutoresizingMaskIntoConstraints = false"),
    L(`view.widthAnchor.constraint(equalToConstant: ${n(size.x)}).isActive = true`),
    L(`view.heightAnchor.constraint(equalToConstant: ${n(size.y)}).isActive = true`),
    L(`view.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: ${n(x)}).isActive = true`),
    L(`view.topAnchor.constraint(equalTo: parent.topAnchor, constant: ${n(y)}).isActive = true`),
  );
  return [{ name: text ? "UILabel" : "UIView", language: "swift", lines, collapseAfterIndex: COLLAPSE_AFTER }];
}

/** An Android resource name: the layer's words, lower snake case ("Card / Title" → card_title). */
const resourceName = (name: string) => words(name).map((w) => w.toLowerCase()).join("_") || "view";

/** `#AARRGGBB`, as Android colours are written. */
const androidColor = (c: Color, opacity = 1) =>
  `#${[(c.a ?? 1) * opacity, c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase(),
    )
    .join("")}`;

/** The panel's XML indent: a tag line (starts with `<`, or ends with `>` but not `->`) at 0, the rest at 1. */
const xmlLine = (code: string): CodeLine => L(code, code.startsWith("<") || (code.endsWith(">") && !code.endsWith("->")) ? 0 : 1);

/**
 * Android XML: the view in a RelativeLayout (`<TextView` for text, `<View` otherwise) placed by its margins from the
 * parent's top left, then a text's `<style>`. The panel indents a line that starts with `<` or ends with `>` (not
 * `->`) at level 0 and every other line at level 1 (§9).
 */
export function androidXmlSections(input: InspectInput): CodeSection[] {
  const node = input.node;
  const size = node.size ?? { x: 0, y: 0 };
  const text = isTextLike(node);
  const id = resourceName(node.name ?? "");
  const attrs = [
    `android:id="@+id/${id}"`,
    `android:layout_width="${n(size.x)}dp"`,
    `android:layout_height="${n(size.y)}dp"`,
    'android:layout_alignParentLeft="true"',
    `android:layout_marginLeft="${n(node.transform?.m02 ?? 0)}dp"`,
    'android:layout_alignParentTop="true"',
    `android:layout_marginTop="${n(node.transform?.m12 ?? 0)}dp"`,
  ];
  const shadow = visibleEffects(node.effects).find((e) => e.type === "DROP_SHADOW");
  if (shadow) attrs.push(`android:elevation="${n(shadow.radius ?? 0)}dp"`);
  const rot = rotationOf(node);
  if (rot) attrs.push(`android:rotation="${n(-rot)}"`);
  if (node.opacity !== undefined && node.opacity !== 1) attrs.push(`android:alpha="${round(node.opacity, 4)}"`);
  const style: CodeLine[] = [];
  if (text) {
    const t = typographyOf(node);
    attrs.push(`android:text="@string/${id}"`, `android:textAppearance="@style/${id}"`);
    if (t.lineHeightPx !== null) attrs.push(`android:lineSpacingExtra="${n(t.lineHeightPx - t.size)}sp"`);
    if (t.align !== "LEFT") attrs.push(`android:gravity="${t.align === "CENTER" ? "center_horizontal" : t.align === "RIGHT" ? "right" : "left"}|top"`);
    const fill = firstSolid(node.fillPaints);
    const items = [
      ["textSize", `${n(t.size)}sp`],
      ["fontFamily", `@font/${resourceName(t.family)}`],
      ...(fill?.color ? [["textColor", androidColor(fill.color, fill.opacity ?? 1)]] : []),
      ...(t.letterSpacingPx ? [["letterSpacing", n(t.letterSpacingPx / t.size)]] : []),
      ...(t.weight >= 600 ? [["textStyle", t.italic ? "bold|italic" : "bold"]] : t.italic ? [["textStyle", "italic"]] : []),
    ];
    style.push(...[`<style name="${id}">`, ...items.map(([k, v]) => `<item name="android:${k}">${v}</item>`), "</style>"].map(xmlLine));
  } else if (visiblePaints(node.fillPaints).length || visiblePaints(node.strokePaints).length) attrs.push(`android:background="@drawable/${id}"`);
  const lines = [`<!-- ${NOT_SUPPORTED} -->`, text ? "<TextView" : "<View", ...attrs.map((a, i) => (i === attrs.length - 1 ? `${a} />` : a))].map(xmlLine);
  const sections: CodeSection[] = [{ name: text ? "TextView" : "View", language: "xml", lines, collapseAfterIndex: COLLAPSE_AFTER }];
  if (style.length) sections.push({ name: "Style", language: "xml", lines: style, collapseAfterIndex: COLLAPSE_AFTER });
  return sections;
}
