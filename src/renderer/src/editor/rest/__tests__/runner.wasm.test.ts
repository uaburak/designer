// The REST clients end to end (docs/multiplayer.md §16.6, §16.16): the real Worker handler and rooms (server
// restWorld: node:sqlite, RoomBox + Room + RestJobs), the store's MultiplayerService on an in-process WebSocket
// (server/src/testing/restClients.ts), and the editor's job runner on the committed wasm engine. A token's
// `GET /v1/files/:key` reaches the room, the room's `rest-job` reaches the runner through the store, the parts go up,
// and the caller gets Figma's JSON; images, local variables, a POST seen by the next read, versions, the thumbnail,
// the helper asked last, `rest-wanted` said for the local copy, and no renderer after the runner stops.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeMessage } from "../../../../../shared/schema/codec";
import type { MultiplayerEvent } from "../../../../../shared/multiplayer/types";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { messageToKiwi } from "@/store/engineMessage";
import { TYPES_DOCUMENT, VARIABLES_DOCUMENT } from "../../fixtures";
import { runRestJob, startRestRunner, type RestRunnerStore } from "../runner";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// The bench imports the server's code: loaded at run time, so this (web) project doesn't typecheck it.
const BENCH = "../../../../../../server/src/testing/restClients";

/** What the bench gives (server/src/testing/restClients.ts `RestClientBench`) */
interface Bench {
  w: Any;
  svc: { restWanted(key: string): Promise<void> };
  api: RestRunnerStore;
  host: { journal(fileKey: string, message: Uint8Array): void };
  fileKey: string;
  key: string;
  timing: { clientMs: number; waitMs: number };
  until(cond: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  close(): void;
}

let restClientBench: (snapshot: Uint8Array) => Promise<Bench>;
let THUMBNAIL: Uint8Array;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync("src/renderer/src/engine/wasm/engine.wasm");
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  const mod = (await import(/* @vite-ignore */ BENCH)) as { restClientBench: typeof restClientBench; THUMBNAIL: Uint8Array };
  restClientBench = mod.restClientBench;
  THUMBNAIL = mod.THUMBNAIL;
});

let b: Bench;
let engine: Engine;
let stopRunner: (() => void) | null = null;
let jobs: string[];
const renderers = () => b.w.mem.get(b.key).room.renderers().length as number;

beforeEach(async () => {
  b = await restClientBench(encodeMessage(messageToKiwi(VARIABLES_DOCUMENT)));
  engine = await Engine.create(null, { sessionID: 1 });
  engine.load(VARIABLES_DOCUMENT);
  // the editor's changes go to the store's journal (the source's onChanges)
  engine.onDocumentChanged((_c, e) => b.host.journal(b.fileKey, encodeMessage(messageToKiwi(e.message))));
  jobs = [];
});

afterEach(() => {
  stopRunner?.();
  stopRunner = null;
  b.close();
  engine.destroy();
});

function runner(opts: { helper?: boolean } = {}) {
  stopRunner = startRestRunner({ engine, fileKey: b.fileKey, images: null, flush: async () => {} }, b.api, { ...opts, onJob: (r) => jobs.push(r.job.kind) });
}

describe("REST jobs through the store and the editor's runner", () => {
  it("GET /v1/files/:key: Figma's JSON from the engine, with the Worker's per-caller fields first; nodes; the thumbnail", async () => {
    runner();
    await b.until(() => renderers() === 1);
    const pat = await b.w.pat("alice", ["file_content:read"]);
    const r = await b.w.rest("GET", `/v1/files/${b.key}`, pat);
    expect(r.status).toBe(200);
    expect(jobs).toEqual(["file"]);
    expect(Object.keys(r.body).slice(0, 2)).toEqual(["role", "thumbnailUrl"]);
    expect(r.body).toMatchObject({ role: "owner", name: "Tokens", editorType: "figma", version: "0", schemaVersion: 0 });
    expect(r.body.document.children[0].children.map((c: Any) => c.name)).toEqual(["Card", "Card (Dark)"]);
    expect(r.body.styles["6:2"]).toMatchObject({ name: "Heading/H2", styleType: "TEXT" });
    // the thumbnail went up with the share: thumbnailUrl serves it
    const t = new URL(r.body.thumbnailUrl);
    const thumb = await b.w.call("GET", t.pathname + t.search);
    expect([thumb.status, thumb.bytes.length]).toEqual([200, THUMBNAIL.length]);
    const n = await b.w.rest("GET", `/v1/files/${b.key}/nodes?ids=2:2,9:9`, pat);
    expect(n.body.nodes["9:9"]).toBeNull();
    expect(n.body.nodes["2:2"].document).toMatchObject({ id: "2:2", type: "TEXT" });
  });

  it("images: one signed URL per id that draws; local variables", async () => {
    runner();
    await b.until(() => renderers() === 1);
    const pat = await b.w.pat("alice", ["file_content:read", "file_variables:read"]);
    const r = await b.w.rest("GET", `/v1/images/${b.key}?ids=2:1,9:9&format=svg`, pat);
    expect(r.status).toBe(200);
    expect(r.body.images["9:9"]).toBeNull();
    const u = new URL(r.body.images["2:1"]);
    const svg = await b.w.call("GET", u.pathname + u.search);
    expect(new TextDecoder().decode(svg.bytes)).toMatch(/^<svg/);
    const v = await b.w.rest("GET", `/v1/files/${b.key}/variables/local`, pat);
    expect(v.status).toBe(200);
    expect(v.body.meta.variableCollections["VariableCollectionId:7:2"].name).toBe("Theme");
  });

  it("POST variables: one write whose frame reaches the room before the answer, so the next read sees it", async () => {
    runner();
    await b.until(() => renderers() === 1);
    const pat = await b.w.pat("alice", ["file_variables:read", "file_variables:write"]);
    const seq = () => b.w.mem.get(b.key).box.storage.lastSeq() as number;
    const before = seq();
    const post = await b.w.rest("POST", `/v1/files/${b.key}/variables`, pat, {
      variableCollections: [{ action: "CREATE", id: "c", name: "Spacing", initialModeId: "m" }],
      variables: [{ action: "CREATE", id: "v", name: "gap", variableCollectionId: "c", resolvedType: "FLOAT" }],
      variableModeValues: [{ variableId: "v", modeId: "m", value: 12 }],
    });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ status: 200, error: false });
    const map = post.body.meta.tempIdToRealId;
    expect(Object.keys(map).sort()).toEqual(["c", "m", "v"]);
    expect(seq()).toBe(before + 1);
    const v = await b.w.rest("GET", `/v1/files/${b.key}/variables/local`, pat);
    expect(v.body.meta.variables[map.v]).toMatchObject({ name: "gap", valuesByMode: { [map.m]: 12 } });
    // a refused body: the client's check answers 400 with its message, nothing written
    const bad = await b.w.rest("POST", `/v1/files/${b.key}/variables`, pat, { variables: [{ action: "DELETE", id: "VariableID:77:77" }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ status: 400, error: true, message: "Variable VariableID:77:77 not found" });
    expect(seq()).toBe(before + 1);
  });

  it("the hidden helper says so in its hello and is asked after an editor; rest-wanted is said for the local copy", async () => {
    runner({ helper: true });
    await b.until(() => renderers() === 1);
    const log: string[] = [];
    b.w.renderer(b.key, "alice", "owner", { log, answer: () => null }); // an editor that never answers
    b.timing.clientMs = 300;
    const pat = await b.w.pat("alice", ["file_content:read"]);
    const r = await b.w.rest("GET", `/v1/files/${b.key}?depth=1`, pat);
    expect(r.status).toBe(200);
    expect(log).toEqual(["alice:file"]);
    expect(jobs).toEqual(["file"]);
    expect(r.body.document.children[0].children).toBeUndefined();
    // the inbox's rest-wanted, for the room key: the store's event names the local copy
    const heard: MultiplayerEvent[] = [];
    const off = b.api.watch((e) => void (e.restWanted && heard.push(e)));
    await b.svc.restWanted(b.key);
    await new Promise((r) => setTimeout(r, 30));
    off();
    expect(heard.map((e) => [e.fileKey, e.state.role])).toEqual([[b.fileKey, "owner"]]);
  });

  it("stopping the runner says hello again without render: the room has no renderer and answers 503", async () => {
    runner();
    await b.until(() => renderers() === 1);
    stopRunner!();
    stopRunner = null;
    await b.until(() => renderers() === 0);
    b.timing.waitMs = 200;
    const pat = await b.w.pat("alice", ["file_content:read"]);
    const r = await b.w.rest("GET", `/v1/images/${b.key}?ids=2:1`, pat);
    expect(r.status).toBe(503);
  });

  it("a version the room doesn't have is the room's 404; a job's version is read in a scratch engine", async () => {
    runner();
    await b.until(() => renderers() === 1);
    const pat = await b.w.pat("alice", ["file_content:read"]);
    expect((await b.w.rest("GET", `/v1/files/${b.key}?version=AAAAAAAAAAAAAAAA`, pat)).status).toBe(404);
    expect(jobs).toEqual([]);
    const host = { engine, fileKey: b.fileKey, images: null, flush: async () => {} };
    const job = { kind: "file" as const, params: { depth: 2 }, version: "v1" };
    const ok = await runRestJob({ ...host, openVersion: async () => TYPES_DOCUMENT }, { job, seq: 3, name: "Tokens", lastModified: 0 });
    expect("parts" in ok).toBe(true);
    const doc = JSON.parse(`{${gunzipSync((ok as { parts: { bytes: Uint8Array }[] }).parts[0].bytes).toString()}`);
    expect(doc.version).toBe("v1");
    expect(doc.document.children[0].children.map((c: Any) => c.name)).toContain("Auto layout");
    expect(await runRestJob({ ...host, openVersion: async () => Promise.reject(new Error("gone")) }, { job, seq: 3, name: "Tokens", lastModified: 0 })).toEqual({ err: "404 Version not found" });
    expect(await runRestJob(host, { job, seq: 3, name: "Tokens", lastModified: 0 })).toEqual({ err: "400 This version can't be read here" });
  });
});
