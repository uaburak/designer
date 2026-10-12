import { app, net, protocol, webContents } from "electron";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AiModelState } from "../../shared/ai/types";
import { ModelStore } from "./models";

/**
 * The `aimodel:` scheme (docs/ai.md §2.4): `aimodel://<id>/<path>` serves a downloaded local model's pinned files,
 * read-only, to the editor's model worker (onnxruntime-web / transformers.js fetch them). Only files the catalogue
 * names, of a model that finished downloading; GET and HEAD. The editor is cross-origin isolated (COEP require-corp),
 * so every answer carries CORS and CORP cross-origin. The app's CSP has `connect-src aimodel:`.
 */

export const AIMODEL_SCHEME = "aimodel";

/** Registered with the app's scheme, before `ready` (src/main/protocol.ts registerScheme: one call registers all). */
export const AIMODEL_SCHEME_PRIVILEGES = { scheme: AIMODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };

const COMMON = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" };

export interface ModelResponse {
  status: number;
  headers: Record<string, string>;
  /** The file to send (GET), absent for errors and HEAD */
  path?: string;
}

const TYPES: Record<string, string> = { json: "application/json", onnx: "application/octet-stream", txt: "text/plain; charset=utf-8" };

/** The answer to an `aimodel:` request (pure, for the tests and the handler). */
export function modelResponse(url: string, method: string, store: Pick<ModelStore, "filePath">): ModelResponse {
  const notFound: ModelResponse = { status: 404, headers: { ...COMMON, "Content-Type": "text/plain; charset=utf-8" } };
  if (method === "OPTIONS") return { status: 204, headers: { ...COMMON, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "*" } };
  if (method !== "GET" && method !== "HEAD") return { ...notFound, status: 405 };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return notFound;
  }
  if (u.protocol !== `${AIMODEL_SCHEME}:`) return notFound;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  } catch {
    return notFound;
  }
  const path = store.filePath(u.hostname, rel);
  if (!path) return notFound;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return notFound;
  }
  const ext = rel.split(".").pop() ?? "";
  return {
    status: 200,
    headers: { ...COMMON, "Content-Type": TYPES[ext] ?? "application/octet-stream", "Content-Length": String(size), "Cache-Control": "no-cache" },
    ...(method === "GET" ? { path } : {}),
  };
}

let store: ModelStore | null = null;

/** The app's models (userData/models); every state change goes to every view (`ai:model-state`). */
export function modelStore(): ModelStore {
  store ??= new ModelStore({
    dir: join(app.getPath("userData"), "models"),
    onState: (s: AiModelState) => {
      for (const c of webContents.getAllWebContents()) if (!c.isDestroyed()) c.send("ai:model-state", s);
    },
  });
  return store;
}

/** After `ready`. */
export function handleAimodelScheme() {
  protocol.handle(AIMODEL_SCHEME, async (request) => {
    const r = modelResponse(request.url, request.method, modelStore());
    if (!r.path) return new Response(null, { status: r.status, headers: r.headers });
    const file = await net.fetch(pathToFileURL(r.path).toString());
    return new Response(file.body, { status: 200, headers: r.headers });
  });
}
