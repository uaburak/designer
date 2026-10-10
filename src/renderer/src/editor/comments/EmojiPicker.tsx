/**
 * The emoji picker (live: ≈ 330 wide — category tabs, a search field, "Frequently used", then the categories), placed
 * under its button and kept in the window.
 */
import { useRef, useState } from "react";
import { Portal, useDismiss } from "@/ds";
import { CATEGORIES, emojiName, FREQUENT, searchEmoji } from "./emoji";
import styles from "./Comments.module.css";

const WIDTH = 330;
const HEIGHT = 320;

export function EmojiPicker({ anchor, onPick, onClose }: { anchor: Element | null; onPick(emoji: string): void; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Placed once, under its button (above it when there's no room), inside the window.
  const [at] = useState(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return { left: 16, top: 16 };
    const below = r.bottom + 4;
    return { left: Math.max(8, Math.min(r.left, innerWidth - WIDTH - 8)), top: below + HEIGHT > innerHeight - 8 ? Math.max(8, r.top - HEIGHT - 4) : below };
  });
  useDismiss(panel, onClose, { ignore: anchor });
  const found = searchEmoji(query);
  const grid = (list: string[]) => (
    <div className={styles.emojiGrid}>
      {list.map((e) => (
        <button key={e} type="button" className={styles.emoji} aria-label={emojiName(e)} title={emojiName(e)} onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  );
  return (
    <Portal anchor={anchor}>
      <div ref={panel} className={styles.emojiPicker} role="dialog" aria-label="Emoji picker" style={at} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
        <div className={styles.emojiTabs}>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={styles.emojiTab} aria-label={c.label} title={c.label} onClick={() => body.current?.querySelector(`[data-cat="${c.id}"]`)?.scrollIntoView({ block: "start" })}>
              {c.icon}
            </button>
          ))}
        </div>
        <input className={styles.emojiSearch} placeholder="Search" aria-label="Search emoji" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
        <div ref={body} className={styles.emojiBody}>
          {query.trim() ? (
            found.length ? grid(found) : <p className={styles.emojiNone}>No emoji found</p>
          ) : (
            <>
              <h3 className={styles.emojiHeading}>Frequently used</h3>
              {grid(FREQUENT)}
              {CATEGORIES.map((c) => (
                <section key={c.id} data-cat={c.id}>
                  <h3 className={styles.emojiHeading}>{c.label}</h3>
                  {grid(c.emoji.map(([e]) => e))}
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
