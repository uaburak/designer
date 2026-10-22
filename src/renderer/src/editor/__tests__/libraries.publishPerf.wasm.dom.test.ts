// @vitest-environment happy-dom
/**
 * Publishing a big library stays fast and never holds the tab (the owner's HeroUI kit — 8,295 assets — froze the
 * editor: "HeroUI isn't responding"). On the real engine (headless Wasm) and the MemoryStore, a synthetic kit of
 * 1,000 components — icons, variant sets whose variants nest icon instances, cards nesting variant instances — is
 * drafted and published: each within a bound, the event loop answered all along (no slice past a bound), and the
 * chunked payloads the same as one engine call over every key gives.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message, NodeChange } from "@/engine/codec";
import { encodeMessage } from "@shared/schema/codec";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorController } from "../controller";
import { ENCODE_CHUNK, draftPublish, publishLibrary, publishPlan, yieldToEventLoop } from "../libraries";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const ICONS = 200;
const SETS = 100;
const VARIANTS = 6;
const CARDS = 200;

/** Ascending fractional positions for up to 90² children. */
const pos = (i: number) => String.fromCharCode(33 + Math.floor(i / 90)) + String.fromCharCode(33 + (i % 90));
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r: number) => [{ type: "SOLID" as const, color: { r, g: 0.5, b: 1 - r, a: 1 }, opacity: 1, visible: true }];
const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const n = (x: Record<string, unknown>) => ({ phase: "CREATED", ...x }) as NodeChange;

/** 200 icons, 100 sets × 6 variants (each nesting an icon), 200 cards (each nesting a variant): 1,000 components. */
function kit(): Message {
  const out: NodeChange[] = [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    n({ guid: "0:1", type: "CANVAS", name: "Components", parentIndex: { guid: "0:0", position: "!" } }),
    n({ guid: "0:2", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false }),
  ];
  let top = 0;
  const icon = (i: number) => 10_000 + i * 2;
  for (let i = 0; i < ICONS; i++) {
    out.push(n({ guid: `1:${icon(i)}`, type: "SYMBOL", name: `Icons/Icon ${i}`, parentIndex: { guid: "0:1", position: pos(top++) }, size: { x: 24, y: 24 }, transform: at((i % 40) * 32, Math.floor(i / 40) * 32) }));
    out.push(n({ guid: `1:${icon(i) + 1}`, type: "ROUNDED_RECTANGLE", name: "Shape", parentIndex: { guid: `1:${icon(i)}`, position: "!" }, size: { x: 20, y: 20 }, transform: at(2, 2), fillPaints: fill(i / ICONS), cornerRadius: 4 }));
  }
  const variant = (s: number, v: number) => 20_000 + (s * VARIANTS + v) * 4;
  for (let s = 0; s < SETS; s++) {
    const set = 60_000 + s;
    const defId = g(1, 0x7fff0000 + s);
    out.push(
      n({
        guid: `1:${set}`,
        type: "FRAME",
        name: `Button ${s}`,
        isStateGroup: true,
        parentIndex: { guid: "0:1", position: pos(top++) },
        size: { x: 400, y: 60 },
        transform: at((s % 10) * 420, 400 + Math.floor(s / 10) * 80),
        componentPropDefs: [{ id: defId, name: "State", type: "VARIANT", initialValue: { textValue: { characters: "S0" } } }],
      })
    );
    for (let v = 0; v < VARIANTS; v++) {
      const id = variant(s, v);
      out.push(n({ guid: `1:${id}`, type: "SYMBOL", name: `State=S${v}`, parentIndex: { guid: `1:${set}`, position: pos(v) }, size: { x: 60, y: 40 }, transform: at(v * 64, 10), fillPaints: fill(v / VARIANTS), variantPropSpecs: [{ propDefId: defId, value: `S${v}` }] }));
      out.push(n({ guid: `1:${id + 1}`, type: "INSTANCE", name: "Icon", parentIndex: { guid: `1:${id}`, position: "!" }, size: { x: 24, y: 24 }, transform: at(8, 8), symbolData: { symbolID: g(1, icon((s * VARIANTS + v) % ICONS)), symbolOverrides: [] } }));
      out.push(n({ guid: `1:${id + 2}`, type: "ROUNDED_RECTANGLE", name: "Label", parentIndex: { guid: `1:${id}`, position: '"' }, size: { x: 20, y: 8 }, transform: at(36, 16), fillPaints: fill(0.2) }));
    }
  }
  for (let c = 0; c < CARDS; c++) {
    const id = 70_000 + c * 3;
    out.push(n({ guid: `1:${id}`, type: "SYMBOL", name: `Cards/Card ${c}`, parentIndex: { guid: "0:1", position: pos(top++) }, size: { x: 120, y: 80 }, transform: at((c % 20) * 130, 1400 + Math.floor(c / 20) * 90), fillPaints: fill(c / CARDS) }));
    out.push(n({ guid: `1:${id + 1}`, type: "INSTANCE", name: "Button", parentIndex: { guid: `1:${id}`, position: "!" }, size: { x: 60, y: 40 }, transform: at(10, 10), symbolData: { symbolID: g(1, variant(c % SETS, c % VARIANTS)), symbolOverrides: [] } }));
  }
  return { type: "NODE_CHANGES", sessionID: 0, nodeChanges: out };
}

async function open() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const team = await api.workspace.createFolder({ name: "Team", parentId: null });
  const { fileKey } = await store.addFile({ name: "Kit", folderId: team.id, snapshot: encodeMessage(messageToKiwi(kit())) });
  const source = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
  const engine = await Engine.create(null, { sessionID: source.sessionID });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
  await ed.libraries.refresh();
  return { ed, engine };
}

/** The longest stretch the event loop went unanswered while `work` ran (a task queued behind it, timed). */
async function longestBlock<T>(work: () => Promise<T>): Promise<{ result: T; longest: number; ms: number }> {
  let running = true;
  let longest = 0;
  const watch = (async () => {
    while (running) {
      const t = performance.now();
      await yieldToEventLoop();
      longest = Math.max(longest, performance.now() - t);
    }
  })();
  const t0 = performance.now();
  const result = await work();
  const ms = performance.now() - t0;
  running = false;
  await watch;
  return { result, longest, ms };
}

describe("publishing a big library (1,000 components)", () => {
  it("drafts and publishes within bounds, answering the event loop throughout, payloads as one engine call gives", async () => {
    const { ed, engine } = await open();
    const draft = await longestBlock(() => draftPublish(ed));
    const d = draft.result;
    const top = ICONS + SETS + CARDS;
    expect(d.items.filter((i) => i.status === "created")).toHaveLength(top);
    expect(top).toBeGreaterThan(ENCODE_CHUNK); // the encode ran in more than one chunk
    // Measured: ~1.2 s and ~120 ms slices here (before: one 3 s+ block). Bounds leave room for a slow machine.
    expect(draft.ms).toBeLessThan(15_000);
    expect(draft.longest).toBeLessThan(2_500);

    // The chunks' payloads are what one call over every key gives: the asked assets in order, each dependency once.
    const one = engine.encodeAssetsKiwi(d.items.filter((i) => !i.dependencyOnly).map((i) => i.key)).assets;
    const shape = (list: readonly { key: string; versionHash: string; dependencyOnly: boolean; dependencies: readonly string[] }[]) =>
      list.map((a) => `${a.key}|${a.versionHash}|${a.dependencyOnly}|${[...a.dependencies].join(",")}`);
    expect(shape(d.items).filter((s) => s.split("|")[2] === "false")).toEqual(shape(one).filter((s) => s.split("|")[2] === "false"));
    expect(new Set(shape(d.items))).toEqual(new Set(shape(one)));
    expect(d.items.map((i) => i.payloadBytes?.length ?? 0)).toEqual(
      d.items.map((i) => one.find((a) => a.key === i.key)?.bytes.length ?? -1)
    );

    // The plan over every asset: linear, not quadratic.
    const selected = new Set(d.items.map((i) => i.key));
    const t = performance.now();
    const plan = publishPlan(d, selected);
    expect(performance.now() - t).toBeLessThan(500);
    expect(plan.chosen.size).toBe(top);
    // An icon nested in a variant is used by that variant's set (its name, once).
    const icon0 = d.items.find((i) => i.asset.name === "Icons/Icon 0")!;
    const users = plan.usedBy.get(icon0.key) ?? [];
    expect(users).toContain("Button 0");
    expect(new Set(users).size).toBe(users.length);

    const progress: number[] = [];
    const pub = await longestBlock(() => publishLibrary(ed, d, { description: "", selected, moveModes: new Map() }, (done) => progress.push(done)));
    expect(pub.result.assets.filter((a) => !a.dependencyOnly)).toHaveLength(top);
    expect(pub.result.recorded).toBe(true);
    expect(progress.at(-1)).toBe(d.items.length);
    expect(pub.ms).toBeLessThan(20_000);
    expect(pub.longest).toBeLessThan(5_000);

    // Recorded: nothing left to publish, and a second marking writes nothing.
    const again = await draftPublish(ed);
    expect(again.items.filter((i) => i.status === "created" || i.status === "modified")).toEqual([]);
  }, 120_000);
});
