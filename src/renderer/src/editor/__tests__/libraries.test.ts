// Libraries, pure (model/libraries.ts, the registry's rules in shared/store/libraryRules.ts): payloads as the engine's
// encodeAssets writes them (an asset and what it needs in one Message, each root with its key and version) read into
// asset roots, and copies under the internal canvas with Figma's library fields — imported (references remapped to
// the copies), reused, updated in place; what a consumer's copies are missing, one row per asset however many copies.
import { describe, expect, it } from "vitest";
import type { Message, NodeChange } from "@/engine/codec";
import { diffAgainst, movesOf } from "../../../../shared/store/libraryRules";
import type { LibraryAsset, LibraryVersion, Redirect } from "../../../../shared/store/types";
import { copiesHave, indexDocument, libraryCopies, payloadRoot, payloadRoots, planImport, type LibraryCopy, type LNode, type PayloadIn } from "../model/libraries";

const K = (c: string) => c.repeat(40);
const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const solid = (r: number) => [{ type: "SOLID", color: { r, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const node = (guid: string, parent: string | null, fields: Record<string, unknown>, position = "a"): NodeChange => ({ guid, phase: "CREATED", ...(parent ? { parentIndex: { guid: parent, position } } : {}), ...fields }) as unknown as NodeChange;
const message = (nodes: NodeChange[]): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: nodes });

/** The library's Button (nesting a Star instance, with a Label) and Star, as payload nodes (library GUIDs). */
const button = (version: string, opts: { red?: boolean; label?: boolean } = {}) => [
  node("1:2", "1:1", { type: "SYMBOL", name: "Button", key: K("a"), version, fillPaints: solid(opts.red ? 1 : 0) }),
  node("1:3", "1:2", { type: "INSTANCE", name: "Star", symbolData: { symbolID: g(1, 4) } }, "a"),
  ...(opts.label === false ? [] : [node("1:5", "1:2", { type: "TEXT", name: "Label" }, "b")]),
];
const star = (version: string) => [node("1:4", "1:1", { type: "SYMBOL", name: "Icons/Star", key: K("b"), version }, "b")];
const payload = (key: string, versionHash: string, nodes: NodeChange[]): PayloadIn => ({ key, versionHash, message: message(nodes) });

/** A consumer: a page and an empty internal canvas. */
function consumer() {
  return indexDocument(message([node("0:0", null, { type: "DOCUMENT" }), node("0:1", "0:0", { type: "CANVAS", name: "Page" }, "a"), node("0:2", "0:0", { type: "CANVAS", internalOnly: true }, "b")]));
}

/** Applies a plan's changes to a consumer index (CREATED / updated / REMOVED), returning the next index. */
function apply(doc: ReturnType<typeof consumer>, changes: NodeChange[]) {
  const byId = new Map([...doc.byId].map(([k, v]) => [k, { ...v }]));
  for (const c of changes) {
    if (c.phase === "REMOVED") byId.delete(c.guid);
    else {
      const next = { ...(byId.get(c.guid) ?? {}), ...c } as Record<string, unknown>;
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      delete next.phase;
      byId.set(c.guid, next as unknown as LNode);
    }
  }
  return indexDocument(message([...byId.values()]));
}

let n = 0;
const fresh = () => `5:${++n}`;
const pos = (i: number) => `p${i}`;

describe("payloads", () => {
  it("one Message per asset, or the engine's closure: each root with its key and version, shared nodes once", () => {
    const closure = payload(K("a"), K("1"), [...button(K("1")), ...star(K("2"))]);
    const r = payloadRoots([closure, payload(K("b"), K("2"), star(K("2")))]);
    expect(r.roots.map((x) => [x.node.name, x.key, x.version])).toEqual([
      ["Button", K("a"), K("1")],
      ["Icons/Star", K("b"), K("2")],
    ]);
    expect(r.nodes.size).toBe(4);
    expect(payloadRoot(closure.message, K("b"))?.name).toBe("Icons/Star");
  });
});

describe("copies", () => {
  it("imports read-only copies under the internal canvas, references remapped to the copies", () => {
    n = 0;
    const plan = planImport(consumer(), "lib", [payload(K("a"), K("1"), [...button(K("1")), ...star(K("2"))])], "0:2", fresh, pos);
    const doc = apply(consumer(), plan.changes);
    expect(libraryCopies(doc).map((c) => [c.name, c.key, c.version, c.publishID])).toEqual([
      ["Button", K("a"), K("1"), "1:2"],
      ["Icons/Star", K("b"), K("2"), "1:4"],
    ]);
    const root = plan.roots.get(K("a"))!;
    const nested = doc.children.get(root)!.map((id) => doc.byId.get(id)!).find((x) => x.type === "INSTANCE") as unknown as { symbolData: { symbolID: unknown } };
    expect(nested.symbolData.symbolID).toEqual(g(5, Number(plan.roots.get(K("b"))!.split(":")[1])));
    expect(doc.byId.get(root)!.overrideKey).toEqual(g(1, 2)); // every node keyed by the library node
  });

  it("an import reuses a copy already here; an update rewrites it in place (same GUIDs, dropped nodes removed)", () => {
    n = 0;
    const first = planImport(consumer(), "lib", [payload(K("a"), K("1"), [...button(K("1")), ...star(K("2"))])], "0:2", fresh, pos);
    let doc = apply(consumer(), first.changes);
    const label = doc.children.get(first.roots.get(K("a"))!)!.find((id) => doc.byId.get(id)!.name === "Label")!;
    const v2 = [payload(K("a"), K("3"), [...button(K("3"), { red: true, label: false }), ...star(K("2"))])];
    expect(planImport(doc, "lib", v2, "0:2", fresh, pos).changes).toEqual([]); // an import never updates
    const upd = planImport(doc, "lib", v2, "0:2", fresh, pos, { update: true, keys: [K("a")] });
    expect(upd.roots.get(K("a"))).toBe(first.roots.get(K("a")));
    expect(upd.changes.find((c) => c.guid === label)?.phase).toBe("REMOVED");
    expect(upd.changes.some((c) => c.guid === first.roots.get(K("b")))).toBe(false); // not in `keys`
    doc = apply(doc, upd.changes);
    const copy = libraryCopies(doc).find((c) => c.key === K("a"))!;
    expect(copy.version).toBe(K("3"));
    expect((doc.byId.get(copy.guid)!.fillPaints as { color: { r: number } }[])[0].color.r).toBe(1);
  });
});

describe("updates (review findings 9, 10, 14)", () => {
  const copy = (guid: string, key: string, version: string): LibraryCopy => ({ guid, library: "lib", key, version, publishID: "1:4", kind: "COMPONENT", name: "Icons/Star" });
  const asset = (key: string, versionHash: string): LibraryAsset => ({ key, kind: "COMPONENT", name: "Icons/Star", description: "", guid: "1:4", versionHash, dependencyOnly: false, dependencies: [], thumbnail: null });
  const version = (assets: LibraryAsset[]): LibraryVersion => ({ libraryFileKey: "lib", version: 3, publishedAt: 0, description: "", changes: { created: [], modified: [], removed: [], moved: [] }, assets });

  it("two copies of one asset (Update selected instance): `have` lists each version once, the diff the asset once", () => {
    const copies = [copy("5:1", K("b"), K("1")), copy("5:9", K("b"), K("2")), copy("5:10", K("b"), K("2"))];
    expect(copiesHave(copies, "lib")).toEqual([
      { key: K("b"), versionHash: K("1") },
      { key: K("b"), versionHash: K("2") },
    ]);
    const d = diffAgainst(version([asset(K("b"), K("3"))]), 3, copiesHave(copies, "lib"), []);
    expect(d.updated.map((a) => a.key)).toEqual([K("b")]);
    // A copy at the latest version and one behind: still one update (the one behind needs it).
    expect(diffAgainst(version([asset(K("b"), K("2"))]), 3, copiesHave(copies, "lib"), []).updated).toHaveLength(1);
    expect(diffAgainst(version([asset(K("b"), K("2"))]), 3, [{ key: K("b"), versionHash: K("2") }], []).updated).toHaveLength(0);
  });

  it("a recorded move is seen before the old library publishes again (data.md §9.5 step 2); a move is recorded once", () => {
    const r: Redirect = { fromLibraryFileKey: "lib", fromKey: K("b"), toLibraryFileKey: "next", toKey: K("c"), version: 1, at: 0 };
    const d = diffAgainst(version([asset(K("b"), K("1"))]), 1, [{ key: K("b"), versionHash: K("1") }], [r]);
    expect(d.moved).toEqual([r]);
    expect(d.updated).toEqual([]);
    const moves = [{ key: K("c"), fromLibraryFileKey: "lib", fromKey: K("b"), mode: "move" as const }];
    expect(movesOf(moves, "next", 2, 0, [r])).toEqual([]);
    expect(movesOf(moves, "next", 2, 0, [])).toHaveLength(1);
  });
});
