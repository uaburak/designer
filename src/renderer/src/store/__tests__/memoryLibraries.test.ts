// The dev store's library registry (memoryLibraries.ts) against the same expectations as the store's own
// (src/store/local/libraries.test.ts): both run src/shared/store/libraryRules.ts over their own storage.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type NodeChange } from "../../../../shared/schema/codec";
import type { LibraryEvent } from "../../../../shared/store/repositories";
import type { PublishAsset } from "../../../../shared/store/types";
import { KV_PREFIX, memoryStorage } from "../memory/kv";
import { MemoryStore } from "../memory/memoryStore";

const hex = (s: string) => createHash("sha1").update(s).digest("hex");
const PNG = new Uint8Array(readFileSync(join(__dirname, "../../../../../build/icon.png")));

async function memoryApi() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  return store.api({});
}

function payload(name: string, extra: Partial<NodeChange> = {}): Uint8Array {
  return encodeMessage({
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [{ guid: { sessionID: 1048577, localID: 1 }, phase: "CREATED", type: "SYMBOL", name, parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" }, ...extra }],
    blobs: [],
  });
}

function asset(key: string, name: string, version: string, extra: Partial<PublishAsset> = {}): PublishAsset {
  return { key: hex(key), kind: "COMPONENT", name, description: "", guid: "1048577:1", versionHash: hex(version), dependencyOnly: false, dependencies: [], payload: payload(name), ...extra };
}

describe("the dev store's libraries (docs/data.md §9)", () => {
  it("publishes versions, lists created/modified/removed, serves payloads and finds updates", async () => {
    const api = await memoryApi();
    const { workspace, libraries } = api;
    const events: LibraryEvent[] = [];
    libraries.watch((e) => events.push(e));
    const lib = await workspace.createFile({ name: "Design System", folderId: null });
    const button = asset("button", "Button", "button@1", { dependencies: [hex("icon")] });
    const icon = asset("icon", "Icon", "icon@1", { dependencyOnly: true, kind: "COMPONENT" });
    const color = asset("color", "Brand/Primary", "color@1", { kind: "STYLE", styleType: "FILL", thumbnailPng: PNG });
    await expect(libraries.publish({ libraryFileKey: lib.fileKey, description: "", assets: [button], moves: [] })).rejects.toMatchObject({ code: "draft-cannot-publish" });
    const folder = await workspace.createFolder({ name: "Team", parentId: null });
    await workspace.moveFiles([lib.fileKey], folder.id);
    await expect(libraries.publish({ libraryFileKey: lib.fileKey, description: "", assets: [button, button], moves: [] })).rejects.toMatchObject({ code: "invalid" });

    const preview = await libraries.previewPublish(lib.fileKey, [button, icon, color]);
    expect(preview.created.map((a) => a.name)).toEqual(["Button", "Brand/Primary"]); // dependency-only assets are never listed
    const v1 = await libraries.publish({ libraryFileKey: lib.fileKey, description: "First release", assets: [button, icon, color], moves: [] });
    expect(v1.version).toBe(1);
    expect(v1.changes.created).toEqual([button.key, color.key]);
    expect(v1.assets.find((a) => a.key === color.key)!.thumbnail).toMatchObject({ width: 1024, height: 1024 });
    const rec = await libraries.getRecord(lib.fileKey);
    expect(rec).toMatchObject({ status: "published", latestVersion: 1, counts: { components: 1, styles: 1, variables: 0 } });
    expect((await workspace.getFile(lib.fileKey)).library).toEqual({ status: "published", latestVersion: 1 });
    expect((await api.files.listVersions(lib.fileKey))[0]).toMatchObject({ kind: "publish", description: "First release", libraryVersion: 1 });
    expect(events).toEqual([{ type: "published", libraryFileKey: lib.fileKey, version: 1 }]);

    // A consumer enables it and fetches the button with its dependency.
    const consumer = await workspace.createFile({ name: "App", folderId: null });
    expect((await libraries.listAvailable(consumer.fileKey)).map((r) => r.libraryFileKey)).toEqual([lib.fileKey]);
    expect(await libraries.listAvailable(lib.fileKey)).toEqual([]);
    expect((await libraries.setEnabled(consumer.fileKey, lib.fileKey, true)).enabledLibraries).toEqual([lib.fileKey]);
    const payloads = await libraries.getPayloads(lib.fileKey, [{ key: button.key, versionHash: button.versionHash }], { withDependencies: true });
    expect(payloads.map((p) => p.key)).toEqual([button.key, icon.key]);
    expect(decodeMessage(payloads[0].message).nodeChanges![0].name).toBe("Button");

    // v2: the button changes, the colour style is removed (deselecting keeps old hashes: here the icon is kept as is).
    const button2 = asset("button", "Button", "button@2", { dependencies: [hex("icon")] });
    const icon1 = { ...icon, payload: undefined }; // already stored: no payload needed
    const p2 = await libraries.previewPublish(lib.fileKey, [button2, icon1]);
    expect(p2.modified.map((a) => a.key)).toEqual([button.key]);
    expect(p2.removed.map((a) => a.key)).toEqual([color.key]);
    await libraries.publish({ libraryFileKey: lib.fileKey, description: "Rounder button", assets: [button2, icon1], moves: [] });
    const diff = await libraries.diff(lib.fileKey, [
      { key: button.key, versionHash: button.versionHash },
      { key: color.key, versionHash: color.versionHash },
      { key: icon.key, versionHash: icon.versionHash },
    ]);
    expect(diff.latestVersion).toBe(2);
    expect(diff.updated.map((a) => a.versionHash)).toEqual([button2.versionHash]);
    expect(diff.removed).toEqual([color.key]);
    expect((await libraries.getVersion(lib.fileKey, 1)).assets).toHaveLength(3);
    await expect(libraries.publish({ libraryFileKey: lib.fileKey, description: "", assets: [asset("new", "New", "new@1", { payload: undefined })], moves: [] })).rejects.toMatchObject({ code: "invalid" });
  });

  it("records 'Move to this file' redirects; 'Publish as a copy' does not", async () => {
    const api = await memoryApi();
    const { workspace, libraries } = api;
    const folder = await workspace.createFolder({ name: "Team", parentId: null });
    const a = await workspace.createFile({ name: "Old library", folderId: folder.id });
    const b = await workspace.createFile({ name: "New library", folderId: folder.id });
    const card = asset("card", "Card", "card@1");
    await libraries.publish({ libraryFileKey: a.fileKey, description: "", assets: [card], moves: [] });
    // The card is cut from A and pasted into B (new key), then B publishes with "Move to this file".
    const moved = asset("card-in-b", "Card", "card-in-b@1");
    const copy = asset("copy-in-b", "Card copy", "copy-in-b@1");
    await libraries.publish({
      libraryFileKey: b.fileKey,
      description: "",
      assets: [moved, copy],
      moves: [
        { key: moved.key, fromLibraryFileKey: a.fileKey, fromKey: card.key, mode: "move" },
        { key: copy.key, fromLibraryFileKey: a.fileKey, fromKey: hex("other"), mode: "copy" },
      ],
    });
    expect((await libraries.getRecord(b.fileKey))!.movedIn).toEqual([expect.objectContaining({ fromLibraryFileKey: a.fileKey, fromKey: card.key, toLibraryFileKey: b.fileKey, toKey: moved.key, version: 1 })]);
    // Consumers of A see the card as moved, not removed — even before A publishes again.
    const d = await libraries.diff(a.fileKey, [{ key: card.key, versionHash: card.versionHash }]);
    expect(d.updated).toEqual([]);
    expect(d.removed).toEqual([]);
    // When A publishes without it, the Publish dialog lists it as moved.
    const p = await libraries.previewPublish(a.fileKey, []);
    expect(p.removed).toEqual([]);
    expect(p.moved.map((m) => m.toKey)).toEqual([moved.key]);
    await libraries.publish({ libraryFileKey: a.fileKey, description: "", assets: [], moves: [] });
    const d2 = await libraries.diff(a.fileKey, [{ key: card.key, versionHash: card.versionHash }]);
    expect(d2.moved.map((m) => m.toLibraryFileKey)).toEqual([b.fileKey]);
    expect(d2.removed).toEqual([]);
  });

  it("is shared through the storage: another page's publish is an event; deleting the file forgets its versions", async () => {
    const storage = memoryStorage();
    const a = await MemoryStore.open({ storage });
    const api = a.api({});
    const folder = await api.workspace.createFolder({ name: "Team", parentId: null });
    const lib = await api.workspace.createFile({ name: "Kit", folderId: folder.id });
    const b = await MemoryStore.open({ storage });
    const events: LibraryEvent[] = [];
    b.api({}).libraries.watch((e) => events.push(e));
    await api.libraries.publish({ libraryFileKey: lib.fileKey, description: "", assets: [asset("btn", "Button", "btn@1")], moves: [] });
    b.libraries.noteExternalWrite(`${KV_PREFIX}lib.${lib.fileKey}`, storage.get(`${KV_PREFIX}lib.${lib.fileKey}`));
    expect(events).toEqual([{ type: "published", libraryFileKey: lib.fileKey, version: 1 }]);
    expect((await b.api({}).libraries.getVersion(lib.fileKey)).assets.map((x) => x.name)).toEqual(["Button"]);
    await api.workspace.trash({ files: [lib.fileKey] });
    expect((await api.libraries.getRecord(lib.fileKey))!.status).toBe("trashed");
    expect(await api.libraries.listAvailable()).toEqual([]);
    await api.workspace.deleteForever({ files: [lib.fileKey] });
    expect(storage.keys(`${KV_PREFIX}libver.`)).toEqual([]);
    expect(storage.keys(`${KV_PREFIX}libasset.`)).toEqual([]);
    a.dispose();
    b.dispose();
  });
});
