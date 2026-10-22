// @vitest-environment happy-dom
/**
 * The publish toast through the upload (as Figma's): "Publishing Kit… n/N" while the assets are drafted, then
 * "Uploading Kit… 42%" as the store's upload of the payloads and thumbnails goes (`LibraryAccess.onUpload`, the
 * `uploads` topic), then "Library published"; the Publish dialog's run says the same share.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { currentToast, dismissToast } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { encodeMessage } from "@shared/schema/codec";
import type { LibraryAccess } from "../documentSource";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorController } from "../controller";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { draftPublish } from "../libraries";
import { publishInBackground, publishRun } from "../libraryPublishJob";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the publish toast through the upload", () => {
  it("says Uploading with the share sent after drafting, until the commit, then Library published", async () => {
    const store = await MemoryStore.open({ storage: memoryStorage() });
    const api = store.api({});
    const team = await api.workspace.createFolder({ name: "Team", parentId: null });
    const fileKey = (await store.addFile({ name: "Kit", folderId: team.id, snapshot: encodeMessage(messageToKiwi(COMPONENTS_DOCUMENT)) })).fileKey;
    const source = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
    const engine = await Engine.create(null, { sessionID: source.sessionID });
    engine.load(await source.load());
    // The store's upload, held: its listener told the bytes as the test says, the commit when the test lets it
    const access = source.libraries!;
    let upload: ((sent: number, total: number) => void) | null = null;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const wrapped: LibraryAccess = Object.assign(Object.create(access) as LibraryAccess, {
      onUpload: (l: (sent: number, total: number) => void) => {
        upload = l;
        return () => (upload = null);
      },
      publish: async (input: Parameters<LibraryAccess["publish"]>[0]) => {
        await held;
        return access.publish(input);
      },
    });
    Object.defineProperty(source, "libraries", { value: wrapped });
    const ed = new EditorController(engine, new EngineStore(engine), source);
    await ed.libraries.refresh();
    const d = await draftPublish(ed);

    const run = publishInBackground(ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() }, { name: "Kit" });
    expect(run.started).toBe(true);
    for (let i = 0; i < 200 && !upload; i++) await tick();
    expect(upload).not.toBeNull();
    // Drafted: the count at its end until the first bytes are said
    expect(currentToast()?.message).toBe(`Publishing Kit… ${d.items.length}/${d.items.length}`);
    upload!(0, 1000);
    expect(currentToast()).toMatchObject({ message: "Uploading Kit… 0%", progress: 0 });
    expect(publishRun(ed)?.uploaded).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    upload!(420, 1000);
    expect(currentToast()).toMatchObject({ message: "Uploading Kit… 42%", progress: 0.42 });
    expect(publishRun(ed)?.uploaded).toBe(0.42);
    upload!(1000, 1000);
    expect(currentToast()?.message).toBe("Uploading Kit… 100%");
    release();
    await run.done;
    expect(upload).toBeNull();
    expect(publishRun(ed)).toBeNull();
    expect(currentToast()?.message).toBe("Library published");
    dismissToast();
  });
});
