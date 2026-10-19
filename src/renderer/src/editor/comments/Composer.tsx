/**
 * The comment composer (live: docs/research/figma/live/multiplayer/comments.md "The Comment tool"): a text field that
 * wraps and grows, [Send] ↑ at the right (grey while empty, blue with text); with text a bottom row — [Add emoji],
 * [Add mention] "@", [Upload up to 5 images and GIFs] (a local file's comments: atlas 16 §2.7 — pasted or dropped files
 * join too, shown above the row with a remove ×). Enter posts, Shift+Enter adds a line (a list's next item in a list),
 * Esc cancels. Typing "@" lists the people who can be mentioned; a pick puts their name in as one piece. Figma's rich
 * text (atlas 16 §2.6, richText.tsx): ⌘B bold, ⌘I italic, ⌘⇧X strikethrough, ⌘K a link, ⌘⇧7 / ⌘⇧8 numbered /
 * bulleted list — a local file's comments only (a shared file's server keeps the plain text). Past 2,000 characters
 * nothing is sent.
 */
import { useEffect, useRef, useState } from "react";
import { Avatar, cx, Icon } from "@/ds";
import { IS_MAC } from "@/engine/CanvasController";
import { t, useT } from "@/i18n";
import { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_VIDEO_TYPES, commentLength, MAX_COMMENT_LENGTH, type CommentAttachment, type CommentSegment, type MentionCandidate } from "@shared/comments";
import type { ImageStore } from "../images";
import { addAttachments, AttachGlyph, AttachmentThumb } from "./attachments";
import { EmojiPicker } from "./EmojiPicker";
import { formatKey, isRich, mentionChip, plainText, readSegments, writeSegments } from "./richText";
import styles from "./Comments.module.css";

export interface ComposerProps {
  placeholder: string;
  /** aria-label of the field (live: "Add a comment" / "Reply to comment with <author>") */
  label?: string;
  people: MentionCandidate[];
  /** Your id: you aren't offered for a mention */
  me?: string;
  initial?: string;
  /** An edited comment's rich segments (else `initial` as plain text) */
  initialMeta?: CommentSegment[] | null;
  autoFocus?: boolean;
  /**
   * Resolves true when posted (the field empties). `meta`: the message's rich segments when it has styles, links or
   * lists; `mentions`: the people picked from the list.
   */
  onSubmit(text: string, attachments: CommentAttachment[], meta: CommentSegment[] | null, mentions: string[]): Promise<boolean> | boolean;
  /** Where files go: absent, none can be added (a shared file's comments, an edit) */
  images?: ImageStore;
  /** Rich text (bold, italic, strikethrough, links, lists): off for a shared file's comments */
  rich?: boolean;
  onCancel?(): void;
  onChange?(text: string): void;
  /** "reply": the thread's reply field (bg secondary); "edit": Cancel / Save under it */
  variant?: "new" | "reply" | "edit";
}

/** "@query" right before the caret in the field, or null */
function caretQuery(field: HTMLElement | null): string | null {
  const sel = getSelection();
  if (!field || !sel?.rangeCount || !sel.isCollapsed || !sel.anchorNode || !field.contains(sel.anchorNode) || sel.anchorNode.nodeType !== Node.TEXT_NODE) return null;
  const before = (sel.anchorNode.textContent ?? "").slice(0, sel.anchorOffset);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return m ? m[1] : null;
}

export function Composer({ placeholder, label, people: everyone, me, initial = "", initialMeta, autoFocus, onSubmit, onCancel, onChange, variant = "new", images, rich = true }: ComposerProps) {
  useT();
  const people = everyone.filter((p) => p.id !== me);
  const [text, setText] = useState(initialMeta?.length ? plainText(initialMeta) : initial);
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(0);
  const [emoji, setEmoji] = useState<HTMLElement | null>(null);
  const [linking, setLinking] = useState<{ range: Range; url: string } | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<CommentAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Where the caret was in the field (an emoji picked from the picker goes there) */
  const lastRange = useRef<Range | null>(null);
  const noteRange = () => {
    const sel = getSelection();
    if (sel?.rangeCount && field.current?.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
  };

  // The field's first content: the edited comment's segments, else its text.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    if (initialMeta?.length) writeSegments(el, initialMeta);
    else el.textContent = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the field mounts
  }, []);
  useEffect(() => {
    if (!autoFocus || !field.current) return;
    field.current.focus({ preventScroll: true });
    // The caret at the end (an edit starts after its text).
    const sel = getSelection();
    sel?.selectAllChildren(field.current);
    sel?.collapseToEnd();
  }, [autoFocus]);

  const matches = query !== null && people.length ? people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.email.toLowerCase().startsWith(query.toLowerCase())).slice(0, 8) : [];

  const sync = () => {
    const el = field.current;
    if (!el) return;
    const next = plainText(readSegments(el));
    setText(next);
    setQuery(caretQuery(el));
    noteRange();
    onChange?.(next);
  };
  const insert = (s: string) => {
    const el = field.current;
    if (!el) return;
    if (document.activeElement !== el) {
      el.focus();
      const sel = getSelection();
      if (lastRange.current) {
        sel?.removeAllRanges();
        sel?.addRange(lastRange.current);
      } else {
        sel?.selectAllChildren(el);
        sel?.collapseToEnd();
      }
    }
    document.execCommand("insertText", false, s);
    sync();
  };
  const mention = (p: MentionCandidate) => {
    const sel = getSelection();
    const node = sel?.anchorNode;
    if (!sel || !node || node.nodeType !== Node.TEXT_NODE || query === null) return;
    // The typed "@query" becomes the person's chip and a space after it.
    const range = document.createRange();
    range.setStart(node, sel.anchorOffset - query.length - 1);
    range.setEnd(node, sel.anchorOffset);
    range.deleteContents();
    const chip = mentionChip(p.id, `@${p.name}`);
    const space = document.createTextNode("\u00a0");
    range.insertNode(space);
    range.insertNode(chip);
    sel.collapse(space, 1);
    sync();
  };
  const reset = () => {
    if (field.current) field.current.replaceChildren();
    setFiles([]);
    sync();
  };

  // Figma's limit: 2,000 characters (graphemes), past which nothing is sent.
  const over = commentLength(text) > MAX_COMMENT_LENGTH;
  const submit = async () => {
    const el = field.current;
    if (!el || (!text.trim() && !files.length) || busy || over || uploading) return;
    const segments = readSegments(el);
    const message = plainText(segments).trim();
    const mentions = [...new Set(segments.flatMap((s) => ("user_id" in s ? [s.user_id] : [])))];
    setBusy(true);
    const ok = await onSubmit(message, files, rich && isRich(segments) ? segments : null, mentions);
    setBusy(false);
    if (ok && variant !== "edit") reset();
  };
  const attach = async (list: File[]) => {
    if (!images || !list.length) return;
    setUploading(true);
    const added = await addAttachments(images, files, list);
    setUploading(false);
    setFiles((f) => [...f, ...added]);
  };
  const filesIn = (data: DataTransfer | null) => [...(data?.files ?? [])];

  const applyLink = (url: string) => {
    const l = linking;
    setLinking(null);
    if (!l) return;
    field.current?.focus();
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(l.range);
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (url.trim() && /^(https?:|mailto:)/i.test(href)) document.execCommand("createLink", false, href);
    sync();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        mention(matches[Math.min(pick, matches.length - 1)]);
        return;
      }
    }
    const format = rich ? formatKey(e.nativeEvent, IS_MAC) : null;
    if (format) {
      e.preventDefault();
      if (format === "link") {
        const sel = getSelection();
        if (sel?.rangeCount && !sel.isCollapsed) setLinking({ range: sel.getRangeAt(0).cloneRange(), url: "" });
      } else {
        document.execCommand(format);
        sync();
      }
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!e.shiftKey) return void submit();
      // Shift+Enter: a new line — in a list, its next item.
      const inList = !!(getSelection()?.anchorNode as Node | null)?.parentElement?.closest("li");
      document.execCommand(inList ? "insertParagraph" : "insertLineBreak");
      sync();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  };

  const empty = !text.trim() && !files.length;
  const expanded = !empty || variant === "edit";
  const unsendable = empty || over || uploading;
  return (
    <div
      className={cx(styles.composer, styles[`composer-${variant}`])}
      data-expanded={expanded || undefined}
      onDragOver={(e) => images && e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!images || !e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void attach(filesIn(e.dataTransfer));
      }}
    >
      <div className={styles.composerRow}>
        <div
          ref={field}
          className={styles.composerField}
          contentEditable
          suppressContentEditableWarning
          data-empty={!text || undefined}
          data-placeholder={placeholder}
          aria-label={label ?? placeholder}
          role="combobox"
          aria-multiline
          aria-expanded={matches.length > 0}
          aria-autocomplete="list"
          aria-invalid={over || undefined}
          onInput={sync}
          onKeyUp={() => (setQuery(caretQuery(field.current)), noteRange())}
          onClick={() => (setQuery(caretQuery(field.current)), noteRange())}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = filesIn(e.clipboardData);
            if (pasted.length) {
              if (images) void attach(pasted);
              return;
            }
            // Text only: another page's formatting doesn't come along.
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            sync();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {!expanded && <SendButton disabled={unsendable || busy} onClick={submit} />}
      </div>
      {linking && (
        <div className={styles.linkRow}>
          <input
            className={styles.linkField}
            autoFocus
            placeholder={t("Paste a link")}
            aria-label={t("Link")}
            value={linking.url}
            onChange={(e) => setLinking({ ...linking, url: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink(linking.url);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinking(null);
                field.current?.focus();
              }
            }}
          />
        </div>
      )}
      {files.length > 0 && (
        <div className={styles.composerFiles}>
          {files.map((a) => (
            <AttachmentThumb key={a.id} images={images} a={a} size={48} onRemove={() => setFiles((f) => f.filter((x) => x !== a))} />
          ))}
        </div>
      )}
      {expanded && (
        <div className={styles.composerTools}>
          <button type="button" className={styles.toolButton} aria-label={t("Add emoji")} onPointerDown={(e) => e.preventDefault()} onClick={(e) => setEmoji(emoji ? null : e.currentTarget)}>
            <span aria-hidden>☺</span>
          </button>
          <button type="button" className={styles.toolButton} aria-label={t("Add mention")} disabled={!people.length} onPointerDown={(e) => e.preventDefault()} onClick={() => insert("@")}>
            <span aria-hidden>@</span>
          </button>
          {images && variant !== "edit" && (
            <>
              <button type="button" className={styles.toolButton} aria-label={t("Upload up to 5 images and GIFs")} disabled={uploading} onClick={() => picker.current?.click()}>
                <AttachGlyph />
              </button>
              <input
                ref={picker}
                type="file"
                hidden
                multiple
                accept={[...ATTACHMENT_IMAGE_TYPES, ...ATTACHMENT_VIDEO_TYPES].join(",")}
                onChange={(e) => {
                  const picked = [...(e.target.files ?? [])];
                  e.target.value = "";
                  void attach(picked);
                }}
              />
            </>
          )}
          <span className={styles.grow} />
          {variant === "edit" ? (
            <>
              <button type="button" className={styles.textButton} onClick={() => onCancel?.()}>
                {t("Cancel")}
              </button>
              <button type="button" className={styles.saveButton} disabled={unsendable || busy} onClick={() => void submit()}>
                {t("Save")}
              </button>
            </>
          ) : (
            <SendButton disabled={unsendable || busy} onClick={submit} />
          )}
        </div>
      )}
      {matches.length > 0 && (
        <div className={styles.mentions} role="listbox" aria-label={t("People")}>
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === pick}
              className={styles.mention}
              data-active={i === pick || undefined}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => mention(p)}
            >
              <Avatar name={p.name} src={p.picture ?? undefined} size={16} />
              <span className={styles.mentionName}>{p.name}</span>
              <span className={styles.mentionEmail}>{p.email}</span>
            </button>
          ))}
        </div>
      )}
      {emoji && (
        <EmojiPicker
          anchor={emoji}
          onPick={(e) => {
            setEmoji(null);
            insert(e);
          }}
          onClose={() => setEmoji(null)}
        />
      )}
    </div>
  );
}

function SendButton({ disabled, onClick }: { disabled: boolean; onClick(): void }) {
  useT();
  return (
    <button type="button" className={styles.send} aria-label={t("Send")} disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name="16.arrow.up" />
    </button>
  );
}
