import { REACH_LIMITS } from "../../../shared/agents/reach";
import { countSpecs, foldText, prep, stripNotes, toSpec, type Spec, type WNode } from "../../../shared/agents/web/convert";

/**
 * A captured page (walker.js's tree) as one create_nodes spec (docs/agents-reach.md §5.3): the shared converter, the
 * page's fonts (generic families → Inter), and pictures — images, SVGs, canvases, CSS background images — cut from the
 * page's own screenshot by `crop`. Electron-free; web.ts gives the tree and the crop.
 */

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|-apple-system|blinkmacsystemfont|emoji|math|fangsong|inherit|initial)$/i;

/** The first named family of a CSS font-family list; generic ones (and none) are Inter. */
export function fontOf(css: string | undefined): string {
  for (const part of String(css ?? "").split(",")) {
    const name = part.trim().replace(/^["']|["']$/g, "").trim();
    if (!name || GENERIC.test(name)) continue;
    if (/^(segoe ui|helvetica neue|helvetica|arial)$/i.test(name)) return name.replace(/\b\w/g, (c) => c.toUpperCase()).replace("Ui", "UI");
    return name.slice(0, 80);
  }
  return "Inter";
}

export interface DesignResult {
  spec: Spec;
  layers: number;
  pictures: number;
  /** Pictures over the limit, left as plain rectangles */
  skipped: number;
  fonts: string[];
}

const hasText = (n: WNode): boolean => n.kind === "text" || n.children.some(hasText);

/**
 * The tree's spec. `crop` returns a picture's PNG (base64) for a box in the screenshot's coordinates, or null; without
 * it (or `images: false`) pictures stay plain rectangles named after what they were.
 */
export function designFromCapture(tree: WNode, o: { name: string; crop?: (box: { x: number; y: number; w: number; h: number }) => string | null; images?: boolean }): DesignResult {
  const root = foldText(prep(tree));
  const fonts = new Set<string>();
  const spec = toSpec(root, { parentAL: "NONE", px: root.x, py: root.y, depth: 0 }, { font: (f) => {
    const name = fontOf(f);
    fonts.add(name);
    return name;
  } });
  if (!spec) throw new Error("Nothing visible to capture there.");
  let pictures = 0;
  let skipped = 0;
  const visit = (s: Spec) => {
    const src = s._?.src;
    const picture = src && (src.kind === "img" || src.kind === "svg" || src.kind === "raster" || src.kind === "icon" || (src.kind === "box" && /url\(/.test(src.bgi ?? "") && !hasText(src)));
    if (picture && src.w >= 1 && src.h >= 1) {
      if (o.images !== false && o.crop && pictures < REACH_LIMITS.web.pictures) {
        const data = o.crop({ x: src.x, y: src.y, w: src.w, h: src.h });
        if (data) {
          s.image = { data, scaleMode: "FILL" };
          pictures++;
        }
      } else skipped++;
    }
    for (const c of s.children ?? []) visit(c);
  };
  visit(spec);
  const clean = stripNotes(spec);
  delete clean.x;
  delete clean.y;
  clean.name = o.name.slice(0, 120) || "Web page";
  return { spec: clean, layers: countSpecs(clean), pictures, skipped, fonts: [...fonts] };
}

/** The spec without pictures' bytes (what the agent reads when it creates the layers itself). */
export function withoutImages(s: Spec): Spec {
  const { image: _image, children, ...rest } = s;
  return { ...rest, ...(children ? { children: children.map(withoutImages) } : {}) } as Spec;
}
