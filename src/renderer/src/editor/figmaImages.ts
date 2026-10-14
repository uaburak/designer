/**
 * A paste's images from Figma (docs/desktop.md §13 "Images from Figma"). Figma's clipboard names each image by its
 * hash (imageRef, the SHA-1 of its bytes) and the bytes stay on Figma's servers; with the person's personal access
 * token they come from `GET /v1/files/:key/images` (src/shared/figmaApi.ts; main's on the desktop). Each image goes to
 * the file's image store as it is (same bytes, so the same SHA-1: the pasted paints find it); the engine, which drew
 * placeholders for them, is told they arrived (`ImageService.arrived`) and draws them; their ThumbHash and low-res tier
 * are written back as for any image without them. An image whose bytes hash differently has its paints re-pointed, as
 * the .fig importer does.
 *
 * No token yet: the dialog (FigmaConnectDialog) explains how to make one. A saved one: a toast while they come; Figma
 * refusing it (expired, no access) opens the dialog again with the reason.
 */
import { dismissToast, showToast } from "@/ds";
import { tp } from "@/i18n";
import type { Guid, Message, NodeChange, Paint } from "@/engine/codec";
import { Status } from "@/engine/abi";
import type { FigmaApiError, FigmaImage } from "@shared/figmaApi";
import { figmaClient, type FigmaClient } from "../figma/connection";
import { figmaErrorText, type BringOutcome } from "../figma/FigmaConnectDialog";
import { askForFigmaImages } from "../figma/FigmaImagesHost";
import type { EditorController } from "./controller";
import { engineCall } from "./engineCompat";
import { sniffImageMime, type ImageStore } from "./images";
import { hashHex } from "./model/paints";

/** What ingesting needs of the editor (a fake in tests). */
export interface ImageSink {
  store: ImageStore | null;
  /** The engine draws them now (ImageService.arrived) */
  arrived(hashes: string[]): void;
  /** Paints naming `from` name `to` instead */
  repoint(renames: Map<string, string>): void;
}

/** Images into the file's store, as they are; the hashes they got, and the ones that changed. */
export async function ingestFigmaImages(sink: ImageSink, images: readonly FigmaImage[]): Promise<{ stored: string[]; renames: Map<string, string> }> {
  const stored: string[] = [];
  const renames = new Map<string, string>();
  if (!sink.store) return { stored, renames };
  for (const img of images) {
    const mime = sniffImageMime(img.bytes);
    if (!mime) continue; // not an image we draw (an SVG, an error page)
    try {
      const hash = await sink.store.put(img.bytes, mime);
      stored.push(hash);
      if (hash !== img.hash) renames.set(img.hash, hash);
    } catch {
      /* the store refused it: stays a placeholder */
    }
  }
  if (renames.size) sink.repoint(renames);
  if (stored.length) sink.arrived([...stored, ...renames.keys()]);
  return { stored, renames };
}

/** The hashes of `hashes` this file's store doesn't have. */
export async function missingImages(store: ImageStore | null, hashes: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hashes) if (!store || !(await store.get(h).catch(() => null))) out.push(h);
  return out;
}

/** Fetches and ingests: the outcome the dialog and the toast report. */
export async function bringImages(client: FigmaClient, sink: ImageSink, fileKey: string, hashes: string[], onProgress?: (done: number, total: number) => void): Promise<BringOutcome> {
  const r = await client.images(fileKey, hashes, onProgress);
  if (!r.ok) return r;
  const { stored } = await ingestFigmaImages(sink, r.value.images);
  return { ok: true, brought: stored.length, missing: hashes.length - stored.length };
}

/** Re-points every paint (fills, strokes) naming a renamed image, as a system change (not an undo step). */
function repointPaints(ed: EditorController, renames: Map<string, string>): void {
  const apply = engineCall<(message: Message, kind: string) => number>(ed.engine, "applyChanges", "apply_changes");
  if (!apply || ed.engine.destroyed) return;
  const changes: NodeChange[] = [];
  const swap = (p: Paint): Paint => {
    const raw = p.image?.hash as unknown;
    const to = renames.get(hashHex(raw as never) ?? "");
    if (!to) return p;
    const hash = typeof raw === "string" ? to : (to.match(/../g) ?? []).map((b) => parseInt(b, 16));
    return { ...p, image: { ...p.image, hash } } as Paint;
  };
  for (const n of ed.engine.encodeDocument().nodeChanges) {
    const change: NodeChange = { guid: n.guid as Guid };
    let touched = false;
    for (const key of ["fillPaints", "strokePaints"] as const) {
      const paints = n[key];
      if (!paints?.some((p) => renames.has(hashHex(p.image?.hash as never) ?? ""))) continue;
      change[key] = paints.map(swap);
      touched = true;
    }
    if (touched) changes.push(change);
  }
  if (changes.length && apply({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes } as Message, "system") !== Status.OK) {
    /* busy: the placeholders stay until the next paste */
  }
}

/** The editor as an ImageSink. */
export function editorImageSink(ed: EditorController): ImageSink {
  return {
    store: ed.source.images ?? null,
    arrived: (hashes) => ed.images.arrived(hashes),
    repoint: (renames) => repointPaints(ed, renames),
  };
}

/** The dialog's or the toast's outcome. */
function outcomeToast(outcome: BringOutcome, web: boolean): void {
  if (!outcome.ok) {
    showToast({ kind: "error", message: figmaErrorText(outcome.error, web) });
    return;
  }
  if (outcome.missing) showToast({ message: tp(outcome.missing, "{n} image wasn’t found in the Figma file.", "{n} images weren’t found in the Figma file.") });
  else showToast({ kind: "success", message: tp(outcome.brought, "Brought {n} image from Figma", "Brought {n} images from Figma") });
}

/** Errors that mean "the token can't do this": the dialog again, with why. */
const TOKEN_ERRORS: ReadonlySet<FigmaApiError> = new Set(["no-token", "invalid-token", "expired", "no-access", "not-found"]);

/**
 * After a paste from Figma whose images this file doesn't have: brought with the saved token, else the dialog. The
 * layers are pasted already (with placeholders) — nothing here blocks or undoes the paste.
 */
export async function bringPastedFigmaImages(ed: EditorController, fileKey: string | undefined, hashes: readonly string[], client: FigmaClient = figmaClient()): Promise<void> {
  const sink = editorImageSink(ed);
  const missing = await missingImages(sink.store, hashes);
  if (!missing.length || ed.engine.destroyed) return;
  const web = client.kind === "web";
  if (!fileKey) {
    showToast({ message: tp(missing.length, "An image from Figma couldn’t be pasted. Copy it in Figma as PNG and paste it here.", "{n} images from Figma couldn’t be pasted. Copy them in Figma as PNG and paste them here.") });
    return;
  }
  const pending = { count: missing.length, run: (onProgress: (done: number, total: number) => void) => bringImages(client, sink, fileKey, missing, onProgress) };
  const status = await client.status().catch(() => ({ connected: false, user: null }));
  if (!status.connected) {
    askForFigmaImages(client, pending);
    return;
  }
  const toast = showToast({ message: tp(missing.length, "Bringing {n} image from Figma…", "Bringing {n} images from Figma…"), duration: 60_000 });
  const outcome = await pending.run(() => {});
  dismissToast(toast);
  if (ed.engine.destroyed) return;
  if (!outcome.ok && TOKEN_ERRORS.has(outcome.error)) {
    askForFigmaImages(client, pending, outcome.error);
    return;
  }
  outcomeToast(outcome, web);
}

