/**
 * The editor's REST client (docs/multiplayer.md §16.6): `attachRestRunner(ed)` — EditorApp's one line — makes an editor
 * on the store's file a renderer of its room's REST jobs (`?restHelper` in the URL: main's hidden render helper).
 * Editors of memory documents (no file key) answer nothing.
 */
import { getStoreClient } from "@/store";
import type { EditorController } from "../controller";
import { startRestRunner } from "./runner";

export { runRestJob, startRestRunner, type RestRunnerHost, type RestRunnerStore } from "./runner";

export function attachRestRunner(ed: EditorController): () => void {
  const fileKey = (ed.source as unknown as { fileKey?: unknown }).fileKey;
  if (typeof fileKey !== "string" || !fileKey) return () => {};
  let store;
  try {
    store = getStoreClient().multiplayer;
  } catch {
    return () => {};
  }
  if (!store?.restRender) return () => {};
  const helper = typeof location !== "undefined" && new URLSearchParams(location.search).has("restHelper");
  const images = ed.images.store;
  return startRestRunner(
    {
      engine: ed.engine,
      fileKey,
      images: images ? (hash) => images.get(hash) : null,
      flush: () => ed.source.flush(),
      openVersion: ed.source.openVersion ? (id) => ed.source.openVersion!(id) : undefined,
    },
    store,
    { helper },
  );
}
