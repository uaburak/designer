// @vitest-environment happy-dom
// The editor's plugin service (docs/plugins.md §6) on the real engine: development plugins listed from main (a fake),
// the Plugins menu with each plugin's own menu, a menu command run, Actions' rows (commands found by search),
// recents and Run last plugin, the approval check refusing a run, Hot reload restarting a running plugin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { MenuEntry, MenuItem } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { PluginBundle, PluginRef } from "@shared/plugins/types";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { attachPlugins, pluginsOf } from "../service";
import { pluginsMenu, runPluginMenuItem } from "../menus";
import { pluginRows } from "../actions";
import type { PluginDesktop } from "../desktop";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FIXTURES = join(process.cwd(), "src/renderer/src/editor/plugins/__tests__/fixtures");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

function bundle(name: string, code?: string): PluginBundle {
  const dir = join(FIXTURES, name);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return { manifest, code: code ?? readFileSync(join(dir, "code.js"), "utf8"), ui: {} };
}

async function setup(options: { allowed?: boolean } = {}) {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Service test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const bundles: Record<string, PluginBundle> = { "fixture-rename-layers": bundle("rename-layers"), "fixture-rectangles": bundle("rectangles") };
  let changed: (e: { id: string }) => void = () => {};
  const reads: string[] = [];
  const desktop: PluginDesktop = {
    listDevelopment: async () => Object.keys(bundles).map((id) => ({ id, name: bundles[id].manifest.name, path: `/dev/${id}`, addedAt: 0 })),
    importManifest: async () => ({ cancelled: true }),
    removeDevelopment: async () => [],
    read: async (id) => {
      reads.push(id);
      return bundles[id];
    },
    openUi: async ({ runId }) => ({ url: `plugin://${runId}/ui.html` }),
    closeUi: async () => {},
    fetch: async () => {
      throw new Error("no network in tests");
    },
    storage: async () => undefined,
    openConsole: async () => {},
    onChanged: (l) => {
      changed = l;
      return () => {};
    },
  };
  const ran: PluginRef[] = [];
  const store = {
    local: async () => ({ saved: [], recents: [] }),
    setSaved: async () => {},
    ranRecently: async (ref: PluginRef) => void ran.push(ref),
    listPrivate: async () => [],
    bundle: async () => {
      throw new Error("none");
    },
    allowed: async () => (options.allowed === false ? ({ ok: false, reason: "approval", canRequest: true } as const) : ({ ok: true } as const)),
  };
  const detach = attachPlugins(ed, { desktop, store, env: { console: () => {} } });
  const s = pluginsOf(ed)!;
  await s.refresh();
  return { ed, engine, s, bundles, reads, ran, detach, fireChanged: (id: string) => changed({ id }) };
}

const labels = (entries: MenuEntry[] | undefined): string[] => (entries ?? []).map((e) => (e === "-" ? "-" : "header" in e ? `#${e.header}` : e.label));
const sub = (entries: MenuEntry[] | undefined, label: string) => (entries ?? []).find((e): e is MenuItem => e !== "-" && !("header" in e) && e.label === label);
const item = (id: string, label?: string): MenuItem => ({ id, label: label ?? id });

describe("the plugin service", () => {
  it("lists development plugins with their manifests; the Plugins menu has Development ▸ with each plugin's menu", async () => {
    const { ed, s } = await setup();
    expect(s.get().development.map((e) => e.ref.name)).toEqual(["Rename layers", "Rectangles"]);
    const menu = pluginsMenu(ed, item);
    expect(labels(menu.items)).toEqual(["plugins.run-last", "-", "Saved plugins", "-", "Development", "-", "plugins.manage"]);
    const dev = sub(menu.items, "Development")!;
    expect(labels(dev.items)).toEqual(["plugins.new", "plugins.import", "-", "Rename layers", "Rectangles", "-", "plugins.hot-reload", "plugins.developer-vm", "plugins.open-console"]);
    expect(labels(sub(dev.items, "Rename layers")!.items)).toEqual(["Number them", "-", "Upper case"]);
  });

  it("runs a menu command (figma.command) from its menu row; it joins recents and becomes Run last plugin", async () => {
    const { ed, engine, s, ran } = await setup();
    const kids = (engine.readNode(ed.store.page, { childIds: true })!.childIds as Guid[]).slice(0, 1);
    const before = engine.readNode(kids[0])!.name!;
    engine.setSelection(kids);
    const upper = sub(sub(sub(pluginsMenu(ed, item).items, "Development")!.items, "Rename layers")!.items, "Upper case")!;
    expect(runPluginMenuItem(ed, upper.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.readNode(kids[0])!.name).toBe(`${before.toUpperCase()} (first)`);
    expect(s.get().recents.map((r) => r.name)).toEqual(["Rename layers"]);
    expect(s.get().last).toMatchObject({ command: "upper" });
    expect(ran.map((r) => r.id)).toEqual(["fixture-rename-layers"]);
    // The menu's run section lists it now.
    expect(labels(pluginsMenu(ed, item).items)).toContain("Rename layers");
  });

  it("Actions' rows: by section, and typed into, the plugins' commands as rows of their own", async () => {
    const { s } = await setup();
    expect(pluginRows(s, "").map((r) => `${r.section}/${r.label}`)).toEqual(["Development/Rename layers", "Development/Rectangles"]);
    expect(pluginRows(s, "upper").map((r) => [r.label, r.command])).toEqual([["Rename layers › Upper case", "upper"]]);
  });

  it("refuses a run the organization doesn't approve", async () => {
    const { s, reads } = await setup({ allowed: false });
    const before = reads.length;
    const run = await s.run(s.get().development[1].ref);
    expect(run).toBeNull();
    expect(reads.length).toBe(before); // no bundle read for a refused run
    expect(s.get().running).toEqual([]);
  });

  it("Hot reload restarts a running development plugin with its new code", async () => {
    const { s, bundles, fireChanged } = await setup();
    bundles["fixture-rectangles"] = bundle("rectangles", "setInterval(() => {}, 1000);");
    const first = (await s.run(s.get().development[1].ref))!;
    expect(first.running).toBe(true);
    bundles["fixture-rectangles"] = bundle("rectangles", "figma.root.setPluginData('v', '2'); setInterval(() => {}, 1000);");
    fireChanged("fixture-rectangles");
    await first.ended;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.get().running).toHaveLength(1);
    expect(s.ed.engine.readNode("0:0")!.pluginData?.find((e) => e.key === "v")?.value).toBe("2");
    s.stopAll();
  });
});
