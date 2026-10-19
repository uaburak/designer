/**
 * The Actions panel's AI rows (live toolbar/actions-panel.txt; docs/ai.md §1): the All tab lists, after Recents,
 * "Image editing" (Make an image, Remove background, Boost resolution, Edit image with prompt), "Design tools"
 * (Rename layers, Replace content, Add interactions, and First Draft — not in that capture, placed here [unverified])
 * and "Riffing and writing" (Shorten, Rewrite this..., Translate to...), each row with the "AI" badge. The image rows
 * belong to the image tools (round 6b, editor/imageTools): they register their handlers here and stay disabled until
 * they do.
 *
 * The rows' glyphs are Figma's own AI-action icons (`24.ai.*`, read from Figma desktop's cached editor build: its
 * quick-actions list gives each action its icon component — GENERATE_IMAGE, REMOVE_BACKGROUND, UPSCALE_IMAGE (the
 * 2× variant), EDIT_IMAGE and REWRITE_TEXT (one glyph), FIND_INSPIRATION, AUTO_RENAME_LAYERS, CONTENT_FILL,
 * MAGIC_LINK, SHORTEN_TEXT, TRANSLATE_TEXT). First Draft is not in that list: it keeps the frame glyph.
 */
import type { IconName } from "@/ds";
import type { AiAction } from "@shared/ai/types";
import type { EditorController } from "../controller";
import type { AiForm } from "./service";

export interface AiRowDef {
  /** The row's id in Actions' Recents: "ai.<action>" */
  id: string;
  action: AiAction;
  label: string;
  section: "Image editing" | "Design tools" | "Riffing and writing";
  icon: IconName;
  /** A form in the panel first (else the action runs at once) */
  form?: AiForm;
}

export const AI_ROWS: readonly AiRowDef[] = [
  { id: "ai.make-image", action: "make-image", label: "Make an image", section: "Image editing", icon: "24.ai.make-image" },
  { id: "ai.remove-background", action: "remove-background", label: "Remove background", section: "Image editing", icon: "24.ai.remove-background" },
  { id: "ai.boost-resolution", action: "boost-resolution", label: "Boost resolution", section: "Image editing", icon: "24.ai.boost-resolution" },
  { id: "ai.edit-image", action: "edit-image", label: "Edit image with prompt", section: "Image editing", icon: "24.ai.edit-image" },
  // "Find more like" (help 24037716110615: Actions › Find more like) — visual search over the selection (6d); placed with the image rows, which run registered handlers [our placement]
  { id: "ai.find-more-like", action: "visual-search", label: "Find more like", section: "Image editing", icon: "24.ai.find-more-like" },
  { id: "ai.rename-layers", action: "rename-layers", label: "Rename layers", section: "Design tools", icon: "24.ai.rename-layers" },
  { id: "ai.replace-content", action: "replace-content", label: "Replace content", section: "Design tools", icon: "24.ai.replace-content", form: "replace-content" },
  { id: "ai.add-interactions", action: "add-interactions", label: "Add interactions", section: "Design tools", icon: "24.ai.add-interactions" },
  { id: "ai.first-draft", action: "first-draft", label: "First Draft", section: "Design tools", icon: "24.frame", form: "first-draft" },
  { id: "ai.shorten", action: "shorten", label: "Shorten", section: "Riffing and writing", icon: "24.ai.shorten" },
  { id: "ai.rewrite", action: "rewrite", label: "Rewrite this...", section: "Riffing and writing", icon: "24.ai.edit-image", form: "rewrite" },
  { id: "ai.translate", action: "translate", label: "Translate to...", section: "Riffing and writing", icon: "24.ai.translate", form: "translate" },
];

export const AI_ROW_BY_ID = new Map(AI_ROWS.map((r) => [r.id, r]));

/** An image tool's handler for its Actions row (round 6b registers these). */
export interface AiImageRowHandler {
  run(ed: EditorController): void;
  enabled?(ed: EditorController): boolean;
}

const imageHandlers = new Map<AiAction, AiImageRowHandler>();

/** The image tools' rows: `make-image`, `remove-background`, `boost-resolution`, `edit-image`. */
export function registerAiImageRow(action: AiAction, handler: AiImageRowHandler): () => void {
  imageHandlers.set(action, handler);
  return () => {
    if (imageHandlers.get(action) === handler) imageHandlers.delete(action);
  };
}

export const imageRowHandler = (action: AiAction): AiImageRowHandler | undefined => imageHandlers.get(action);
