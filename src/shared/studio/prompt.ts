/**
 * The prompt builder (docs/studio.md §5.2): the brief, the brand and its products → the words and references sent to
 * the image model. Deterministic, so every variation gets the same rules. 15b fills it.
 */
import type { Brand, ImagePrompt, Product, ReviewProblem, SocialFormat, StudioBrief } from "./types";

export function buildImagePrompt(_brief: StudioBrief, _brand: Brand, _products: readonly Product[], _format: SocialFormat, _variation: number): ImagePrompt {
  return { prompt: "", references: [], aspectRatio: "1:1" };
}

/** Fix label (§6.2): the picture made before goes first as the image to edit; the label close-ups and exact texts follow. */
export function buildFixLabelPrompt(_brand: Brand, _products: readonly Product[], _problems: readonly ReviewProblem[]): ImagePrompt {
  return { prompt: "", references: [], aspectRatio: "1:1" };
}
