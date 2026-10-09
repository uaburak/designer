/**
 * "Component configuration" (the component, set and variant header's button; live popovers/component-configuration.txt):
 * a 320-wide popover left of the panel, level with its top — "Description" (rich text: Bold ⌘B, Italic ⌘I,
 * Strikethrough ⌘⇧X, Header 1, Bulleted list, Ordered list, Link ⌘⇧U, Code ⌘⇧C, Code block ⌘⇧⌥C; placeholder "How to
 * use this component") and "Link" (Link to documentation). The description is kept as Markdown in the node's
 * `description` (richText.ts), the link as its `symbolLinks` (help "Add descriptions to styles, components, and
 * variables": a description and a link to documentation). Both are written when the field is left (one undo step).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IS_MAC, Popover, ToggleIconButton, keys, type IconName } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { setDescription } from "../../components";
import type { CNode } from "../../model/components";
import { htmlToMarkdown, markdownToHtml } from "./richText";
import styles from "./ComponentConfiguration.module.css";

type Mark = "bold" | "italic" | "strike" | "h1" | "ul" | "ol" | "link" | "code" | "pre";

/** Live's toolbar, left to right, with its tooltips' keys (live writes ⌘ first: "⌘⇧X"). */
export const DESCRIPTION_TOOLS: { mark: Mark; label: string; icon: IconName; mac?: string; keys?: string[] }[] = [
  { mark: "bold", label: "Bold", icon: "24.text.bold", mac: "⌘B", keys: ["mod", "B"] },
  { mark: "italic", label: "Italic", icon: "24.text.italic", mac: "⌘I", keys: ["mod", "I"] },
  { mark: "strike", label: "Strikethrough", icon: "24.text.strikethrough", mac: "⌘⇧X", keys: ["mod", "shift", "X"] },
  { mark: "h1", label: "Header 1", icon: "24.text.heading" },
  { mark: "ul", label: "Bulleted list", icon: "24.text.list-bulleted" },
  { mark: "ol", label: "Ordered list", icon: "24.text.list-numbered" },
  { mark: "link", label: "Link", icon: "24.link", mac: "⌘⇧U", keys: ["mod", "shift", "U"] },
  { mark: "code", label: "Code", icon: "24.text.code", mac: "⌘⇧C", keys: ["mod", "shift", "C"] },
  { mark: "pre", label: "Code block", icon: "24.text.code-block", mac: "⌘⇧⌥C", keys: ["mod", "shift", "alt", "C"] },
];

/** The documentation link a component carries (its first `symbolLinks` entry). */
export function documentationLink(n: CNode): string {
  return ((n as { symbolLinks?: { uri?: string }[] }).symbolLinks ?? [])[0]?.uri ?? "";
}

export function setDocumentationLink(ed: EditorController, owner: CNode, uri: string): void {
  const value = uri.trim();
  ed.setProps([owner.guid], { symbolLinks: value ? [{ uri: value, displayName: "", displayText: "" }] : [] } as never, "Edit documentation link");
}

/** Where the popover goes: left of the panel, level with the panel's top (live 880, 81 at 1440 × 900). */
function panelTop(anchor: HTMLElement): DOMRect {
  // (The panel's content: the tab panel under the panel's own header.)
  const panel = (anchor.closest<HTMLElement>('[role="tabpanel"]') ?? anchor.closest<HTMLElement>("[data-panel]"))?.getBoundingClientRect();
  return panel ? new DOMRect(panel.left + 1, panel.top, 0, 0) : anchor.getBoundingClientRect();
}

export function ComponentConfiguration({ owner, anchor, onClose }: { owner: CNode; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const [rect] = useState(() => panelTop(anchor));
  const [link, setLink] = useState(documentationLink(owner));
  const linkSaved = useRef(documentationLink(owner));
  const cancelled = useRef(false);
  const flushDescription = useRef<() => void>(() => {});
  const saveLink = () => {
    if (cancelled.current || link.trim() === linkSaved.current) {
      cancelled.current = false;
      return;
    }
    linkSaved.current = link.trim();
    setDocumentationLink(ed, owner, link);
  };
  return (
    <Popover
      anchor={rect}
      title="Component configuration"
      width={320}
      label="Component configuration"
      onClose={() => {
        flushDescription.current();
        saveLink();
        onClose();
      }}
    >
      <div className={styles.body} data-component-configuration={owner.guid}>
        <span className={styles.label}>Description</span>
        <RichTextField value={owner.description ?? ""} placeholder="How to use this component" flushRef={flushDescription} onCommit={(md) => setDescription(ed, owner, md)} />
        <span className={styles.label}>Link</span>
        <input
          className={styles.link}
          aria-label="Link to documentation"
          placeholder="Link to documentation"
          value={link}
          spellCheck={false}
          onChange={(e) => setLink(e.target.value)}
          onBlur={saveLink}
          onKeyDown={(e) => {
            // (Esc on an unchanged field reaches the popover: it closes.)
            if (e.key !== "Escape" || link !== linkSaved.current) e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              // The first Esc reverts the field (live fields), the popover's Esc closes it.
              if (link !== linkSaved.current) {
                e.preventDefault();
                cancelled.current = true;
                setLink(linkSaved.current);
              }
            }
          }}
        />
      </div>
    </Popover>
  );
}

/** The marks around the caret (the toolbar's pressed state). */
function marksAt(editor: HTMLElement): Set<Mark> {
  const out = new Set<Mark>();
  const sel = document.getSelection();
  const node = sel?.anchorNode;
  if (!node || !editor.contains(node)) return out;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const within = (tag: string) => !!el?.closest(tag) && editor.contains(el.closest(tag));
  const state = (cmd: string) => {
    try {
      return document.queryCommandState(cmd);
    } catch {
      return false;
    }
  };
  if (state("bold") || within("b, strong")) out.add("bold");
  if (state("italic") || within("i, em")) out.add("italic");
  if (state("strikeThrough") || within("s, strike, del")) out.add("strike");
  if (within("h1")) out.add("h1");
  if (within("ul")) out.add("ul");
  if (within("ol")) out.add("ol");
  if (within("a")) out.add("link");
  if (within("code")) out.add("code");
  if (within("pre")) out.add("pre");
  return out;
}

const exec = (cmd: string, value?: string) => {
  try {
    document.execCommand(cmd, false, value);
  } catch {
    // (happy-dom and old engines have no editing commands: the text stays as it is)
  }
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The description's editor: contentEditable over the panel's field look, the toolbar along its bottom. */
export function RichTextField({ value, placeholder, onCommit, flushRef }: { value: string; placeholder: string; onCommit: (markdown: string) => void; flushRef: { current: () => void } }) {
  const editor = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!value.trim());
  const [marks, setMarks] = useState<Set<Mark>>(new Set());
  const [linking, setLinking] = useState<string | null>(null);
  const saved = useRef<Range | null>(null);
  useLayoutEffect(() => {
    const el = editor.current;
    if (!el || el === document.activeElement) return;
    el.innerHTML = value ? markdownToHtml(value) : "";
    setEmpty(!value.trim());
  }, [value]);
  useEffect(() => {
    const update = () => editor.current && setMarks(marksAt(editor.current));
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  const commit = () => {
    const el = editor.current;
    if (!el) return;
    const md = htmlToMarkdown(el);
    if (md !== value) onCommit(md);
  };
  useEffect(() => {
    flushRef.current = commit;
  });
  const changed = () => {
    const el = editor.current;
    if (!el) return;
    setEmpty(!(el.textContent ?? "").trim() && !el.querySelector("li, pre, h1"));
    setMarks(marksAt(el));
  };
  const apply = (mark: Mark) => {
    const el = editor.current;
    if (!el) return;
    el.focus();
    const on = marksAt(el).has(mark);
    switch (mark) {
      case "bold":
        exec("bold");
        break;
      case "italic":
        exec("italic");
        break;
      case "strike":
        exec("strikeThrough");
        break;
      case "h1":
        exec("formatBlock", on ? "div" : "h1");
        break;
      case "pre":
        exec("formatBlock", on ? "div" : "pre");
        break;
      case "ul":
        exec("insertUnorderedList");
        break;
      case "ol":
        exec("insertOrderedList");
        break;
      case "code": {
        const sel = document.getSelection();
        const at = sel?.anchorNode;
        const code = (at?.nodeType === 1 ? (at as Element) : at?.parentElement)?.closest("code");
        if (code && el.contains(code)) code.replaceWith(document.createTextNode(code.textContent ?? ""));
        else if (sel && !sel.isCollapsed) exec("insertHTML", `<code>${escapeHtml(sel.toString())}</code>`);
        break;
      }
      case "link": {
        if (on) exec("unlink");
        else {
          const sel = document.getSelection();
          saved.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
          setLinking("");
        }
        break;
      }
    }
    changed();
  };
  const finishLink = (url: string | null) => {
    const el = editor.current;
    setLinking(null);
    if (!el) return;
    el.focus();
    const sel = document.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    const uri = url?.trim();
    if (uri) {
      if (sel && sel.isCollapsed) exec("insertHTML", `<a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a>`);
      else exec("createLink", uri);
    }
    saved.current = null;
    changed();
  };
  const shortcut = (t: (typeof DESCRIPTION_TOOLS)[number]) => (t.mac && IS_MAC ? t.mac : t.keys ? keys(t.keys) : undefined);
  return (
    <div className={styles.field} data-description-editor="">
      <div className={styles.editorWrap}>
        {empty && <span className={styles.placeholder}>{placeholder}</span>}
        <div
          ref={editor}
          className={styles.editor}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Description"
          spellCheck={false}
          onInput={changed}
          onBlur={(e) => {
            // The link field and the toolbar keep the edit going; leaving the description writes it.
            if (e.relatedTarget instanceof Node && e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget)) return;
            commit();
          }}
          onKeyDown={(e) => {
            // The canvas's keys stay out of the description (Esc reaches the popover: it closes, the text kept).
            if (e.key !== "Escape") e.stopPropagation();
            const mod = e.metaKey || e.ctrlKey;
            if (!mod) return;
            const k = e.key.toLowerCase();
            const mark: Mark | null = !e.shiftKey && k === "b" ? "bold" : !e.shiftKey && k === "i" ? "italic" : e.shiftKey && k === "x" ? "strike" : e.shiftKey && k === "u" ? "link" : e.shiftKey && e.altKey && (k === "c" || e.code === "KeyC") ? "pre" : e.shiftKey && k === "c" ? "code" : null;
            if (!mark) return;
            e.preventDefault();
            apply(mark);
          }}
        />
      </div>
      {linking !== null ? (
        <div className={styles.toolbar}>
          <input
            className={styles.linkDraft}
            aria-label="Paste a link"
            placeholder="Paste a link"
            autoFocus
            value={linking}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") finishLink(linking);
              if (e.key === "Escape") finishLink(null);
            }}
            onBlur={() => linking !== null && finishLink(linking)}
          />
        </div>
      ) : (
        <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
          {DESCRIPTION_TOOLS.map((t) => (
            <ToggleIconButton
              key={t.mark}
              icon={t.icon}
              label={t.label}
              shortcut={shortcut(t)}
              tone="secondary"
              pressed={marks.has(t.mark)}
              onMouseDown={(e) => e.preventDefault()}
              onPressedChange={() => apply(t.mark)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
