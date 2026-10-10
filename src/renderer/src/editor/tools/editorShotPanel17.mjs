// editor-shot's round 17 panel section (EDITOR_ONLY=panel17): the Design panel's Auto layout section as the owner's
// live Figma 74–77.png (docs/research/panel17), at 2x like those screens, the default UI state (no labels forced):
//
// 1. No per-row labels (Flow, Resizing / Dimensions, Alignment, Gap, Padding) — only "Auto layout"; rows 32 apart.
// 2. W Fixed: its number, the 5 × 3 chevron centred 75 in from the field's left (74.png), hovered or not.
// 3. H Hug: the number grey (text-secondary), "Hug" ending 9 short of the field's right edge, no chevron — hovered too.
// 4. A layer filling both ways: "Fill" in both fields (76.png); W hovered keeps "Fill" (77.png's H).
// 5. Tab from W goes to H, then the gap (no chevron, no Apply variable, no toggle on the way); ⌥↓ in W opens its list.
/* global window, document, getComputedStyle */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const grey = fill(0.85, 0.85, 0.85);
// 74.png: a vertical frame 179 wide (Fixed), hugging its height, gap 12, padding 12 / 12; 76.png: a child filling a
// fixed frame both ways (155 × 155).
function nodes() {
  return [
    {
      guid: "17:1", phase: "CREATED", type: "FRAME", name: "Auto", parentIndex: { guid: "0:1", position: "!" }, size: { x: 179, y: 179 }, transform: at(0, 0),
      fillPaints: fill(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12, stackHorizontalPadding: 12,
      stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED",
    },
    { guid: "17:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "A", parentIndex: { guid: "17:1", position: "!" }, size: { x: 100, y: 71 }, transform: at(12, 12), fillPaints: grey },
    { guid: "17:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "B", parentIndex: { guid: "17:1", position: '"' }, size: { x: 100, y: 72 }, transform: at(12, 95), fillPaints: grey },
    {
      guid: "17:4", phase: "CREATED", type: "FRAME", name: "Fixed", parentIndex: { guid: "0:1", position: '"' }, size: { x: 179, y: 179 }, transform: at(240, 0),
      fillPaints: fill(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12, stackHorizontalPadding: 12,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    { guid: "17:5", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Fill", parentIndex: { guid: "17:4", position: "!" }, size: { x: 155, y: 155 }, transform: at(252, 12), fillPaints: grey, stackChildAlignSelf: "STRETCH", stackChildPrimaryGrow: 1 },
  ];
}

export async function panel17Section(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty", { defaultLabels: true });
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 200 + window.__viewLeft(), y: 200, zoom: 1 });
    ed.engine.setSelection(["17:1"]);
  }, nodes());
  await settle(page);
  const P = `Panel17 ${theme}:`;
  const crop = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  /** The geometry of a W / H field (page px) and what it draws. */
  const field = (label) =>
    page.evaluate((label) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      if (!input) return null;
      const box = input.closest('[data-ds="NumericInput"]');
      const r = box.getBoundingClientRect();
      const menu = box.querySelector("[data-field-menu]");
      const svg = menu?.querySelector("svg path");
      const g = svg?.getBoundingClientRect();
      const range = document.createRange();
      if (menu && !svg) range.selectNodeContents(menu);
      const word = menu && !svg ? range.getBoundingClientRect() : null;
      return {
        left: r.left, top: r.top, width: r.width, right: r.right, height: r.height,
        chevron: g ? { cx: g.left + g.width / 2 - r.left, cy: g.top + g.height / 2 - r.top, w: g.width, h: g.height, opacity: getComputedStyle(menu).opacity, visibility: getComputedStyle(menu).visibility } : null,
        word: word ? { text: menu.textContent, right: r.right - word.right, color: getComputedStyle(menu).color } : null,
        number: { color: getComputedStyle(input).color, left: input.getBoundingClientRect().left - r.left },
        tabIndex: menu?.tabIndex ?? null,
      };
    }, label);
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    document.body.append(probe);
    const color = (v) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
    const out = { text: color("--figma-color-text"), secondary: color("--figma-color-text-secondary") };
    probe.remove();
    void s;
    return out;
  });
  const section = async (name = "Auto layout") =>
    page.evaluate((name) => {
      const title = [...document.querySelectorAll('[data-panel="right"] *')].find((el) => el.childElementCount === 0 && el.textContent === name);
      const sec = title?.closest('[data-ds="PanelSection"]') ?? title?.parentElement?.parentElement;
      const r = sec?.getBoundingClientRect();
      const rows = [...(sec?.querySelectorAll('[data-ds="PropertyRow"]') ?? [])].map((el) => Math.round(el.getBoundingClientRect().top));
      const texts = [...(sec?.querySelectorAll("span, div") ?? [])].filter((el) => el.childElementCount === 0).map((el) => el.textContent.trim()).filter(Boolean);
      return { clip: r ? { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) } : null, rows, texts };
    }, name);

  // ---- 1. No row labels by default. ---------------------------------------------------------------------------------
  const s = await section();
  const labels = ["Flow", "Resizing", "Dimensions", "Alignment", "Gap", "Padding"].filter((l) => s.texts.includes(l));
  check(`${P} the Auto layout section shows no row labels by default (74.png)`, !!s.clip && labels.length === 0, labels.join(", ") || "none");
  const pitch = s.rows.slice(1, 3).map((y, i) => y - s.rows[i]);
  check(`${P} …its rows 32 apart (Flow → W / H → Alignment / gap)`, pitch[0] === 32 && pitch[1] === 32, JSON.stringify(s.rows));
  if (s.clip) await crop("panel17-autolayout", s.clip);

  // ---- 2. W Fixed: the chevron. ------------------------------------------------------------------------------------
  const w = await field("Horizontal resizing");
  const chevronOk = (f) => !!f?.chevron && Math.abs(f.chevron.cx - 75) <= 1 && Math.abs(f.chevron.cy - 12) <= 1 && Math.abs(f.chevron.w - 5) <= 0.6 && f.chevron.opacity === "1" && f.chevron.visibility === "visible" && !f.word;
  check(`${P} W Fixed: a 5 × 3 chevron centred 75 in (74.png 2x: 182–191 in 36–212), no word`, chevronOk(w), JSON.stringify(w?.chevron));
  check(`${P} W Fixed: its number at 24 in the text colour`, w?.number.color === tokens.text && Math.abs(w.number.left - 23) <= 1.5, JSON.stringify(w?.number));
  await page.mouse.move(w.left + 50, w.top + 12);
  const wHover = await field("Horizontal resizing");
  check(`${P} W Fixed hovered: the chevron stays where it was`, chevronOk(wHover), JSON.stringify(wHover?.chevron));
  await crop("panel17-w-fixed-hover", { x: Math.floor(w.left - 16), y: Math.floor(w.top - 8), width: 240, height: 40 });

  // ---- 3. H Hug: the word. ------------------------------------------------------------------------------------------
  const h = await field("Vertical resizing");
  const hugOk = (f, word) => !!f?.word && f.word.text === word && !f.chevron && Math.abs(f.word.right - 9) <= 1 && f.word.color === tokens.text && f.number.color === tokens.secondary;
  check(`${P} H Hug: the number grey, "Hug" ending 9 short of the right edge, no chevron (75.png)`, hugOk(h, "Hug"), JSON.stringify(h));
  await page.mouse.move(h.left + 50, h.top + 12);
  const hHover = await field("Vertical resizing");
  check(`${P} H Hug hovered: "Hug" stays, no chevron comes`, hugOk(hHover, "Hug"), JSON.stringify(hHover?.word));
  await crop("panel17-h-hug-hover", { x: Math.floor(w.left - 16), y: Math.floor(w.top - 8), width: 240, height: 40 });
  await page.mouse.move(10, 880);

  // ---- 5. Tab field to field, ⌥↓. -----------------------------------------------------------------------------------
  check(`${P} the W / H menus are no tab stops`, w.tabIndex === -1 && h.tabIndex === -1, `${w.tabIndex} ${h.tabIndex}`);
  await page.click('input[aria-label="Horizontal resizing"]');
  await settle(page);
  await crop("panel17-w-focused", { x: Math.floor(w.left - 16), y: Math.floor(w.top - 8), width: 240, height: 40 });
  const seq = [];
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Tab");
    seq.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")));
  }
  check(`${P} Tab from W: H, then the gap`, seq[0] === "Vertical resizing" && seq[1] === "Vertical gap between objects", seq.join(" → "));
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  check(`${P} ⇧Tab twice: back on W`, back === "Horizontal resizing", String(back));
  await page.keyboard.press("Alt+ArrowDown");
  await settle(page);
  const menu = await page.evaluate(() => document.querySelector('[role="menu"]')?.textContent ?? "");
  check(`${P} ⌥↓ in W opens its sizing list`, menu.includes("Fixed width") && menu.includes("Hug contents"), menu.slice(0, 60));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);

  // ---- 4. Fill both ways. -------------------------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["17:5"]));
  await settle(page);
  const fw = await field("Horizontal resizing");
  const fh = await field("Vertical resizing");
  check(`${P} a layer filling both ways: "Fill" in W and H, numbers grey, no chevrons (76.png)`, hugOk(fw, "Fill") && hugOk(fh, "Fill"), JSON.stringify([fw?.word, fh?.word, fw?.chevron]));
  await page.mouse.move(fw.left + 50, fw.top + 12);
  const fwHover = await field("Horizontal resizing");
  check(`${P} …W hovered keeps "Fill" (77.png's H)`, hugOk(fwHover, "Fill"), JSON.stringify(fwHover?.word));
  await crop("panel17-fill-hover", { x: Math.floor(fw.left - 16), y: Math.floor(fw.top - 8), width: 240, height: 40 });
  await page.mouse.move(10, 880);
  const fs = await section("Layout");
  if (fs.clip) await crop("panel17-layout-fill", fs.clip);
}
