import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appColor,
  canvasChrome,
  CHROME_COLORS,
  chromePalette,
  elevation,
  figmaColor,
  parseColor,
  resolveFigmaColor,
  staticVariables,
  surfaceBackground,
  themeVariables,
  type FigmaColorName,
} from "../tokens";
import { renderBootJs, renderChromeHeader, renderTokensCss } from "../tokensCss";
import { outputs, updateBootJs } from "../../../../../scripts/gen-tokens";

const ds = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../../..", import.meta.url));

describe("Figma's colour tokens", () => {
  const official = readFileSync(join(repo, "docs/research/figma/figma-color-tokens-light.txt"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const at = line.indexOf(" ");
      return [line.slice(0, at).replace("--figma-color-", ""), line.slice(at + 1).trim()] as const;
    });

  it("are exactly the 174 published names", () => {
    expect(official).toHaveLength(174);
    expect(Object.keys(figmaColor).sort()).toEqual(official.map(([n]) => n).sort());
  });

  it("carry the published light values", () => {
    for (const [name, light] of official) expect(figmaColor[name as FigmaColorName][0], name).toBe(light);
  });

  it("move only the bg-selected family away from Figma's dark values (contract §1.2)", () => {
    // Figma's published dark values for the moved tokens, and what the measured screenshots chose.
    expect(figmaColor["bg-selected"][1]).toBe("#394360");
    expect(figmaColor["bg-selected-secondary"][1]).toBe("#32394d");
    expect(figmaColor["bg-selected-hover"][1]).toBe("#4a5878");
    expect(figmaColor["bg-onselected"][1]).toBe("#4a5878");
    // Unmoved, as measured: panel, field, border, brand, active tab glyph
    expect(figmaColor.bg[1]).toBe("#2c2c2c");
    expect(figmaColor["bg-secondary"][1]).toBe("#383838");
    expect(figmaColor.border[1]).toBe("#444444");
    expect(figmaColor["bg-brand"][1]).toBe("#0c8ce9");
    expect(figmaColor["text-brand"][1]).toBe("#7cc4f8");
    expect(figmaColor["text-component"][1]).toBe("#d1a8ff");
  });

  it("all parse as colours, light and dark", () => {
    for (const [name, pair] of Object.entries(figmaColor)) for (const v of pair) expect(parseColor(v), `${name} ${v}`).not.toBeNull();
    for (const [name, pair] of Object.entries(appColor)) for (const v of pair) expect(parseColor(v), `${name} ${v}`).not.toBeNull();
    for (const [name, pair] of Object.entries(canvasChrome)) for (const v of pair) expect(parseColor(v), `${name} ${v}`).not.toBeNull();
  });

  it("resolve per theme", () => {
    expect(resolveFigmaColor("bg", "light")).toBe("#ffffff");
    expect(resolveFigmaColor("bg", "dark")).toBe("#2c2c2c");
  });
});

describe("themes", () => {
  it("define the same custom properties in light and dark", () => {
    expect(Object.keys(themeVariables("dark")).sort()).toEqual(Object.keys(themeVariables("light")).sort());
    for (const v of Object.values(themeVariables("dark"))) expect(v).toBeTruthy();
  });

  it("give every elevation both values", () => {
    for (const [name, [light, dark]] of Object.entries(elevation)) {
      expect(light, name).toBeTruthy();
      expect(dark, name).toBeTruthy();
    }
  });

  it("never share a name between themed and static properties", () => {
    const themed = new Set(Object.keys(themeVariables("light")));
    for (const k of Object.keys(staticVariables())) expect(themed.has(k), k).toBe(false);
  });

  it("paint each surface before the first paint", () => {
    expect(surfaceBackground("app", "dark")).toBe("#2c2c2c");
    expect(surfaceBackground("tabbar", "dark")).toBe("#3b3b3b");
    expect(surfaceBackground("viewer", "light")).toBe("#f5f5f5");
  });
});

describe("the canvas chrome palette (engine ABI)", () => {
  it("keeps its 42 colours in their frozen order (append only)", () => {
    expect(CHROME_COLORS).toEqual([
      "selection", "handleFill", "handleStroke", "hover", "component", "sizeBadgeFill", "sizeBadgeText", "frameTitleOnLight", "frameTitleOnDark",
      "measure", "measureText", "snapGuide", "spacingGuide", "layoutGapFill", "layoutGapStroke", "marqueeFill", "marqueeStroke", "rulerBg",
      "rulerTick", "rulerText", "rulerSelectionBand", "rulerSelectionText", "textCaret", "textSelection", "prototypeNoodle", "slotFill",
      "slotStroke", "canvasDefault", "pixelGrid",
      // Round 7 (live Figma): titles of selected frames and of components, the corner radius handles.
      "frameTitleSelectedOnLight", "frameTitleSelectedOnDark", "frameTitleComponentOnLight", "frameTitleComponentOnDark", "radiusHandleFill", "radiusHandleStroke",
      // Round 15: the canvas tooltip (the `</>` button's) and a ready design's green.
      "canvasTooltipFill", "canvasTooltipText", "readyForDev",
      // Round 16: a connection that isn't the selection's, the canvas scrollbars.
      "prototypeNoodleQuiet", "canvasScrollbarFill", "canvasScrollbarFillHover", "canvasScrollbarRim", "prototypeLabelText",
      // Round 17: a Change to connection's lavender and its chip's text.
      "prototypeNoodleChangeTo", "prototypeChangeToLabelText",
    ]);
  });

  it("packs as straight-alpha RGBA in 0..1", () => {
    const dark = chromePalette("dark");
    expect(dark).toHaveLength(CHROME_COLORS.length * 4);
    for (const v of dark) expect(v >= 0 && v <= 1).toBe(true);
    const sel = [...chromePalette("light").slice(0, 4)];
    expect(sel[0]).toBeCloseTo(13 / 255);
    expect(sel[1]).toBeCloseTo(153 / 255);
    expect(sel[2]).toBeCloseTo(1);
    expect(sel[3]).toBe(1);
    // layoutGapFill (#ff24bd40): alpha 0x40
    expect(chromePalette("light")[13 * 4 + 3]).toBeCloseTo(0x40 / 255);
  });
});

describe("generated artefacts", () => {
  it("tokens.css, boot.js's generated block and ChromePalette.generated.h are what tokens.ts gives (`npm run tokens`)", () => {
    for (const o of outputs()) expect(o.current, `${o.path} is out of date: run \`npm run tokens\``).toBe(o.next);
  });

  it("boot.js keeps everything outside its generated block", () => {
    const before = "x();\n  // <generated old>\n  var SURFACE_BG = {};\n  // </generated>\ny();\n";
    const after = updateBootJs(before);
    expect(after.startsWith("x();\n  // <generated by scripts/gen-tokens.ts")).toBe(true);
    expect(after.endsWith("  // </generated>\ny();\n")).toBe(true);
    expect(after).toContain('tabbar: ["#e6e6e6", "#3b3b3b"]');
  });

  it("tokens.css themes subtrees: light on :root and [data-theme=light], dark on [data-theme=dark]", () => {
    const css = renderTokensCss();
    expect(css).toContain(':root,\n  [data-theme="light"] {');
    expect(css).toContain('[data-theme="dark"] {');
    expect(css.startsWith("/* GENERATED")).toBe(true);
    expect(css).toContain("@layer reset, tokens, theme, base, ds, components, utilities, app;");
  });

  it("boot.js and the engine header carry the same values", () => {
    const boot = renderBootJs();
    expect(boot).toContain('tabbar: ["#e6e6e6","#3b3b3b"]');
    expect(boot).toContain('localStorage.getItem("designer-theme")');
    const header = renderChromeHeader();
    expect(header).toContain("PrototypeChangeToLabelText = 44, Count");
    expect(header.match(/\/\/ selection/g)).toHaveLength(2);
  });

  it("every var(--…) a DS stylesheet reads exists (or is set inline by its component)", () => {
    const defined = new Set([...Object.keys(staticVariables()), ...Object.keys(themeVariables("light"))]);
    const inline = new Set(["--depth", "--tail-rest", "--tail-hover", "--layer-clip-right", "--layer-tail", "--layer-cut", "--ds-toolbar-offset", "--ds-toolbar-lift", "--ds-tabs-card-bg", "--tone", "--field-ring", "--ds-row-columns", "--menu-inset", "--popover-arrow-x"]);
    const files = (readdirSync(ds, { recursive: true }) as string[]).filter((f) => f.endsWith(".css") && f !== "tokens.css");
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const css = readFileSync(join(ds, f), "utf8");
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) expect(defined.has(m[1]) || inline.has(m[1]), `${f}: ${m[1]}`).toBe(true);
    }
  });
});
