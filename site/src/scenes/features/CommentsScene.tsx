// Comments (watch-only): pins on a design, a thread's card, the reply field, resolving, and comment mode (C, then a
// click drops a pin), played by the demo — drawn with the app's own comment styles (editor/comments/Comments.module.css: the pin and its hover
// preview, the thread's header, comments, reply row and composer) and ds Avatar, Icon, Toolbar and ToolButton. The
// threads live in this scene's state; the canvas is DOM (one live engine per page: Draw's).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { TOOLS } from "@/ds/components/EditorToolbar";
import { Avatar } from "@/ds/components/Misc";
import { Toolbar, ToolbarGroup, ToolButton } from "@/ds/components/Toolbar";
import { Icon } from "@/ds/icons/Icon";
import { timeAgo } from "@/ds/util/time";
import cm from "@/editor/comments/Comments.module.css";
import { boxIn, FrameLabel, SceneCanvas, SceneWindow, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import styles from "./comments.module.css";

interface Person {
  name: string;
}
interface Message {
  id: string;
  user: Person;
  text: string;
  at: number;
}
interface Thread {
  id: string;
  /** Where it is pinned, in the frame's own px */
  x: number;
  y: number;
  resolved: boolean;
  comments: Message[];
}

const ME: Person = { name: "Ada Park" };
const BEN: Person = { name: "Ben Ortiz" };
const CHLOE: Person = { name: "Chloé Martin" };
const MIN = 60_000;

const first = (now: number): Thread[] => [
  { id: "t1", x: 404, y: 262, resolved: false, comments: [{ id: "c1", user: BEN, text: "Can the price sit closer to the button? It feels far away on mobile.", at: now - 12 * MIN }] },
  { id: "t2", x: 140, y: 84, resolved: false, comments: [{ id: "c2", user: CHLOE, text: "Love this photo. Do we have it at 2x for retina?", at: now - 64 * MIN }, { id: "c3", user: ME, text: "Yes, it’s in the Assets page.", at: now - 50 * MIN }] },
];

/** "Just now", "12 minutes ago": the thread's capitalised form of Figma's relative time (editor/comments/Thread.tsx) */
const since = (t: number, now: number) => {
  const s = timeAgo(t, now);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export default function CommentsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [threads, setThreads] = useState<Thread[]>(() => first(Date.now()));
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tool, setTool] = useState<"move" | "comment">("move");
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [frame, setFrame] = useState<Box | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [shift, setShift] = useState(0);
  const reset = () => {
    const t = Date.now();
    setNow(t);
    setThreads(first(t));
    setOpen(null);
    setHover(null);
    setTool("move");
    setDraft(null);
  };

  // Relative times move on
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // The design scales to fit; pins and cards stay at screen size, placed over it
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const content = contentRef.current;
    if (!canvas || !content) return;
    const fit = () => {
      const w = canvas.clientWidth;
      const sc = Math.min(1, (w - 40) / content.offsetWidth, (canvas.clientHeight - 120) / content.offsetHeight);
      setNarrow(w < 560);
      setScale(sc);
      // A wide canvas keeps room at the right for the thread's card: the design sits left of centre
      setShift(w > 760 ? Math.max(0, Math.min(150, (w - content.offsetWidth * sc) / 2 - 24)) : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => setFrame(boxIn(frameRef.current, canvasRef.current)), [scale, narrow, shift]);

  const post = (id: string, text: string, user = ME) => setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, comments: [...t.comments, { id: `m${Math.random().toString(36).slice(2, 8)}`, user, text, at: Date.now() }] } : t)));
  const resolve = (id: string) => {
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, resolved: true } : t)));
    setOpen(null);
  };
  const create = (text: string) => {
    if (!draft) return;
    const id = `t${Math.random().toString(36).slice(2, 8)}`;
    setThreads((ts) => [...ts, { id, x: draft.x, y: draft.y, resolved: false, comments: [{ id: `${id}c`, user: ME, text, at: Date.now() }] }]);
    setDraft(null);
    setTool("move");
    setOpen(id);
  };

  const screen = (x: number, y: number) => ({ left: (frame?.x ?? 0) + x * scale, top: (frame?.y ?? 0) + y * scale });
  const cardAt = (x: number, y: number): CSSProperties => {
    if (narrow) return {};
    const p = screen(x, y);
    const w = canvasRef.current?.clientWidth ?? 800;
    const h = canvasRef.current?.clientHeight ?? 600;
    const left = p.left + 44 + 300 > w ? Math.max(8, p.left - 44 - 300) : p.left + 44;
    return { left, top: Math.max(12, Math.min(p.top - 60, h - 400)) };
  };

  const { cursor } = useDemo(rootRef, (run) => commentsDemo(run, { setOpen, setHover, post, resolve, setTool, setDraft, create, screen: (x, y) => screen(x, y) }), { onStart: reset});

  const thread = threads.find((t) => t.id === open && !t.resolved) ?? null;
  return (
    <SceneWindow ref={rootRef} title="Storefront — Comments">
      <SceneCanvas ref={canvasRef} className={styles.canvas} data-tool={tool}>
        <div ref={contentRef} className={styles.content} style={{ transform: `translate(calc(-50% - ${shift}px), -50%) scale(${scale})` }}>
          <FrameLabel x={0} y={0}>
            Product — Desktop
          </FrameLabel>
          <div ref={frameRef} className={styles.frame}>
            <div className={styles.photo}>
              <span className={styles.lampShade} />
              <span className={styles.lampArm} />
              <span className={styles.lampBase} />
            </div>
            <div className={styles.info}>
              <span className={styles.kicker}>Lighting</span>
              <span className={styles.name}>Aurora desk lamp</span>
              <span className={styles.stars} aria-hidden="true">
                ★★★★★ <small>128 reviews</small>
              </span>
              <span className={styles.desc}>Warm in the evening, bright in the morning. Every part screws in.</span>
              <span className={styles.price}>$129</span>
              <span className={styles.buy}>Add to cart</span>
            </div>
          </div>
        </div>

        <div className={cm.pins} data-comment-pins="">
          {threads.map((t) => {
            const p = screen(t.x, t.y);
            const head = t.comments[0];
            const replies = t.comments.length - 1;
            const shown = hover === t.id && open !== t.id;
            return (
              <button
                key={t.id}
                type="button"
                className={`${cm.pin} ${styles.pin}`}
                style={{ left: p.left, top: p.top - 32 }}
                data-thread={t.id}
                data-open={open === t.id || undefined}
                data-resolved-out={t.resolved || undefined}
                data-hover={shown || undefined}
                aria-label={`Comment by ${head.user.name}: ${head.text}`}
              >
                {shown ? (
                  <span className={cm.preview}>
                    <Avatar name={head.user.name} size={24} />
                    <span className={cm.previewMain}>
                      <span className={cm.previewHead}>
                        <span className={cm.previewName}>{head.user.name}</span>
                        <span className={cm.previewTime}>{timeAgo(head.at, now)}</span>
                      </span>
                      <span className={cm.previewText}>{head.text}</span>
                      {replies > 0 && <span className={cm.previewReplies}>{replies === 1 ? "1 reply" : `${replies} replies`}</span>}
                    </span>
                  </span>
                ) : (
                  <span className={cm.pinAvatar}>
                    <Avatar name={head.user.name} size={24} />
                  </span>
                )}
              </button>
            );
          })}
          {draft && <div className={cm.draftPin} style={{ left: screen(draft.x, draft.y).left, top: screen(draft.x, draft.y).top - 32 }} aria-hidden />}
        </div>

        {thread && (
          <div className={`${cm.thread} ${styles.thread}`} style={cardAt(thread.x, thread.y)} role="dialog" aria-label="Comment thread" data-comment-thread={thread.id} onPointerDown={(e) => e.stopPropagation()}>
            <header className={cm.threadHeader}>
              <span className={cm.threadTitle}>Comment</span>
              <span className={cm.grow} />
              <button type="button" className={cm.iconButton} aria-label="Thread actions">
                <Icon name="24.more" />
              </button>
              <button type="button" className={cm.iconButton} aria-label="Mark as resolved" data-demo="resolve" onClick={() => resolve(thread.id)}>
                <ResolveGlyph />
              </button>
              <button type="button" className={cm.iconButton} aria-label="Close comment" onClick={() => setOpen(null)}>
                <Icon name="24.close.small" />
              </button>
            </header>
            <div className={`${cm.threadBody} ${styles.threadBody}`}>
              {thread.comments.map((m) => (
                <article key={m.id} className={`${cm.comment} ${styles.comment}`} data-comment={m.id}>
                  <Avatar name={m.user.name} size={24} />
                  <div className={cm.commentMain}>
                    <div className={cm.commentHead}>
                      <span className={cm.commentName}>{m.user.name}</span>
                      <time className={cm.commentTime}>{since(m.at, now)}</time>
                    </div>
                    <div className={cm.commentTextRow}>
                      <p className={cm.commentText}>{m.text}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <div className={cm.replyRow}>
              <Avatar name={ME.name} size={24} />
              <Composer key={thread.id} placeholder="Reply" label={`Reply to comment with ${thread.comments[0].user.name}`} onSubmit={(text) => post(thread.id, text)} onCancel={() => setOpen(null)} />
            </div>
          </div>
        )}

        {draft && (
          <div className={`${cm.newComment} ${styles.newComment}`} style={cardAt(draft.x, draft.y)} onPointerDown={(e) => e.stopPropagation()} data-comment-composer="">
            <Composer placeholder="Add a comment" label="Add a comment" autoFocus onSubmit={create} onCancel={() => setDraft(null)} />
          </div>
        )}

        <Toolbar floating label="Tools" className={styles.toolbar}>
          <ToolbarGroup>
            <ToolButton icon={TOOLS.move.icon} label={TOOLS.move.label} shortcut={TOOLS.move.shortcut} active={tool === "move"} onSelect={() => (setTool("move"), setDraft(null))} />
            <ToolButton icon={TOOLS.comment.icon} label={TOOLS.comment.label} shortcut={TOOLS.comment.shortcut} active={tool === "comment"} onSelect={() => setTool("comment")} />
          </ToolbarGroup>
        </Toolbar>
      </SceneCanvas>
      <DemoCursor cursor={cursor} />
    </SceneWindow>
  );
}

/** The thread's ✓ (Thread.tsx's ResolveGlyph). */
function ResolveGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className={cm.resolveGlyph}>
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" />
      <path d="M9.5 12.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The composer (editor/comments/Composer.tsx, without mentions and emoji): Enter sends, ⇧Enter breaks the line, Esc
 * cancels; [Send] is the round blue button, grey while empty.
 */
function Composer({ placeholder, label, autoFocus, onSubmit, onCancel }: { placeholder: string; label: string; autoFocus?: boolean; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const empty = !text.trim();
  const submit = () => {
    if (empty) return;
    onSubmit(text.trim());
    setText("");
  };
  return (
    <div className={`${cm.composer} ${cm["composer-reply"]}`} data-expanded={!empty || undefined}>
      <div className={cm.composerRow}>
        <textarea
          ref={field}
          className={cm.composerField}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          data-composer=""
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button type="button" className={cm.send} aria-label="Send" disabled={empty} onPointerDown={(e) => e.preventDefault()} onClick={submit}>
          <Icon name="16.arrow.up" />
        </button>
      </div>
    </div>
  );
}

interface CommentsActions {
  setOpen: (id: string | null) => void;
  setHover: (id: string | null) => void;
  post: (id: string, text: string, user?: Person) => void;
  resolve: (id: string) => void;
  setTool: (t: "move" | "comment") => void;
  setDraft: (d: { x: number; y: number } | null) => void;
  create: (text: string) => void;
  screen: (x: number, y: number) => { left: number; top: number };
}

/** Open Ben's pin, see Chloé reply, answer, resolve; then press C and leave a new comment on the photo. */
async function commentsDemo(run: SceneRun, a: CommentsActions) {
  try {
    await commentsSteps(run, a);
  } catch (e) {
    // Stopped mid-demo (scrolled away): letters the demo showed in a field were never the field's state
    for (const el of run.root.querySelectorAll("textarea")) el.value = "";
    throw e;
  }
}

async function commentsSteps(run: SceneRun, a: CommentsActions) {
  await run.wait(800);
  // Hovering a pin previews its thread; a click opens it
  const pin = run.$('[data-thread="t1"]');
  await run.move(pin);
  a.setHover("t1");
  await run.wait(1300);
  await run.click(pin);
  a.setHover(null);
  a.setOpen("t1");
  await run.wait(1100);
  a.post("t1", "Agreed, and a little bolder too.", CHLOE);
  await run.wait(1200);
  const field = run.$('[data-comment-thread="t1"] textarea');
  await run.click(field);
  await typeDemo(run, field as HTMLTextAreaElement | null, "Moved it up and made it 20px.");
  await run.wait(400);
  a.post("t1", "Moved it up and made it 20px.");
  clearField(field as HTMLTextAreaElement | null);
  await run.wait(1200);
  await run.click(run.$('[data-demo="resolve"]'));
  a.resolve("t1");
  await run.wait(1000);
  // Comment mode: C, then a click on the photo
  await run.click(run.$('[data-ds="ToolButton"] button[aria-label="Comment"]'));
  a.setTool("comment");
  await run.wait(500);
  const at = a.screen(232, 196);
  const canvas = run.$('[data-tool]');
  const off = canvas ? run.at(canvas, -canvas.clientWidth / 2, -canvas.clientHeight / 2) : { x: 0, y: 0 };
  await run.click({ x: off.x + at.left, y: off.y + at.top });
  a.setDraft({ x: 232, y: 196 });
  await run.wait(500);
  const composer = run.$("[data-comment-composer] textarea");
  await typeDemo(run, composer as HTMLTextAreaElement | null, "Could the lamp glow a bit warmer?");
  await run.wait(500);
  a.create("Could the lamp glow a bit warmer?");
  await run.wait(1600);
  a.setOpen(null);
  run.hide();
  await run.wait(900);
}

// The demo shows the letters arriving without dispatching input events (an input event is the visitor's touch, which
// stops the demo): the field's value is set directly, and React's state is written by the step after.
async function typeDemo(run: SceneRun, el: HTMLTextAreaElement | null, text: string) {
  if (!el) return;
  for (let i = 1; i <= text.length; i++) {
    el.value = text.slice(0, i);
    await run.wait(40);
  }
}
function clearField(el: HTMLTextAreaElement | null) {
  if (el) el.value = "";
}
