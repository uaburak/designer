/**
 * Files in comments (atlas 16 §2.7): picked, pasted or dropped into a composer, checked by Figma's rules (5 per
 * comment, images up to 30 MB, videos up to 100 MB, PNG / JPEG / GIF and the videos a browser plays, no file twice),
 * their bytes put in the file's image store (the store's blobs) — a video's picture too: its frame 1 s after it loads
 * (10 s at most, else a black 1600 × 900), as PNG. Shown under the comment's text as thumbnails (longest side 900 at
 * most); a click opens them full size with Previous / Next.
 */
import { useEffect, useState } from "react";
import { Button, Icon, IconButton, Portal, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { checkAttachments, isAttachmentVideo, MAX_ATTACHMENTS, type AttachmentError, type CommentAttachment } from "@shared/comments";
import type { ImageStore } from "../images";
import styles from "./Comments.module.css";

/** Figma's video picture: 1 s after `loadeddata`, at most 10 s; a black 1600 × 900 when the video can't be read */
const THUMB_AT_MS = 1000;
const THUMB_TIMEOUT_MS = 10_000;
const THUMB_FALLBACK = { width: 1600, height: 900 };
/** Thumbnails fit a 900 px box */
export const THUMB_BOX = 900;

/** The error toasts for files that can't be added (Figma's enum; its English isn't read, ours) */
export function attachmentErrorText(error: AttachmentError, names: string[]): string {
  const list = names.join(", ");
  switch (error) {
    case "INVALID_FILE_TYPE":
      return t("Only images, GIFs and videos can be added: {names}", { names: list });
    case "DUPLICATE_FILE_UPLOAD":
      return t("Already added: {names}", { names: list });
    case "MAX_VIDEO_SIZE_EXCEEDED":
      return t("Videos can be up to {n} MB: {names}", { n: 100, names: list });
    case "MAX_IMAGE_SIZE_EXCEEDED":
      return t("Images can be up to {n} MB: {names}", { n: 30, names: list });
    case "MAX_UPLOADS_EXCEEDED":
      return tp(MAX_ATTACHMENTS, "You can add up to {n} file", "You can add up to {n} files");
    default:
      return t("Couldn't upload {names}", { names: list });
  }
}

/** A box fitted in THUMB_BOX, aspect kept */
export function thumbSize(width: number, height: number, box = THUMB_BOX): { width: number; height: number } {
  const s = Math.min(1, box / Math.max(1, width, height));
  return { width: Math.round(width * s), height: Math.round(height * s) };
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/** A video's picture as PNG bytes, with its size */
async function videoPicture(blob: Blob): Promise<{ png: Uint8Array; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const frame = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), THUMB_TIMEOUT_MS);
    video.onerror = () => (clearTimeout(timer), resolve(false));
    video.onloadeddata = () =>
      setTimeout(() => {
        video.onseeked = () => (clearTimeout(timer), resolve(true));
        video.currentTime = Math.min(THUMB_AT_MS / 1000, Number.isFinite(video.duration) ? video.duration : 0);
      }, 0);
  });
  const width = frame && video.videoWidth ? video.videoWidth : THUMB_FALLBACK.width;
  const height = frame && video.videoHeight ? video.videoHeight : THUMB_FALLBACK.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, width, height);
  if (frame) g.drawImage(video, 0, 0, width, height);
  URL.revokeObjectURL(url);
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return { png: new Uint8Array(await (png ?? new Blob()).arrayBuffer()), width, height };
}

let nextId = 0;
const newId = () => `att_${Date.now().toString(36)}${(nextId++).toString(36).padStart(4, "0")}`;

/** Puts a checked file's bytes (and a video's picture) in the store; null when that fails. */
export async function uploadAttachment(images: ImageStore, file: File): Promise<CommentAttachment | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const video = isAttachmentVideo(file.type);
    const sha1 = await images.put(bytes, file.type);
    let size: { width: number; height: number };
    let thumb: string | null = null;
    if (video) {
      const pic = await videoPicture(file);
      thumb = await images.put(pic.png, "image/png");
      size = { width: pic.width, height: pic.height };
    } else size = await imageSize(file);
    return { id: newId(), name: file.name, mime: file.type, size: file.size, sha1, thumb, lastModified: file.lastModified, ...size };
  } catch (e) {
    console.warn("comments: couldn't add the file", e);
    return null;
  }
}

/** Checks `files` against those attached, toasts what can't be added, uploads the rest. */
export async function addAttachments(images: ImageStore, attached: CommentAttachment[], files: File[]): Promise<CommentAttachment[]> {
  const { ok, errors } = checkAttachments(attached, files);
  const failed: string[] = [];
  const out: CommentAttachment[] = [];
  for (const f of ok) {
    const a = await uploadAttachment(images, f);
    if (a) out.push(a);
    else failed.push(f.name);
  }
  if (failed.length) errors.push({ error: "FAILED_TO_UPLOAD", names: failed });
  for (const e of errors) showToast({ message: attachmentErrorText(e.error, e.names), kind: "error" });
  return out;
}

/** An object URL for a blob in the image store (revoked when it goes) */
export function useBlobUrl(images: ImageStore | undefined, sha1: string | null | undefined, mime = "image/png"): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!images || !sha1) return;
    let made: string | null = null;
    let live = true;
    void images.get(sha1).then((bytes) => {
      if (!live || !bytes) return;
      made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [images, sha1, mime]);
  return url;
}

/** A file's thumbnail: an image's own bytes, a video's picture with a play mark */
export function AttachmentThumb({ images, a, size, onOpen, onRemove }: { images?: ImageStore; a: CommentAttachment; size: number; onOpen?(): void; onRemove?(): void }) {
  useT();
  const video = isAttachmentVideo(a.mime);
  const url = useBlobUrl(images, video ? a.thumb : a.sha1, video ? "image/png" : a.mime);
  return (
    <span className={styles.attachment} style={{ width: size, height: size }} data-attachment={a.id}>
      <button type="button" className={styles.attachmentOpen} aria-label={a.name} disabled={!onOpen} onClick={onOpen}>
        {url ? <img src={url} alt="" /> : null}
        {video && (
          <span className={styles.attachmentPlay} aria-hidden>
            ▶
          </span>
        )}
      </button>
      {onRemove && <IconButton className={styles.attachmentRemove} icon="16.close" label={t("Remove {name}", { name: a.name })} onClick={onRemove} />}
    </span>
  );
}

/** A comment's files full size, Previous / Next between them, Download; Esc closes. */
export function AttachmentViewer({ images, list, at, onClose }: { images?: ImageStore; list: CommentAttachment[]; at: number; onClose(): void }) {
  useT();
  const [i, setI] = useState(at);
  const a = list[Math.min(i, list.length - 1)];
  const video = a ? isAttachmentVideo(a.mime) : false;
  const url = useBlobUrl(images, a?.sha1, a?.mime);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
      else if (e.key === "ArrowRight") setI((n) => Math.min(list.length - 1, n + 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [list.length, onClose]);
  if (!a) return null;
  const fitted = thumbSize(a.width || THUMB_FALLBACK.width, a.height || THUMB_FALLBACK.height, Math.min(innerWidth, innerHeight) - 160);
  return (
    <Portal>
      <div className={styles.viewer} role="dialog" aria-label={a.name} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className={styles.viewerBar}>
          <span className={styles.viewerName}>{a.name}</span>
          <span className={styles.grow} />
          {list.length > 1 && (
            <span className={styles.viewerCount}>
              {i + 1} / {list.length}
            </span>
          )}
          <Button variant="secondary" disabled={!url} onClick={() => url && download(url, a.name)}>
            {t("Download")}
          </Button>
          <IconButton icon="24.close.small" label={t("Close")} onClick={onClose} />
        </div>
        <div className={styles.viewerBody}>
          <IconButton icon="24.arrow.left" label={t("Previous")} disabled={i === 0} onClick={() => setI(i - 1)} />
          <span className={styles.viewerMedia} style={fitted}>
            {url && (video ? <video src={url} controls autoPlay style={fitted} /> : <img src={url} alt="" style={fitted} />)}
          </span>
          <IconButton icon="24.arrow.right" label={t("Next")} disabled={i >= list.length - 1} onClick={() => setI(i + 1)} />
        </div>
      </div>
    </Portal>
  );
}

function download(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

/** The attach control's glyph (an image) */
export function AttachGlyph() {
  return <Icon name="24.image" />;
}
