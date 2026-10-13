/**
 * Studio's pictures (docs/studio.md §5.3, §6.2): an image run with references through `ai:image`, Fix label as an edit
 * with references, and Blur on areas of an image layer (local, one undo step). 15c fills it; 15a calls it.
 */
import type { AiRoute } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";

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

export async function runStudioImage(_ed: EditorController, _req: StudioImageRequest, _signal: AbortSignal): Promise<StudioImage> {
  throw new Error("Studio images aren't built yet");
}

/** Blurs `boxes` (in the layer's coordinates) of an image layer, as a low-resolution print: one undo step. */
export async function blurRegions(_ed: EditorController, _nodeId: string, _boxes: { x: number; y: number; width: number; height: number }[]): Promise<void> {
  throw new Error("Blur isn't built yet");
}
