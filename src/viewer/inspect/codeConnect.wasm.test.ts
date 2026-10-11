// @vitest-environment happy-dom
// Code Connect snippets on the real engine and the real plugin VM (docs/editor.md D-1): a CLI template over an
// instance (getString / getBoolean / getInstanceSwap, nested connected instances inline or as pills, imports hoisted),
// a variant's mapping found on its set (getEnum), a batch template, Figma's error names, a UI mapping "Generated from
// properties", and the lookup of a library copy's main in its library.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { memoryDocumentSource } from "@/editor/documentSource";
import { COMPONENTS_DOCUMENT } from "@/editor/fixtures";
import { createSandbox } from "@/editor/plugins";
import type { CodeConnectMapping } from "@shared/devmode/types";
// @ts-expect-error -- the CLI is plain .mjs (tools/code-connect)
import { toScript } from "../../../tools/code-connect/connect.mjs";
import { codeConnectSnippets, mappingsFor, targetOf, type CodeConnectSource } from "./codeConnect";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm"));
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engine() {
  const source = memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components" });
  const e = await Engine.create(null, { sessionID: 1 });
  e.load(await source.load());
  return e;
}

const mapping = (m: Partial<CodeConnectMapping> & Pick<CodeConnectMapping, "nodeId">): CodeConnectMapping => ({
  fileKey: "file1",
  label: "React",
  language: "tsx",
  origin: "cli",
  source: "src/Button.tsx",
  component: "Button",
  template: null,
  imports: [],
  nestable: true,
  instructions: "",
  updatedBy: null,
  updatedAt: 0,
  ...m,
});

const sourceOf = (list: CodeConnectMapping[]): CodeConnectSource => ({ fileKey: "file1", mappings: async (key) => list.filter((m) => m.fileKey === key), sandbox: createSandbox });

const BUTTON = `// url=https://example.com/f/file1?node-id=1-1
import figma from 'figma'
const instance = figma.selectedInstance
const label = instance.getString('Label')
const icon = instance.getBoolean('Show icon') ? instance.getInstanceSwap('Icon') : undefined
export default {
  example: figma.code\`<Button>
  \${icon}
  \${label}
</Button>\`,
  imports: ['import { Button } from "./Button"'],
  id: 'button',
  metadata: { nestable: true },
}`;

const STAR = (nestable: boolean) => `import figma from "figma"
export default { example: figma.code\`<StarIcon filled={\${figma.selectedInstance.getBoolean('Filled')}} />\`, imports: ['import { StarIcon } from "./icons"'], id: 'star', metadata: { nestable: ${nestable} } }`;

describe("Code Connect snippets (wasm engine + plugin VM)", () => {
  it("runs a CLI template: properties, a nested connected instance inline with its imports hoisted", async () => {
    const e = await engine();
    const list = [mapping({ nodeId: "1:1", template: BUTTON }), mapping({ nodeId: "1:20", template: STAR(true), component: "StarIcon" })];
    const [s] = await codeConnectSnippets(e, "2:2", sourceOf(list));
    expect(s.error).toBeNull();
    expect(s.label).toBe("React");
    expect(s.code).toBe(['import { Button } from "./Button"', 'import { StarIcon } from "./icons"', "", "<Button>", "  <StarIcon filled={true} />", "  Sign in", "</Button>"].join("\n"));
  });

  it("a nested instance that isn't nestable is a pill naming it", async () => {
    const e = await engine();
    const list = [mapping({ nodeId: "1:1", template: BUTTON }), mapping({ nodeId: "1:20", template: STAR(false), component: "StarIcon" })];
    const [s] = await codeConnectSnippets(e, "2:2", sourceOf(list));
    expect(s.segments).toContainEqual({ pill: "StarIcon", nodeId: "I2:2;1:2" });
    expect(s.code).toContain("<StarIcon />");
  });

  it("an unconnected nested instance renders as its component's tag", async () => {
    const e = await engine();
    const [s] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: BUTTON })]));
    expect(s.code).toContain("  <Star />");
  });

  it("a variant's instance finds the set's mapping; getEnum maps values; a batch template reads figma.batch", async () => {
    const e = await engine();
    const chip = `var __codeConnectBatch = {"url":"https://example.com/f/file1?node-id=1-40","component":"Chip","tone":"brand"};
import figma from 'figma'
const size = figma.selectedInstance.getEnum('Size', { Small: 'sm', Large: 'lg' })
export default { example: figma.code\`<\${figma.batch.component} size="\${size}" tone="\${figma.batch.tone}" />\` }`;
    expect(targetOf(e.componentInfo("2:3"), "file1")).toEqual({ fileKey: "file1", nodeIds: ["1:41", "1:40"] });
    const [s] = await codeConnectSnippets(e, "2:3", sourceOf([mapping({ nodeId: "1:40", template: chip, component: "Chip" })]));
    expect(s.code).toBe('<Chip size="sm" tone="brand" />');
  });

  it("errors carry Figma's names", async () => {
    const e = await engine();
    const missing = `export default { example: figma.code\`\${figma.selectedInstance.getString('Nope')}\` }`;
    const [a] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: missing })]));
    expect(a.error?.type).toBe("PROPERTY_NOT_FOUND");
    const mismatch = `export default { example: figma.code\`\${figma.selectedInstance.getBoolean('Label')}\` }`;
    const [b] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: mismatch })]));
    expect(b.error?.type).toBe("PROPERTY_TYPE_MISMATCH");
    const layer = `const t = figma.selectedInstance.findText('Nothing'); export default { example: figma.code\`\${t}\` }`;
    const [c] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: layer })]));
    expect(c.error?.type).toBe("CHILD_LAYER_NOT_FOUND");
    const thrown = `throw new Error("boom")`;
    const [d] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: thrown })]));
    expect(d.error).toEqual({ type: "TEMPLATE_EXECUTION_ERROR", message: "boom" });
    const loop = `for (;;) {}`;
    const [f] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template: loop })]));
    expect(f.error?.type).toBe("TEMPLATE_EXECUTION_ERROR");
  }, 15_000);

  it("findText, findInstance and helpers.react", async () => {
    const e = await engine();
    const t = `const i = figma.selectedInstance
const icon = i.findInstance('Icons/Star')
export default { example: figma.code\`<Button\${figma.helpers.react.renderProp('label', i.findText('Label').textContent)}\${figma.helpers.react.renderProp('disabled', false)}\${figma.helpers.react.renderProp('icon', icon)} />\` }`;
    const list = [mapping({ nodeId: "1:1", template: t }), mapping({ nodeId: "1:20", template: STAR(true) })];
    const [s] = await codeConnectSnippets(e, "2:2", sourceOf(list));
    expect(s.error).toBeNull();
    expect(s.code).toContain('<Button label="Sign in" icon={<StarIcon filled={true} />} />');
  });

  it("a UI mapping is generated from the instance's properties; labels are separate tabs", async () => {
    const e = await engine();
    const list = [mapping({ nodeId: "1:1", origin: "ui", label: "React" }), mapping({ nodeId: "1:1", origin: "ui", label: "SwiftUI", language: "swift", component: "DSButton", source: "https://github.com/x/y/Button.swift" }), mapping({ nodeId: "1:20", origin: "ui", component: "StarIcon" })];
    const snippets = await codeConnectSnippets(e, "2:2", sourceOf(list));
    expect(snippets.map((s) => s.label)).toEqual(["React", "SwiftUI"]);
    expect(snippets[0].code).toBe(['import { Button } from "src/Button.tsx"', "", "<Button\n  showIcon\n  label=\"Sign in\"\n  icon={<StarIcon />}\n/>"].join("\n"));
    expect(snippets[0].origin).toBe("ui");
  });

  it("no mapping: no snippets; a library copy looks in its library", async () => {
    const e = await engine();
    expect(await codeConnectSnippets(e, "2:2", sourceOf([]))).toEqual([]);
    const info = e.componentInfo("2:2")!;
    const lib = { ...info, main: { ...info.main!, remote: { libraryKey: "lib9", key: "k", version: "1" } } };
    const t = targetOf(lib, "file1")!;
    expect(t).toEqual({ fileKey: "lib9", nodeIds: ["1:1"] });
    expect(mappingsFor([mapping({ fileKey: "lib9", nodeId: "1:1" }), mapping({ fileKey: "lib9", nodeId: "1:1", label: "Vue" })], t).map((m) => m.label)).toEqual(["React", "Vue"]);
  });

  it("a template as our CLI publishes it (TypeScript stripped, the figma import removed) runs as written", async () => {
    const e = await engine();
    const ts = `// url=https://example.com/f/file1?node-id=1-1
// source=src/Button.tsx
import figma from "figma";
const label: string = figma.selectedInstance.getString("Label");
export default { example: figma.code\`<Button>\${label}</Button>\`, id: "button" };
`;
    const template = (await toScript(ts, "Button.figma.ts")) as string;
    const [s] = await codeConnectSnippets(e, "2:2", sourceOf([mapping({ nodeId: "1:1", template })]));
    expect(s.error).toBeNull();
    expect(s.code).toBe("<Button>Sign in</Button>");
  });
});
