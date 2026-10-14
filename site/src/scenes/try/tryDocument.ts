// The "Try it" tile's file: a product page and its phone version, built from frames, auto layout, text and shapes — what the
// visitor selects, moves, resizes and draws over in the real engine.
import { autoLayout, DocBuilder, radius, solid, textFields } from "../engine/doc";

const INK = 0x1e1e1e;
const GREY = 0x6b6b6b;

export function tryDocument() {
  const d = new DocBuilder("Launch");
  const page = "0:1";

  // ── Desktop ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const home = d.add(page, "FRAME", "Home", 0, 0, 880, 560, { fillPaints: solid(0xffffff) });

  const nav = d.add(home, "FRAME", "Nav", 40, 28, 800, 28, autoLayout("HORIZONTAL", 24, [0, 0], { stackPrimarySizing: "FIXED", stackPrimaryAlignItems: "SPACE_BETWEEN", stackCounterAlignItems: "CENTER" }));
  const logo = d.add(nav, "FRAME", "Logo", 0, 0, 92, 24, autoLayout("HORIZONTAL", 8, [0, 0], { stackCounterAlignItems: "CENTER" }));
  d.add(logo, "ELLIPSE", "Mark", 0, 0, 22, 22, { fillPaints: solid(0xffa629) });
  d.add(logo, "TEXT", "Lumen", 30, 2, 52, 20, textFields("Lumen", 16, "Semi Bold", INK));
  const links = d.add(nav, "FRAME", "Links", 560, 4, 240, 20, autoLayout("HORIZONTAL", 28, [0, 0], { stackCounterAlignItems: "CENTER" }));
  for (const [i, label] of ["Product", "Stories", "Pricing"].entries()) d.add(links, "TEXT", label, i * 80, 0, 56, 20, textFields(label, 14, "Medium", GREY));

  const headline = d.add(home, "TEXT", "Headline", 40, 116, 430, 120, textFields("Light that\nfollows your day.", 52, "Bold", INK));
  d.add(home, "TEXT", "Body", 40, 254, 380, 48, textFields("A desk lamp that warms in the evening and wakes you up bright. Made to last, built to repair.", 15, "Regular", GREY, { textAutoResize: "HEIGHT" }));

  const buttons = d.add(home, "FRAME", "Buttons", 40, 330, 260, 44, autoLayout("HORIZONTAL", 12, [0, 0]));
  const primary = d.add(buttons, "FRAME", "Pre-order", 0, 0, 120, 44, { ...autoLayout("HORIZONTAL", 8, [12, 20], { stackCounterAlignItems: "CENTER" }), ...radius(10), fillPaints: solid(INK) });
  d.add(primary, "TEXT", "Label", 20, 12, 80, 20, textFields("Pre-order", 14, "Semi Bold", 0xffffff));
  const secondary = d.add(buttons, "FRAME", "Learn more", 132, 0, 120, 44, { ...autoLayout("HORIZONTAL", 8, [12, 20], { stackCounterAlignItems: "CENTER" }), ...radius(10), fillPaints: solid(0xf1f1f1) });
  d.add(secondary, "TEXT", "Label", 20, 12, 80, 20, textFields("Learn more", 14, "Semi Bold", INK));

  const art = d.add(home, "FRAME", "Hero image", 500, 96, 340, 300, { ...radius(20), fillPaints: solid(0xffe7c2) });
  d.add(art, "ELLIPSE", "Glow", 120, -40, 260, 260, { fillPaints: solid(0xffc977) });
  d.add(art, "ELLIPSE", "Bulb", 196, 104, 64, 64, { fillPaints: solid(0xfff6e0) });
  d.add(art, "ROUNDED_RECTANGLE", "Shade", 168, 72, 120, 54, { ...radius(27), fillPaints: solid(INK) });
  d.add(art, "ROUNDED_RECTANGLE", "Arm", 222, 120, 10, 130, { ...radius(5), fillPaints: solid(0x3a3a3a) });
  d.add(art, "ROUNDED_RECTANGLE", "Base", 172, 244, 110, 14, { ...radius(7), fillPaints: solid(INK) });
  d.add(art, "ROUNDED_RECTANGLE", "Desk", 0, 256, 340, 44, { fillPaints: solid(0xe9c58f) });

  const cards = d.add(home, "FRAME", "Features", 40, 428, 800, 96, autoLayout("HORIZONTAL", 16, [0, 0], { stackPrimarySizing: "FIXED" }));
  const features: [string, string, number][] = [
    ["Warm at night", "From 6500 K at noon to 2700 K after sunset.", 0xffa629],
    ["Bright mornings", "A slow sunrise, ten minutes before your alarm.", 0x0d99ff],
    ["Built to repair", "Every part screws in. Spares for ten years.", 0x14ae5c],
  ];
  for (const [i, [title, body, color]] of features.entries()) {
    const card = d.add(cards, "FRAME", title, i * 272, 0, 256, 96, {
      ...autoLayout("VERTICAL", 6, [16, 16]),
      ...radius(14),
      fillPaints: solid(0xf6f6f6),
      stackChildPrimaryGrow: 1,
    });
    d.add(card, "ELLIPSE", "Dot", 16, 16, 10, 10, { fillPaints: solid(color) });
    d.add(card, "TEXT", "Title", 16, 32, 224, 20, textFields(title, 14, "Semi Bold", INK, { stackChildAlignSelf: "STRETCH", textAutoResize: "HEIGHT" }));
    d.add(card, "TEXT", "Body", 16, 54, 224, 20, textFields(body, 13, "Regular", GREY, { stackChildAlignSelf: "STRETCH", textAutoResize: "HEIGHT" }));
  }

  // ── Phone ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const phone = d.add(page, "FRAME", "Phone", 940, 0, 300, 560, { ...radius(28), fillPaints: solid(INK) });
  const phoneArt = d.add(phone, "FRAME", "Image", 16, 64, 268, 220, { ...radius(18), fillPaints: solid(0x2c2c2c) });
  d.add(phoneArt, "ELLIPSE", "Glow", 70, 20, 180, 180, { fillPaints: solid(0xffa629, 0.9) });
  d.add(phoneArt, "ROUNDED_RECTANGLE", "Shade", 104, 70, 90, 40, { ...radius(20), fillPaints: solid(0xfff6e0) });
  d.add(phone, "TEXT", "Title", 20, 300, 260, 64, textFields("Light that\nfollows your day.", 28, "Bold", 0xffffff));
  d.add(phone, "TEXT", "Body", 20, 384, 256, 40, textFields("Warm at night, bright in the morning.", 14, "Regular", 0xb3b3b3, { textAutoResize: "HEIGHT" }));
  const cta = d.add(phone, "FRAME", "Pre-order", 20, 476, 260, 48, { ...autoLayout("HORIZONTAL", 8, [14, 20], { stackPrimarySizing: "FIXED", stackPrimaryAlignItems: "CENTER", stackCounterAlignItems: "CENTER" }), ...radius(24), fillPaints: solid(0xffa629) });
  d.add(cta, "TEXT", "Label", 90, 14, 80, 20, textFields("Pre-order", 15, "Semi Bold", INK));

  return { message: d.message(), home, phone, art, cards, buttons, primary, headline, nav };
}
