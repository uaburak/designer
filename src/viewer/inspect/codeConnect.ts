/**
 * Code Connect snippets in Inspect (docs/editor.md D-1 "Snippets in Inspect"), for the editor's Dev Mode and the
 * viewer:
 *
 * - `targetOf`: the mapping a layer looks up — a main component (or variant, then its set) in this file, or a library
 *   copy's main in its library file (copies keep the library's GUIDs, data.md §9.4);
 * - `snapshotOf`: the instance as the template API reads it (properties by name, layers with their text, nested
 *   instances with their own mappings), read from the engine once;
 * - `codeConnectSnippets`: one snippet per label — a CLI mapping's template run in the plugin VM (`createSandbox`,
 *   1 s, codeConnectRuntime.js), a UI mapping's snippet "Generated from properties";
 * - `renderSections`: Figma's result sections as text plus pills (nested instances that aren't nestable).
 */
import type { Engine } from "@/engine/Engine";
import type { ComponentInfo, ComponentProperty, Guid } from "@/engine/codec";
import type { CodeConnectMapping, CodeConnectSnippet } from "@shared/devmode/types";
import runtimeSource from "./codeConnectRuntime.js?raw";

/** What a snippet needs from its host: the mappings of a file, and the plugin VM. */
export interface CodeConnectSource {
  /** This file's key (local or room key): mappings of local components live under it */
  fileKey: string | null;
  mappings(fileKey: string): Promise<CodeConnectMapping[]>;
  /** The plugin VM (src/renderer/src/editor/plugins `createSandbox`); absent: templates aren't run */
  sandbox?: SandboxFactory;
}

export type SandboxFactory = (opts: { kind: "template"; code: string; api: Record<string, unknown>; timeoutMs?: number; memoryMb?: number }) => Promise<{ call(fn: string, ...args: unknown[]): Promise<unknown>; dispose(): void }>;

/** A piece of a snippet as Inspect draws it: text, or a pill that selects a nested instance. */
export type SnippetSegment = { text: string } | { pill: string; nodeId: Guid } | { error: string };

export interface ViewSnippet extends CodeConnectSnippet {
  segments: SnippetSegment[];
  /** The mapping's instructions for MCP */
  instructions: string;
}

export interface ConnectTarget {
  fileKey: string;
  /** The node first (a variant, a component), then its set */
  nodeIds: Guid[];
}

/** The mapping lookup of a layer: its main (or itself, for a main) and the file that holds it. */
export function targetOf(info: ComponentInfo | null, fileKey: string | null): ConnectTarget | null {
  if (!info) return null;
  if (info.kind === "COMPONENT_SET") return fileKey ? { fileKey, nodeIds: [info.ref] } : null;
  const main = info.main;
  if (!main || (info.kind !== "INSTANCE" && info.kind !== "NESTED_INSTANCE" && info.kind !== "COMPONENT" && info.kind !== "VARIANT")) return null;
  const key = main.remote?.libraryKey ?? fileKey;
  if (!key) return null;
  return { fileKey: key, nodeIds: main.set ? [main.ref, main.set] : [main.ref] };
}

/** The mappings that apply, one per label: the node's own before its set's. */
export function mappingsFor(all: readonly CodeConnectMapping[], target: ConnectTarget): CodeConnectMapping[] {
  const byLabel = new Map<string, CodeConnectMapping>();
  for (const id of target.nodeIds) for (const m of all) if (m.nodeId === id && !byLabel.has(m.label)) byLabel.set(m.label, m);
  return [...byLabel.values()];
}

// ---- The instance's snapshot ----------------------------------------------------------------------------------------

export interface SnapNode {
  id: Guid;
  name: string;
  type: string;
  visible: boolean;
  text?: string;
  children: SnapNode[];
  props?: Record<string, { type: "BOOL" | "TEXT" | "VARIANT" | "INSTANCE_SWAP" | "SLOT"; value: string | boolean | null; layer: Guid | null }>;
  /** The key of its mapping in `templates` (one of the label's) */
  mapping?: string;
  mainName?: string;
}

interface Read {
  readNode(id: Guid, opts: { childIds: true; fields: string[] }): { name?: string; type?: string; visible?: boolean; childIds?: Guid[]; textData?: { characters?: string } } | null;
  componentInfo(id: Guid): ComponentInfo | null;
}

function propsOf(info: ComponentInfo): SnapNode["props"] {
  const out: NonNullable<SnapNode["props"]> = {};
  for (const p of info.properties as ComponentProperty[]) {
    const type = p.type as NonNullable<SnapNode["props"]>[string]["type"];
    const value = p.value ?? p.defaultValue;
    // An instance swap or slot points at the layer it fills (its bound layer, in instance space).
    out[p.name] = { type, value: typeof value === "boolean" || typeof value === "string" ? value : null, layer: p.boundLayers[0] ?? null };
  }
  return out;
}

const MAX_SNAPSHOT_NODES = 2000;

/** The layer and everything under it, as the template API reads it. */
export function snapshotOf(engine: Read, id: Guid): SnapNode | null {
  let count = 0;
  const walk = (ref: Guid, depth: number): SnapNode | null => {
    if (++count > MAX_SNAPSHOT_NODES || depth > 40) return null;
    const n = engine.readNode(ref, { childIds: true, fields: ["name", "type", "visible", "textData"] });
    if (!n) return null;
    const type = n.type === "SYMBOL" ? "COMPONENT" : (n.type ?? "FRAME");
    const out: SnapNode = { id: ref, name: n.name ?? "", type, visible: n.visible !== false, children: [] };
    if (n.type === "TEXT") out.text = n.textData?.characters ?? "";
    if (n.type === "INSTANCE" || n.type === "SYMBOL" || depth === 0) {
      const info = engine.componentInfo(ref);
      if (info && info.kind !== "NONE" && info.kind !== "INSTANCE_SUBLAYER" && info.kind !== "COMPONENT_SUBLAYER") {
        out.props = propsOf(info);
        if (info.main) out.mainName = info.main.name.split("/").pop()?.trim() || info.main.name;
        // A main component reads like an instance of itself (the playground and a main's Inspect).
        if (depth === 0) out.type = "INSTANCE";
      }
    }
    for (const c of n.childIds ?? []) {
      const s = walk(c, depth + 1);
      if (s) out.children.push(s);
    }
    return out;
  };
  return walk(id, 0);
}

function* instancesIn(n: SnapNode): Generator<SnapNode> {
  for (const c of n.children) {
    if (c.type === "INSTANCE") yield c;
    yield* instancesIn(c);
  }
}

// ---- Rendering ---------------------------------------------------------------------------------------------------------

type Section = { type: "CODE"; code: string } | { type: "INSTANCE"; guid: Guid; name: string } | { type: "ERROR"; message: string };

export function renderSections(sections: readonly Section[], language: string): { code: string; segments: SnippetSegment[] } {
  const segments: SnippetSegment[] = [];
  let code = "";
  for (const s of sections) {
    if (s.type === "CODE") {
      segments.push({ text: s.code });
      code += s.code;
    } else if (s.type === "INSTANCE") {
      segments.push({ pill: s.name, nodeId: s.guid });
      code += language === "swift" || language === "kotlin" ? `${s.name}()` : `<${s.name} />`;
    } else {
      segments.push({ error: s.message });
      code += `/* ${s.message} */`;
    }
  }
  return { code, segments };
}

/** Imports first (hoisted, deduplicated), then the example. */
function withImports(imports: readonly string[], body: { code: string; segments: SnippetSegment[] }): { code: string; segments: SnippetSegment[] } {
  if (!imports.length) return body;
  const head = `${imports.join("\n")}\n\n`;
  return { code: head + body.code, segments: [{ text: head }, ...body.segments] };
}

// ---- UI mappings: "Generated from properties" ------------------------------------------------------------------------

const camel = (name: string) => {
  const words = name.replace(/#.*$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "prop";
  const s = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  return /^[0-9]/.test(s) ? `_${s}` : s;
};
const pascal = (name: string) => {
  const s = name.split("/").pop()!.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return s || "Component";
};

/**
 * A UI mapping's snippet (ours; Figma shows an AI preview there): `import { ‹component› } from "‹source›"` and the
 * component with the instance's properties — booleans, variants as strings, text, instance swaps by their mapped
 * names.
 */
export function generatedSnippet(root: SnapNode, mapping: Pick<CodeConnectMapping, "component" | "source" | "imports">, nameOf: (swapped: SnapNode) => string): string {
  const component = mapping.component || pascal(root.mainName ?? root.name);
  const attrs: string[] = [];
  for (const [name, p] of Object.entries(root.props ?? {})) {
    const key = camel(name);
    if (p.type === "BOOL") attrs.push(p.value ? key : `${key}={false}`);
    else if (p.type === "TEXT" || p.type === "VARIANT") attrs.push(`${key}=${JSON.stringify(String(p.value ?? ""))}`);
    else if (p.type === "INSTANCE_SWAP") {
      const swapped = p.layer ? findNode(root, p.layer) : null;
      if (swapped) attrs.push(`${key}={<${nameOf(swapped)} />}`);
    }
  }
  const imports = mapping.imports.length ? mapping.imports : mapping.source ? [`import { ${component} } from ${JSON.stringify(mapping.source)}`] : [];
  const tag = attrs.length > 2 ? `<${component}\n${attrs.map((a) => `  ${a}`).join("\n")}\n/>` : `<${component}${attrs.map((a) => ` ${a}`).join("")} />`;
  return `${imports.length ? `${imports.join("\n")}\n\n` : ""}${tag}`;
}

function findNode(root: SnapNode, id: Guid): SnapNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

// ---- Snippets -----------------------------------------------------------------------------------------------------------

const keyOf = (m: Pick<CodeConnectMapping, "fileKey" | "nodeId" | "label">) => `${m.fileKey}|${m.nodeId}|${m.label}`;

/** Our CLI stores a batch's entry as the template's first line (`var __codeConnectBatch = {…};`). */
export function batchOf(template: string): unknown {
  const m = /^\s*var __codeConnectBatch = (.*);\s*$/m.exec(template.split("\n", 1)[0] ?? "");
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

const ERROR_TYPES = new Set(["PROPERTY_NOT_FOUND", "CHILD_LAYER_NOT_FOUND", "PROPERTY_TYPE_MISMATCH", "TEMPLATE_EXECUTION_ERROR"]);

/** Runs a CLI mapping's template over the snapshot in a fresh VM (1 s). */
export async function runTemplate(root: SnapNode, mapping: CodeConnectMapping, nested: Map<string, CodeConnectMapping>, sandbox: SandboxFactory): Promise<{ sections: Section[]; imports: string[] } | { error: NonNullable<CodeConnectSnippet["error"]> }> {
  const templates: Record<string, { template: string; batch: unknown; nestable: boolean; component: string | null; label: string }> = {};
  const add = (m: CodeConnectMapping) => {
    templates[keyOf(m)] = m.template
      ? { template: m.template, batch: batchOf(m.template), nestable: m.nestable, component: m.component, label: m.label }
      : // A nested UI mapping has no template: its snippet is its component's tag.
        { template: `export default { example: figma.code\`<${m.component || "Component"} />\`, imports: ${JSON.stringify(m.imports.length ? m.imports : m.source ? [`import { ${m.component || "Component"} } from ${JSON.stringify(m.source)}`] : [])}, metadata: { nestable: ${m.nestable} } }`, batch: undefined, nestable: m.nestable, component: m.component, label: m.label };
  };
  add(mapping);
  for (const m of nested.values()) add(m);
  root.mapping = keyOf(mapping);
  let vm: Awaited<ReturnType<SandboxFactory>> | null = null;
  try {
    vm = await sandbox({ kind: "template", code: runtimeSource, api: {}, timeoutMs: 1000, memoryMb: 64 });
    const r = (await vm.call("__ccRun", { root, templates, language: mapping.language })) as { sections?: Section[]; imports?: string[]; error?: { type: string; message: string } };
    if (r.error) return { error: { type: (ERROR_TYPES.has(r.error.type) ? r.error.type : "TEMPLATE_EXECUTION_ERROR") as NonNullable<CodeConnectSnippet["error"]>["type"], message: r.error.message } };
    return { sections: r.sections ?? [], imports: r.imports ?? [] };
  } catch (e) {
    return { error: { type: "TEMPLATE_EXECUTION_ERROR", message: e instanceof Error ? e.message : String(e) } };
  } finally {
    vm?.dispose();
  }
}

/**
 * The layer's Code Connect snippets, one per label (an empty list: no mapping — Inspect shows only the built-in
 * code). Nested instances with mappings of the same label are run inline or shown as pills.
 */
export async function codeConnectSnippets(engine: Pick<Engine, "componentInfo"> & Read, id: Guid, source: CodeConnectSource, opts: { target?: ConnectTarget | null } = {}): Promise<ViewSnippet[]> {
  // `target`: the mapping to use when the layer isn't in its file (the playground's scratch copy of a component)
  const target = opts.target ?? targetOf(engine.componentInfo(id), source.fileKey);
  if (!target) return [];
  const cache = new Map<string, Promise<CodeConnectMapping[]>>();
  const mappingsOf = (key: string) => {
    let p = cache.get(key);
    if (!p) cache.set(key, (p = source.mappings(key).catch(() => [])));
    return p;
  };
  const own = mappingsFor(await mappingsOf(target.fileKey), target);
  if (!own.length) return [];
  const root = snapshotOf(engine, id);
  if (!root) return [];
  // Nested instances' targets, then their mappings by label.
  const nestedTargets: { node: SnapNode; target: ConnectTarget }[] = [];
  for (const n of instancesIn(root)) {
    const t = targetOf(engine.componentInfo(n.id), source.fileKey);
    if (t) nestedTargets.push({ node: n, target: t });
  }
  const out: ViewSnippet[] = [];
  for (const mapping of own) {
    const nested = new Map<string, CodeConnectMapping>();
    for (const { node, target: t } of nestedTargets) {
      const m = mappingsFor(await mappingsOf(t.fileKey), t).find((x) => x.label === mapping.label);
      if (m) {
        node.mapping = keyOf(m);
        nested.set(keyOf(m), m);
      } else delete node.mapping;
    }
    const base = { label: mapping.label, language: mapping.language, source: mapping.source, component: mapping.component, instructions: mapping.instructions };
    if (mapping.template && mapping.origin === "cli") {
      if (!source.sandbox) {
        out.push({ ...base, code: "", imports: [], origin: "cli", error: { type: "TEMPLATE_EXECUTION_ERROR", message: "Code Connect templates run in the app" }, segments: [] });
        continue;
      }
      const r = await runTemplate(root, mapping, nested, source.sandbox);
      if ("error" in r) {
        out.push({ ...base, code: "", imports: [], origin: "cli", error: r.error, segments: [] });
        continue;
      }
      const body = withImports(r.imports, renderSections(r.sections, mapping.language));
      out.push({ ...base, code: body.code, imports: r.imports, origin: "cli", error: null, segments: body.segments });
    } else {
      const nameOf = (swapped: SnapNode) => {
        const m = swapped.mapping ? nested.get(swapped.mapping) : null;
        return m?.component || pascal(swapped.mainName ?? swapped.name);
      };
      const code = generatedSnippet(root, mapping, nameOf);
      out.push({ ...base, code, imports: mapping.imports, origin: "ui", error: null, segments: [{ text: code }] });
    }
  }
  return out;
}

/** "‹component› · ‹source›" opens `source` when it is a link. */
export const sourceUrl = (source: string | null): string | null => (source && /^https?:\/\//i.test(source) ? source : null);
