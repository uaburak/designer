/**
 * Rich comment text (atlas 16 §2.6, Figma's `message_meta`): the composer's editable field read into segments — text
 * with bold / italic / strikethrough, links, @mentions (a non-editable chip), numbered and bulleted lists — and
 * segments written back into the field (editing a comment) or drawn as a message. The keys are Figma's: ⌘B ⌘I ⌘⇧X
 * ⌘K, ⌘⇧7 numbered list, ⌘⇧8 bulleted list. Inline code isn't a comment style.
 */
import type { ReactNode } from "react";
import { isListSegment, isMentionSegment, segmentsText, type CommentSegment, type CommentStyle } from "@shared/comments";
import styles from "./Comments.module.css";

const STYLE_TAGS: Record<string, CommentStyle> = { B: "b", STRONG: "b", I: "i", EM: "i", S: "s", STRIKE: "s", DEL: "s" };

type Inline = Exclude<CommentSegment, { children: unknown }>;

/** Next to each other with the same styles and link, two text segments are one */
function pushInline(out: Inline[], seg: Inline): void {
  const last = out[out.length - 1];
  if (last && !isMentionSegment(last) && !isMentionSegment(seg) && (last.styles ?? []).join() === (seg.styles ?? []).join() && last.link === seg.link) {
    last.t += seg.t;
    return;
  }
  out.push(seg);
}

function readInline(node: Node, styles: CommentStyle[], link: string | undefined, out: Inline[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? "").replace(/\u00a0/g, " ");
    if (t) pushInline(out, { t, ...(styles.length ? { styles: [...styles] } : {}), ...(link ? { link } : {}) });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset.mention) {
    out.push({ t: node.textContent ?? "", user_id: node.dataset.mention });
    return;
  }
  if (node.tagName === "BR") {
    pushInline(out, { t: "\n", ...(styles.length ? { styles: [...styles] } : {}) });
    return;
  }
  const style = STYLE_TAGS[node.tagName];
  const next = style && !styles.includes(style) ? [...styles, style] : styles;
  const href = node.tagName === "A" ? (node.getAttribute("href") ?? undefined) : link;
  const block = node.tagName === "DIV" || node.tagName === "P";
  if (block && out.length && !out[out.length - 1].t.endsWith("\n")) pushInline(out, { t: "\n" });
  for (const child of node.childNodes) readInline(child, next, href, out);
}

/** The field's content as segments (trailing line breaks left out) */
export function readSegments(root: HTMLElement): CommentSegment[] {
  const out: CommentSegment[] = [];
  let inline: Inline[] = [];
  const flush = () => {
    // A list starts on its own line: the break typed before it is no part of the text.
    const last = inline[inline.length - 1];
    if (last && !isMentionSegment(last)) {
      last.t = last.t.replace(/\n+$/, "");
      if (!last.t) inline.pop();
    }
    if (inline.length) out.push(...inline);
    inline = [];
  };
  for (const node of root.childNodes) {
    if (node instanceof HTMLElement && (node.tagName === "OL" || node.tagName === "UL")) {
      flush();
      const items: { children: CommentSegment[] }[] = [];
      for (const li of node.children) {
        const children: Inline[] = [];
        for (const c of li.childNodes) readInline(c, [], undefined, children);
        items.push({ children });
      }
      out.push({ styles: [node.tagName === "OL" ? "ol" : "ul"], children: items });
      continue;
    }
    readInline(node, [], undefined, inline);
  }
  flush();
  // The field's own trailing break (contenteditable keeps one) is no part of the message.
  const last = out[out.length - 1];
  if (last && !isListSegment(last) && !isMentionSegment(last)) {
    last.t = last.t.replace(/\n+$/, "");
    if (!last.t) out.pop();
  }
  return out;
}

/** Whether segments carry anything plain text doesn't (a style, a link or a list): only then are they kept */
export function isRich(segments: CommentSegment[]): boolean {
  return segments.some((s) => isListSegment(s) || (!isMentionSegment(s) && (!!s.styles?.length || !!s.link)));
}

function inlineNode(s: Inline): Node {
  if (isMentionSegment(s)) return mentionChip(s.user_id, s.t);
  let node: Node = textWithBreaks(s.t);
  for (const style of s.styles ?? []) {
    const el = document.createElement(style === "b" ? "b" : style === "i" ? "i" : "s");
    el.append(node);
    node = el;
  }
  if (s.link) {
    const a = document.createElement("a");
    a.href = s.link;
    a.append(node);
    node = a;
  }
  return node;
}

function textWithBreaks(t: string): Node {
  const parts = t.split("\n");
  if (parts.length === 1) return document.createTextNode(t);
  const frag = document.createDocumentFragment();
  parts.forEach((p, i) => {
    if (i) frag.append(document.createElement("br"));
    if (p) frag.append(document.createTextNode(p));
  });
  return frag;
}

/** An @mention in the field: one piece the caret steps over */
export function mentionChip(userId: string, text: string): HTMLElement {
  const span = document.createElement("span");
  span.dataset.mention = userId;
  span.contentEditable = "false";
  span.className = styles.mentionText;
  span.textContent = text;
  return span;
}

/** Fills the field with segments (an edited comment's message) */
export function writeSegments(root: HTMLElement, segments: CommentSegment[]): void {
  root.replaceChildren();
  for (const s of segments) {
    if (isListSegment(s)) {
      const list = document.createElement(s.styles[0] === "ol" ? "ol" : "ul");
      for (const item of s.children) {
        const li = document.createElement("li");
        for (const c of item.children) if (!isListSegment(c)) li.append(inlineNode(c));
        list.append(li);
      }
      root.append(list);
    } else root.append(inlineNode(s));
  }
}

/** The plain text Figma exports for the segments (`message`) */
export const plainText = (segments: CommentSegment[]) => segmentsText(segments);

function InlineView({ s }: { s: Inline }): ReactNode {
  if (isMentionSegment(s)) return <span className={styles.mentionText}>{s.t}</span>;
  let node: ReactNode = s.t;
  if (s.styles?.includes("s")) node = <s>{node}</s>;
  if (s.styles?.includes("i")) node = <i>{node}</i>;
  if (s.styles?.includes("b")) node = <b className={styles.bold}>{node}</b>;
  if (s.link)
    node = (
      <a className={styles.link} href={s.link} target="_blank" rel="noreferrer noopener">
        {node}
      </a>
    );
  return node;
}

/** A message drawn from its segments (bold, italic, strikethrough; links and mentions in the "lightbold" brand weight) */
export function SegmentsView({ segments }: { segments: CommentSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        isListSegment(s) ? (
          s.styles[0] === "ol" ? (
            <ol key={i} className={styles.msgList}>
              {s.children.map((item, j) => (
                <li key={j}>{item.children.map((c, k) => (isListSegment(c) ? null : <InlineView key={k} s={c} />))}</li>
              ))}
            </ol>
          ) : (
            <ul key={i} className={styles.msgList}>
              {s.children.map((item, j) => (
                <li key={j}>{item.children.map((c, k) => (isListSegment(c) ? null : <InlineView key={k} s={c} />))}</li>
              ))}
            </ul>
          )
        ) : (
          <InlineView key={i} s={s} />
        ),
      )}
    </>
  );
}

/** Figma's formatting keys in the composer: the command each runs on the selection, or null */
export function formatKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): "bold" | "italic" | "strikeThrough" | "link" | "insertOrderedList" | "insertUnorderedList" | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  if (!e.shiftKey && e.code === "KeyB") return "bold";
  if (!e.shiftKey && e.code === "KeyI") return "italic";
  if (!e.shiftKey && e.code === "KeyK") return "link";
  if (e.shiftKey && e.code === "KeyX") return "strikeThrough";
  if (e.shiftKey && e.code === "Digit7") return "insertOrderedList";
  if (e.shiftKey && e.code === "Digit8") return "insertUnorderedList";
  return null;
}
