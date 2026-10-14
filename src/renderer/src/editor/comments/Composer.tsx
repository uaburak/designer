/**
 * The comment composer (live: docs/research/figma/live/multiplayer/comments.md "The Comment tool"): a text field that
 * wraps and grows, [Send] ↑ at the right (grey while empty, blue with text); with text a bottom row — [Add emoji],
 * [Add mention] "@". Enter posts, Shift+Enter adds a line, Esc cancels. Typing "@" lists the people who can be mentioned.
 * (Figma's [Upload up to 5 images and GIFs] is left out: images in comments aren't built.)
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, cx, Icon } from "@/ds";
import { t, useT } from "@/i18n";
import type { MentionCandidate } from "@shared/comments";
import { EmojiPicker } from "./EmojiPicker";
import styles from "./Comments.module.css";

export interface ComposerProps {
  placeholder: string;
  /** aria-label of the field (live: "Add a comment" / "Reply to comment with <author>") */
  label?: string;
  people: MentionCandidate[];
  /** Your id: you aren't offered for a mention */
  me?: string;
  initial?: string;
  autoFocus?: boolean;
  /** Resolves true when posted (the field empties) */
  onSubmit(text: string): Promise<boolean> | boolean;
  onCancel?(): void;
  onChange?(text: string): void;
  /** "reply": the thread's reply field (bg secondary); "edit": Cancel / Save under it */
  variant?: "new" | "reply" | "edit";
}

export function Composer({ placeholder, label, people: everyone, me, initial = "", autoFocus, onSubmit, onCancel, onChange, variant = "new" }: ComposerProps) {
  useT();
  const people = everyone.filter((p) => p.id !== me);
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(0);
  const [emoji, setEmoji] = useState<HTMLElement | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  // The field grows with its text (live: 296 × 104 with two lines).
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const query = /@([^\s@]*)$/.exec(text.slice(0, caret));
  const matches = query && people.length ? people.filter((p) => p.name.toLowerCase().includes(query[1].toLowerCase()) || p.email.toLowerCase().startsWith(query[1].toLowerCase())).slice(0, 8) : [];

  const update = (next: string, at = next.length) => {
    setText(next);
    setCaret(at);
    onChange?.(next);
  };
  const insert = (s: string, replace = 0) => {
    const el = field.current;
    const start = (el?.selectionStart ?? caret) - replace;
    const end = el?.selectionEnd ?? caret;
    const next = text.slice(0, start) + s + text.slice(end);
    update(next, start + s.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + s.length, start + s.length);
    });
  };
  const mention = (p: MentionCandidate) => insert(`@${p.name} `, query ? query[0].length : 0);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    if (ok && variant !== "edit") update("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  };

  const empty = !text.trim();
  const expanded = !empty || variant === "edit";
  return (
    <div className={cx(styles.composer, styles[`composer-${variant}`])} data-expanded={expanded || undefined}>
      <div className={styles.composerRow}>
        <textarea
          ref={field}
          className={styles.composerField}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label ?? placeholder}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-autocomplete="list"
          onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {!expanded && <SendButton disabled={empty || busy} onClick={submit} />}
      </div>
      {expanded && (
        <div className={styles.composerTools}>
          <button type="button" className={styles.toolButton} aria-label={t("Add emoji")} onClick={(e) => setEmoji(emoji ? null : e.currentTarget)}>
            <span aria-hidden>☺</span>
          </button>
          <button type="button" className={styles.toolButton} aria-label={t("Add mention")} disabled={!people.length} onClick={() => insert("@")}>
            <span aria-hidden>@</span>
          </button>
          <span className={styles.grow} />
          {variant === "edit" ? (
            <>
              <button type="button" className={styles.textButton} onClick={() => onCancel?.()}>
                {t("Cancel")}
              </button>
              <button type="button" className={styles.saveButton} disabled={empty || busy} onClick={() => void submit()}>
                {t("Save")}
              </button>
            </>
          ) : (
            <SendButton disabled={empty || busy} onClick={submit} />
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
