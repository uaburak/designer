/**
 * The usage index (the Gallery's "Usages in the app" and "Not from the design system"): every ds component's JSX in the
 * app, grouped by the combination of visual props it is given, and every hand-made control (<button>, <input>,
 * <select>, <textarea>, role="button", a styled <a>) grouped by its CSS module class — read statically with the
 * TypeScript compiler's parser, nothing run.
 */
import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CustomControl, DsComponentUsage, DsLook, DsVariant, SampleValue, UsageIndex } from "../../src/renderer/src/ds/gallery/usageTypes";

export interface ScanOptions {
  /** The repository's root: locations are relative to it */
  root: string;
  /** The folder scanned (src/renderer/src) */
  src: string;
  /** The design system's folder (src/renderer/src/ds): its imports are the ds components; it is not scanned */
  ds: string;
  /** Path prefixes (relative to `src`, "/"-separated) left out besides ds, tests and dev tools */
  exclude?: string[];
}

/** Props that don't change a component's look (behaviour, text for tooltips, data) */
const SKIP = new Set(["key", "ref", "children", "id", "value", "defaultValue", "name", "options", "items", "entries", "tooltip", "shortcut", "htmlFor", "autoFocus", "tabIndex", "role", "type", "menu", "tooltipPlacement", "tabs", "columns", "cells", "keywords", "labels", "min", "max", "step", "precision", "maxLength", "autoComplete", "spellCheck", "scrubHandle", "form", "accept", "multiple"]);
/** States set at run time: a literal `true` is a variant (always disabled), a computed one is not */
const STATES = new Set(["disabled", "loading", "checked", "selected", "pressed", "mixed", "open", "active", "indeterminate", "readOnly", "invalid", "error", "focused", "hover", "dirty", "busy"]);
/** Props whose literal is text: recorded as given ("✓"), their first literal kept for the sample */
const TEXT = new Set(["label", "placeholder", "description", "hint", "message", "heading", "caption", "subtitle", "detail", "suffix", "prefix", "unit", "title", "body", "code", "valueLabel", "swatchLabel"]);
const isIconProp = (name: string) => /icon/i.test(name);
const skipProp = (name: string) => SKIP.has(name) || /^on[A-Z]/.test(name) || /^(aria|data)-/.test(name) || /^(render|get|format|filter|is|can)[A-Z]/.test(name);

const CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);
const CONTROL_ROLES = new Set(["button", "switch", "checkbox", "tab", "radio"]);

const posix = (p: string) => p.split(sep).join("/");

/** The .tsx files under `dir`, tests, the ds itself and dev tools left out. */
export function sourceFiles(o: ScanOptions): string[] {
  const out: string[] = [];
  const skipDir = (rel: string, name: string) => name === "__tests__" || name === "fixtures" || name === "node_modules" || rel === "devtools" || resolve(o.src, rel) === resolve(o.ds) || (o.exclude ?? []).some((x) => rel === x || rel.startsWith(`${x}/`));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = posix(relative(o.src, full));
      if (statSync(full).isDirectory()) {
        if (!skipDir(rel, name)) walk(full);
      } else if (name.endsWith(".tsx") && !/\.(test|spec|stories)\.tsx$/.test(name) && !(o.exclude ?? []).some((x) => rel === x)) out.push(full);
    }
  };
  walk(o.src);
  return out;
}

// ── Reading values ────────────────────────────────────────────────────────────

type Literal = { kind: "literal"; value: SampleValue } | { kind: "choice"; values: SampleValue[] } | { kind: "dynamic" } | { kind: "function" };

function literalOf(e: ts.Expression): Literal {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { kind: "literal", value: e.text };
  if (ts.isNumericLiteral(e)) return { kind: "literal", value: Number(e.text) };
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return { kind: "literal", value: -Number(e.operand.text) };
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { kind: "function" };
  if (ts.isConditionalExpression(e)) {
    const a = literalOf(e.whenTrue), b = literalOf(e.whenFalse);
    const values = [...(a.kind === "literal" ? [a.value] : a.kind === "choice" ? a.values : []), ...(b.kind === "literal" ? [b.value] : b.kind === "choice" ? b.values : [])];
    if ((a.kind === "literal" || a.kind === "choice") && (b.kind === "literal" || b.kind === "choice")) return { kind: "choice", values: [...new Set(values)] };
  }
  return { kind: "dynamic" };
}

const shown = (l: Literal): string | null => (l.kind === "literal" ? String(l.value) : l.kind === "choice" ? l.values.map(String).join(" | ") : l.kind === "dynamic" ? "dynamic" : null);

/** The text a translated or literal expression carries: "x", t("x"), tr("x", …), `x`. */
function textOf(e: ts.Expression): string | undefined {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /^(t|tr|tp|tx)$/.test(e.expression.text) && e.arguments[0] && ts.isStringLiteral(e.arguments[0])) return e.arguments[0].text;
  return undefined;
}

/** What an element holds: text (and the first literal of it), an <Icon> (and its name). */
function contentOf(children: readonly ts.JsxChild[], iconTags: Set<string>): { hasText: boolean; text?: string; hasIcon: boolean; icon?: string } {
  const r: { hasText: boolean; text?: string; hasIcon: boolean; icon?: string } = { hasText: false, hasIcon: false };
  const visit = (c: ts.JsxChild) => {
    if (ts.isJsxText(c)) {
      const s = c.text.replace(/\s+/g, " ").trim();
      if (s) {
        r.hasText = true;
        r.text ??= s;
      }
    } else if (ts.isJsxExpression(c) && c.expression) {
      const s = textOf(c.expression);
      if (s !== undefined) {
        r.hasText = true;
        r.text ??= s;
      } else if (!ts.isJsxElement(c.expression) && !ts.isJsxSelfClosingElement(c.expression)) r.hasText = true;
    } else if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
      const open = ts.isJsxElement(c) ? c.openingElement : c;
      const tag = open.tagName.getText();
      if (iconTags.has(tag)) {
        r.hasIcon = true;
        const nameAttr = open.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "name");
        const v = nameAttr?.initializer;
        const lit = v && ts.isStringLiteral(v) ? v.text : v && ts.isJsxExpression(v) && v.expression ? literalOf(v.expression) : undefined;
        if (typeof lit === "string") r.icon ??= lit;
        else if (lit && lit.kind === "literal" && typeof lit.value === "string") r.icon ??= lit.value;
      } else if (ts.isJsxElement(c)) c.children.forEach(visit);
    } else if (ts.isJsxFragment(c)) c.children.forEach(visit);
  };
  children.forEach(visit);
  return r;
}

// ── CSS modules ───────────────────────────────────────────────────────────────

interface ClassInfo {
  /** The base rule's declarations (`.cls { … }` exactly) */
  own: Record<string, string>;
  ownRules: number;
  /** Rules that style it only inside another selector */
  contextual: string[];
}

const cssCache = new Map<string, string>();
const readCss = (file: string) => {
  if (!cssCache.has(file)) cssCache.set(file, existsSync(file) ? readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") : "");
  return cssCache.get(file)!;
};

/** What a CSS module says about one of its classes. */
export function classInfo(css: string, cls: string): ClassInfo {
  const info: ClassInfo = { own: {}, ownRules: 0, contextual: [] };
  const token = new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`);
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    for (const raw of m[1].split(",")) {
      const sel = raw.trim();
      if (!token.test(sel)) continue;
      const compounds = sel.split(/\s*[\s>+~]\s*/).filter(Boolean);
      const last = compounds[compounds.length - 1] ?? "";
      if (compounds.length > 1 && token.test(last)) info.contextual.push(sel);
      else if (compounds.length === 1) {
        info.ownRules++;
        if (sel === `.${cls}`) for (const d of body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)) info.own[d[1]] = d[2].trim();
      }
    }
  }
  return info;
}

/** The `--ds-*` tokens with a plain px value (tokens.css). */
export function pxTokens(tokensCss: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tokensCss.matchAll(/(--ds-[\w-]+)\s*:\s*(-?[\d.]+px)\s*;/g)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

const resolvePx = (v: string, tokens: Map<string, string>) => v.replace(/var\((--ds-[\w-]+)\)/g, (all, name: string) => tokens.get(name) ?? all);

const BOX = ["width", "height", "min-width", "min-height", "padding", "border-radius", "background", "border", "font"];

/** The ds component a hand-made control most looks like. */
export function similarTo(c: Pick<CustomControl, "tag" | "type" | "role" | "className" | "hasText" | "hasIcon" | "box" | "text">): { name: string; why: string } | null {
  const cls = (c.className ?? "").toLowerCase();
  const box = c.box ?? {};
  const h = parseFloat(box.height ?? ""), w = parseFloat(box.width ?? "");
  const size = h && w ? `${w}×${h}` : h ? `${h} high` : "";
  if (c.tag === "select") return { name: "Select", why: "a native <select>" };
  if (c.tag === "textarea") return { name: "TextArea", why: "a text area" };
  if (c.tag === "input") {
    const type = c.type ?? "text";
    if (type === "checkbox") return /switch|toggle/.test(cls) ? { name: "Switch", why: "a checkbox styled as a switch" } : { name: "Checkbox", why: "a native checkbox" };
    if (type === "radio") return { name: "RadioGroup", why: "a native radio" };
    if (type === "range") return { name: "Slider", why: "a range input" };
    if (type === "color") return { name: "ColorInput", why: "a colour input" };
    if (type === "file" || type === "hidden") return null;
    if (type === "search" || /search/.test(cls) || /search/i.test(c.text ?? "")) return { name: "SearchField", why: "a search input" };
    if (type === "number" || /num|value|field/.test(cls)) return { name: /num/.test(cls) || type === "number" ? "NumericInput" : "TextInput", why: `a ${type} input${size ? `, ${size}` : ""}` };
    return { name: "TextInput", why: `a ${type} input${size ? `, ${size}` : ""}` };
  }
  if (c.role === "switch" || /switch|toggle/.test(cls) && c.role === "checkbox") return { name: "Switch", why: "role=switch" };
  if (c.role === "checkbox") return { name: "Checkbox", why: "role=checkbox" };
  if (c.role === "tab" || /\btabs?\b|tab[A-Z_]?/.test(c.className ?? "")) return { name: "Tabs", why: "a tab" };
  if (/segment/.test(cls)) return { name: "SegmentedControl", why: "a segment" };
  if (/swatch/.test(cls) && !c.hasText) return { name: "Swatch", why: "a colour chip" };
  if (c.tag === "a" || /link/.test(cls)) return c.tag === "button" ? { name: "Button", why: "a link-styled button (variant=\"link\")" } : null;
  if (c.tag === "button" || c.role === "button") {
    if (/row|item|option/.test(cls) && c.hasText) return { name: "ListRow", why: `a list row${size ? `, ${size}` : ""}` };
    if (c.hasIcon && !c.hasText) return { name: "IconButton", why: `an icon-only button${size ? `, ${size}` : ""}` };
    if (!c.hasText && h && w && Math.abs(h - w) < 0.5 && h <= 40) return { name: "IconButton", why: `a square ${size} button` };
    if (c.hasText && (h === 24 || h === 32 || /btn|button|action|primary|secondary/.test(cls))) return { name: "Button", why: `a text button${size ? `, ${size}` : ""}` };
    if (c.hasText && c.hasIcon) return { name: "Button", why: "a button with an icon and text" };
  }
  return null;
}

// ── Looks ─────────────────────────────────────────────────────────────────────

/** Props whose value changes how a component looks */
const LOOK = new Set(["variant", "tone", "size", "shape", "fullWidth", "width", "disabled", "showLabel", "hideLabel", "prefixTone", "floating", "secondary", "compact", "chevron", "header", "collapsible", "axis", "side", "boxLabel", "pad"]);
/** Props whose presence changes how it looks (an icon is any prop named …icon…) */
const PRESENCE = new Set(["prefix", "suffix", "unit"]);
/** A run-time choice of these is still a look of its own ("chosen at run time") */
const KEEP_DYNAMIC = new Set(["variant", "tone"]);

/** A variant's appearance props: what makes two usages look different (see DsLook). */
export function lookOf(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (isIconProp(k) && !/label/i.test(k)) {
      if (v === "✓") out.icon = "✓";
    } else if (PRESENCE.has(k)) {
      if (v === "✓") out[k] = "✓";
    } else if (LOOK.has(k)) {
      if (v === "dynamic") {
        if (KEEP_DYNAMIC.has(k)) out[k] = "dynamic";
        continue;
      }
      const first = v.split(" | ")[0];
      if (k === "disabled" && first !== "true") continue;
      out[k] = k === "width" && /^-?\d/.test(first) ? "fixed" : first;
    }
  }
  return out;
}

const lookKey = (p: Record<string, string>) => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));

/** A component's variants collapsed into its distinct looks, most used first. */
export function looksOf(variants: DsVariant[]): DsLook[] {
  const looks = new Map<string, DsLook>();
  for (const v of [...variants].sort((a, b) => b.count - a.count)) {
    const props = lookOf(v.props);
    const key = lookKey(props);
    const l = looks.get(key);
    if (!l) {
      looks.set(key, { props, sample: { ...v.sample }, ...(v.text !== undefined ? { text: v.text } : {}), count: v.count, variants: 1, locs: [...v.locs] });
      continue;
    }
    l.count += v.count;
    l.variants++;
    for (const [k, val] of Object.entries(v.sample)) if (!(k in l.sample) && !LOOK.has(k)) l.sample[k] = val;
    if (l.text === undefined && v.text !== undefined) l.text = v.text;
    for (const loc of v.locs) if (l.locs.length < MAX_LOCS) l.locs.push(loc);
  }
  for (const l of looks.values()) l.locs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return [...looks.values()].sort((a, b) => b.count - a.count);
}

const transparent = (v: string | undefined) => v === undefined || /^(none|transparent|0)$/.test(v.trim());

/** The ds props that would draw a hand-made look-alike: a Button's variant from its class and fill, a size from its height, an icon if it has one. */
export function suggestFor(c: Pick<CustomControl, "className" | "hasText" | "hasIcon" | "icon" | "box">, name: string): Record<string, SampleValue> {
  const cls = (c.className ?? "").toLowerCase();
  const box = c.box ?? {};
  const h = parseFloat(box.height ?? box["min-height"] ?? "");
  const out: Record<string, SampleValue> = {};
  if (name === "Button") {
    const bg = box.background;
    const flat = transparent(bg) && transparent(box.border);
    if (/link|learn|more|older/.test(cls) || (flat && /^0(px)?$/.test(box.padding ?? "") && !h)) out.variant = "link";
    else if (/danger|destructive|delete/.test(cls)) out.variant = "destructive";
    else if (/primary|cta|submit|confirm/.test(cls) || /bg-brand/.test(bg ?? "")) out.variant = "primary";
    else if (flat) out.variant = "ghost";
    else out.variant = "secondary";
    if (h >= 28) out.size = "large";
    if (c.hasIcon && c.hasText) out.icon = c.icon ?? "24.plus";
  } else if (name === "IconButton") {
    if (h >= 28 || parseFloat(box.width ?? "") >= 28) out.size = "large";
    out.icon = c.icon ?? "24.more";
  } else if (name === "TextInput" || name === "Select" || name === "SearchField" || name === "NumericInput") {
    if (h >= 28) out.size = "large";
    if (name === "TextInput" && transparent(box.background) && transparent(box.border) && box.background !== undefined) out.variant = "ghost";
  }
  return out;
}

/** The look a suggestion already is in the app: same variant, size, tone and icon presence; not a disabled one. */
export function matchLook(looks: DsLook[], suggest: Record<string, SampleValue>): number {
  const want = { variant: suggest.variant, size: suggest.size, tone: suggest.tone, icon: suggest.icon !== undefined ? "✓" : undefined };
  return looks.findIndex((l) => !l.props.disabled && (Object.keys(want) as (keyof typeof want)[]).every((k) => (want[k] === undefined ? l.props[k] === undefined || (k === "size" && l.props[k] === "default") : String(want[k]) === l.props[k])));
}

// ── The scan ──────────────────────────────────────────────────────────────────

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function resolveImport(from: string, spec: string, o: ScanOptions): string | null {
  if (spec.startsWith("@/")) return join(o.src, spec.slice(2));
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  return null;
}

const MAX_LOCS = 400;

export function scan(o: ScanOptions): UsageIndex {
  const files = sourceFiles(o);
  const ds = new Map<string, { count: number; files: Set<string>; variants: Map<string, DsVariant> }>();
  const custom = new Map<string, CustomControl & { files: Set<string> }>();
  const tokensCss = join(o.ds, "tokens.css");
  const tokens = pxTokens(existsSync(tokensCss) ? readFileSync(tokensCss, "utf8") : "");
  const dsRoot = resolve(o.ds);
  const inDs = (p: string) => p === dsRoot || p.startsWith(dsRoot + sep);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = posix(relative(o.root, file));
    /** local name → ds export name */
    const dsNames = new Map<string, string>();
    /** namespace imports of the ds */
    const dsNamespaces = new Set<string>();
    /** local name → CSS module path */
    const cssModules = new Map<string, string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue;
      const spec = st.moduleSpecifier.text;
      const target = resolveImport(file, spec, o);
      if (!target) continue;
      if (spec.endsWith(".module.css")) {
        if (st.importClause.name) cssModules.set(st.importClause.name.text, target);
        continue;
      }
      if (!inDs(target)) continue;
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly && /^[A-Z]/.test((el.propertyName ?? el.name).text)) dsNames.set(el.name.text, (el.propertyName ?? el.name).text);
      if (nb && ts.isNamespaceImport(nb)) dsNamespaces.add(nb.name.text);
    }
    const iconTags = new Set([...dsNames].filter(([, n]) => n === "Icon").map(([l]) => l));
    for (const ns of dsNamespaces) iconTags.add(`${ns}.Icon`);

    const dsName = (tag: ts.JsxTagNameExpression): string | null => {
      if (ts.isIdentifier(tag)) return dsNames.get(tag.text) ?? null;
      if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && dsNamespaces.has(tag.expression.text)) return tag.name.text;
      return null;
    };

    /** The module classes a className expression names: [cssFile, class][] (first: the main one), or a literal. */
    const classesOf = (e: ts.Expression): { css: [string, string][]; literal?: string; dynamic: boolean } => {
      const out: [string, string][] = [];
      let dynamic = false;
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && cssModules.has(n.expression.text)) return void out.push([cssModules.get(n.expression.text)!, n.name.text]);
        if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && cssModules.has(n.expression.text)) {
          if (ts.isStringLiteral(n.argumentExpression)) out.push([cssModules.get(n.expression.text)!, n.argumentExpression.text]);
          else dynamic = true;
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(e);
      const lit = literalOf(e);
      return { css: out, literal: lit.kind === "literal" && typeof lit.value === "string" ? lit.value : undefined, dynamic: dynamic || (!out.length && lit.kind !== "literal") };
    };

    const attrs = (open: ts.JsxOpeningLikeElement) => {
      const map = new Map<string, ts.JsxAttribute>();
      let spread = false;
      for (const p of open.attributes.properties) {
        if (ts.isJsxAttribute(p)) map.set(p.name.getText(), p);
        else spread = true;
      }
      return { map, spread };
    };
    const attrLiteral = (a: ts.JsxAttribute | undefined): Literal | null => {
      if (!a) return null;
      if (!a.initializer) return { kind: "literal", value: true };
      if (ts.isStringLiteral(a.initializer)) return { kind: "literal", value: a.initializer.text };
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return literalOf(a.initializer.expression);
      return { kind: "dynamic" };
    };

    const visitDs = (node: ts.JsxOpeningLikeElement, name: string, children: readonly ts.JsxChild[]) => {
      const props: Record<string, string> = {};
      const sample: Record<string, SampleValue> = {};
      let text: string | undefined;
      const { map } = attrs(node);
      for (const [prop, a] of map) {
        if (prop === "className" || prop === "style") {
          props[prop] = "custom";
          continue;
        }
        if (skipProp(prop)) continue;
        const lit = attrLiteral(a);
        if (!lit || lit.kind === "function") continue;
        if (TEXT.has(prop)) {
          props[prop] = "✓";
          const s = a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression ? textOf(a.initializer.expression) : lit.kind === "literal" ? String(lit.value) : undefined;
          if (s !== undefined) sample[prop] = s;
          if (prop === "label") text ??= s;
          continue;
        }
        if (isIconProp(prop)) {
          props[prop] = "✓";
          const v = lit.kind === "literal" ? lit.value : lit.kind === "choice" ? lit.values[0] : undefined;
          if (v !== undefined && v !== false) sample[prop] = v;
          continue;
        }
        const s = shown(lit);
        if (s === null || (STATES.has(prop) && lit.kind !== "literal")) continue;
        props[prop] = s;
        if (lit.kind === "literal") sample[prop] = lit.value;
        else if (lit.kind === "choice") sample[prop] = lit.values[0];
      }
      const content = contentOf(children, iconTags);
      if (content.hasText) {
        props.children = content.text !== undefined ? "text" : "dynamic";
        text = content.text ?? text;
      }
      const key = JSON.stringify(Object.keys(props).sort().map((k) => [k, props[k]]));
      let entry = ds.get(name);
      if (!entry) ds.set(name, (entry = { count: 0, files: new Set(), variants: new Map() }));
      entry.count++;
      entry.files.add(rel);
      let v = entry.variants.get(key);
      if (!v) entry.variants.set(key, (v = { props, sample, ...(text !== undefined ? { text } : {}), count: 0, locs: [] }));
      else {
        for (const [k, val] of Object.entries(sample)) if (!(k in v.sample)) v.sample[k] = val;
        if (v.text === undefined && text !== undefined) v.text = text;
      }
      v.count++;
      if (v.locs.length < MAX_LOCS) v.locs.push({ file: rel, line: lineOf(sf, node) });
    };

    const visitRaw = (node: ts.JsxOpeningLikeElement, tag: string, children: readonly ts.JsxChild[]) => {
      const { map } = attrs(node);
      const roleLit = attrLiteral(map.get("role"));
      const role = roleLit?.kind === "literal" && typeof roleLit.value === "string" ? roleLit.value : undefined;
      const cn = map.get("className");
      const isControl = CONTROL_TAGS.has(tag) || (role !== undefined && CONTROL_ROLES.has(role)) || (tag === "a" && cn !== undefined);
      if (!isControl) return;
      const typeLit = tag === "input" ? attrLiteral(map.get("type")) : null;
      const type = typeLit?.kind === "literal" ? String(typeLit.value) : tag === "input" ? (map.has("type") ? "dynamic" : "text") : undefined;
      let cssFile: string | null = null, className: string | null = null, extra: string[] = [];
      if (cn?.initializer) {
        if (ts.isStringLiteral(cn.initializer)) className = cn.initializer.text;
        else if (ts.isJsxExpression(cn.initializer) && cn.initializer.expression) {
          const c = classesOf(cn.initializer.expression);
          if (c.css.length) {
            cssFile = c.css[0][0];
            className = c.css[0][1];
            extra = [...new Set(c.css.slice(1).filter(([f]) => f === cssFile).map(([, k]) => k))].filter((k) => k !== className);
          } else if (c.literal !== undefined) className = c.literal;
          else className = "(dynamic)";
        }
      }
      const shownTag = CONTROL_TAGS.has(tag) || tag === "a" ? tag : `${tag}[role=${role}]`;
      const cssRel = cssFile ? posix(relative(o.root, cssFile)) : null;
      const key = [shownTag, type ?? "", cssRel ?? "", className ?? ""].join("|");
      const content = contentOf(children, iconTags);
      const hasText = content.hasText || (tag === "input" && map.has("placeholder"));
      let c = custom.get(key);
      if (!c) {
        c = { tag: shownTag, ...(type ? { type } : {}), ...(role ? { role } : {}), cssFile: cssRel, className, extraClasses: [], hasText: false, hasIcon: false, count: 0, locs: [], files: new Set() };
        custom.set(key, c);
      }
      for (const k of extra) if (!c.extraClasses.includes(k)) c.extraClasses.push(k);
      c.hasText ||= hasText;
      c.hasIcon ||= content.hasIcon;
      if (c.text === undefined) {
        const ph = tag === "input" || tag === "textarea" ? attrLiteral(map.get("placeholder")) : null;
        const t = content.text ?? (ph?.kind === "literal" ? String(ph.value) : undefined) ?? (map.get("placeholder")?.initializer && ts.isJsxExpression(map.get("placeholder")!.initializer!) ? textOf((map.get("placeholder")!.initializer as ts.JsxExpression).expression!) : undefined);
        if (t !== undefined) c.text = t;
      }
      c.icon ??= content.icon;
      c.count++;
      c.files.add(rel);
      if (c.locs.length < MAX_LOCS) c.locs.push({ file: rel, line: lineOf(sf, node) });
    };

    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const open = ts.isJsxElement(n) ? n.openingElement : n;
        const children = ts.isJsxElement(n) ? n.children : ([] as ts.JsxChild[]);
        const name = dsName(open.tagName);
        if (name) visitDs(open, name, children);
        else if (ts.isIdentifier(open.tagName) && /^[a-z]/.test(open.tagName.text)) visitRaw(open, open.tagName.text, children);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // The CSS of each hand-made control's class: its box, whether it needs its context, what it looks like.
  for (const c of custom.values()) {
    if (c.cssFile && c.className) {
      const info = classInfo(readCss(join(o.root, c.cssFile)), c.className);
      const box: Record<string, string> = {};
      for (const k of BOX) if (info.own[k] !== undefined) box[k] = resolvePx(info.own[k], tokens);
      if (Object.keys(box).length) c.box = box;
      const hidden = /^(0|0\.0+)$/.test(info.own.opacity ?? "") || info.own.visibility === "hidden" || info.own.display === "none";
      if (!info.ownRules && info.contextual.length) c.needsContext = `styled only inside ${info.contextual[0].split(/\s*[\s>+~]\s*/)[0]}`;
      else if (info.own.position === "absolute" || info.own.position === "fixed") c.needsContext = `position: ${info.own.position}`;
      else if (hidden) c.needsContext = "hidden until its parent is hovered or active";
      else if (!info.ownRules && !info.contextual.length) c.needsContext = "no rule for this class";
    } else if (c.className === "(dynamic)") c.needsContext = "class chosen at run time";
    const sim = similarTo(c);
    if (sim) {
      c.similarTo = sim.name;
      c.similarWhy = sim.why;
    }
  }

  const dsOut: DsComponentUsage[] = [...ds]
    .map(([name, e]) => ({ name, count: e.count, files: e.files.size, looks: looksOf([...e.variants.values()]) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  // What would replace each look-alike, and whether the app already has that look
  for (const c of custom.values()) {
    if (!c.similarTo) continue;
    c.suggest = suggestFor(c, c.similarTo);
    const looks = dsOut.find((d) => d.name === c.similarTo)?.looks ?? [];
    const i = matchLook(looks, c.suggest);
    if (i >= 0) c.lookIndex = i;
  }
  const customOut: CustomControl[] = [...custom.values()]
    .map(({ files: _files, ...c }) => c)
    .sort((a, b) => b.count - a.count || (a.cssFile ?? "").localeCompare(b.cssFile ?? "") || (a.className ?? "").localeCompare(b.className ?? ""));
  return { files: files.length, ds: dsOut, custom: customOut };
}
