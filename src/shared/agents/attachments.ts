/**
 * Files the user attaches to a chat message (the composer's "+", a drop, a paste): PDF, PNG, JPEG, WebP or GIF, known by
 * their bytes, at most MAX_ATTACHMENT_BYTES each and MAX_ATTACHMENTS a message. Main copies them into the chat's own
 * folder (`<chat>/attachments/`, src/main/agents/attachments.ts) — the views never write files — and the turn tells the
 * agent their paths (`attachmentsNote`); each CLI reads them with its own file tool (Claude Code's Read limited to that
 * folder, Antigravity's view_file, Codex `--image`), and place_image can put an attached picture on the canvas.
 */
import { MAX_IMAGE_BYTES, sniffImage } from "./images";

export const MAX_ATTACHMENT_BYTES = MAX_IMAGE_BYTES;
export const MAX_ATTACHMENTS = 5;
/** The chat folder's sub-folder they are copied into. */
export const ATTACHMENTS_DIR = "attachments";

export type AttachmentMime = "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface Attachment {
  id: string;
  /** The file's name as the user had it ("Screenshot 2026-10-09.png") */
  name: string;
  mime: AttachmentMime;
  size: number;
  /** Where main copied it: `<chat folder>/attachments/<id>-<name>` */
  path: string;
  /** A small picture of it (a data: URL) for the chips, when one could be made */
  thumb?: string;
}

export interface AttachResult {
  attachments: Attachment[];
  /** Files that weren't attached, in the panel's words */
  errors: string[];
}

/** What a turn sends of its attachments. */
export type TurnAttachment = Pick<Attachment, "path" | "name" | "mime">;

export function sniffAttachment(b: Uint8Array): AttachmentMime | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  return sniffImage(b);
}

export const isImageMime = (m: string) => m.startsWith("image/");

const EXT: Record<AttachmentMime, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const KIND: Record<AttachmentMime, string> = { "application/pdf": "PDF", "image/png": "PNG image", "image/jpeg": "JPEG image", "image/webp": "WebP image", "image/gif": "GIF image" };

/**
 * A safe file name for the copy: letters, digits, spaces, dots, dashes and underscores only (no commas: Codex's
 * `--image` takes a comma list), the extension its bytes say, at most 80 characters.
 */
export function safeFileName(name: string, mime: AttachmentMime): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "_")
    .replace(/^[.\s_]+/, "")
    .trim()
    .slice(0, 72);
  return `${base || (isImageMime(mime) ? "image" : "document")}.${EXT[mime]}`;
}

/** Why a file can't be attached, or null when it can. */
export function attachmentProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length > MAX_ATTACHMENT_BYTES) return `“${name}” is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
  if (!bytes.length) return `“${name}” is empty`;
  if (!sniffAttachment(bytes)) return `“${name}” isn’t a PDF, PNG, JPEG, WebP or GIF`;
  return null;
}

/** The turn's prompt about its attachments: their paths, what they are, and how to look at them. */
export function attachmentsNote(list: TurnAttachment[], how: string): string {
  if (!list.length) return "";
  const lines = list.map((a) => `- ${a.path} (${KIND[a.mime as AttachmentMime] ?? a.mime}, “${a.name}”)`);
  return `[The user attached ${list.length === 1 ? "a file" : `${list.length} files`} to this message:\n${lines.join("\n")}\n${how} An attached picture can go on the canvas as it is with place_image {path}.]`;
}
