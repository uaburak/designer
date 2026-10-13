/**
 * Studio's pictures (docs/studio.md §5.3, §6.2): an image run with references through `ai:image`, Fix label as an edit
 * with references, and Blur on areas of an image layer (local, one undo step). 15c fills it; 15a calls it.
 *
 * A run is the image tools' (`imageRun`: the run's events awaited, `ai:cancel` on abort) and is recorded in the usage
 * ledger like theirs, with the credits main's usage event names. It answers the bytes; filling the frame's "Picture"
 * layer is the caller's (one undo step).
 */
import { AiRunError } from "../../../../shared/ai/api";
import { creditsFor, type AiRoute } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import { editorAi, imageToolsOf } from "../imageTools/controller";
import { blurBoxes, imageRun, imageTargetOf } from "../imageTools/tools";

export interface StudioImageRequest {
  route: AiRoute;
  prompt: string;
  /** In the prompt's order: base64 and the role the prompt gives it */
  references: { data: string; role: string }[];
  aspectRatio: string;
  size: { width: number; height: number };
  /** Fix label: the picture to edit (base64) */
  image?: string;
}

export interface StudioImage {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  credits: number;
}

let seq = 0;

export async function runStudioImage(ed: EditorController, req: StudioImageRequest, signal: AbortSignal): Promise<StudioImage> {
  const api = editorAi();
  if (!api) throw new AiRunError("unsupported", "AI images are made in the desktop app.");
  const action = req.image ? "edit-image" : "make-image";
  const hooks = imageToolsOf(ed).hooks;
  try {
    const { image, usage } = await imageRun(
      api,
      {
        runId: `studio-${action}-${Date.now().toString(36)}-${++seq}`,
        action,
        route: req.route,
        prompt: req.prompt,
        ...(req.image ? { image: req.image } : {}),
        ...(req.references.length ? { references: req.references } : {}),
        ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
        size: req.size,
      },
      signal
    );
    const model = usage?.model ?? req.route.model;
    const credits = usage?.credits ?? creditsFor(action, { model });
    hooks.record({ action, providerId: usage?.providerId ?? req.route.providerId, ...(model ? { model } : {}), images: 1, credits, local: false, ok: true });
    return { data: Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)), mime: image.mime, width: image.width, height: image.height, credits };
  } catch (err) {
    if (!(err instanceof AiRunError && (err.code === "cancelled" || err.code === "over-limit" || err.code === "disabled")))
      hooks.record({ action, providerId: req.route.providerId, ...(req.route.model ? { model: req.route.model } : {}), images: 0, credits: 0, local: false, ok: false });
    throw err;
  }
}

/** Blurs `boxes` (in the layer's coordinates) of an image layer, as a low-resolution print: one undo step. */
export async function blurRegions(ed: EditorController, nodeId: string, boxes: { x: number; y: number; width: number; height: number }[]): Promise<void> {
  const t = imageTargetOf(ed.engine.readNode(nodeId));
  if (!t) throw new AiRunError("unsupported", "This layer has no picture to blur.");
  if (!boxes.length) return;
  await blurBoxes(imageToolsOf(ed).env, t, boxes);
}
