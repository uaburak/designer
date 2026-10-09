/**
 * A component's description as rich text (live popovers/component-configuration.txt: Bold, Italic, Strikethrough,
 * Header 1, Bulleted list, Ordered list, Link, Code, Code block), kept in the node's `description` as Markdown — the
 * form Figma's API gives it (`descriptionMarkdown`); text without marks stays plain text. `plainDescription` drops the
 * marks where a description is shown as text.
 */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One line's inline marks: `code`, **bold**, *italic*, ~~strike~~, [text](url). */
function inline(text: string): string {
  const out: string[] = [];
  let rest = text;
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^`([^`]+)`/, (m) => `<code>${escapeHtml(m[1])}</code>`],
    [/^\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/, (m) => `<b>${inline(m[1])}</b>`],
    [/^~~(.+?)~~/, (m) => `<s>${inline(m[1])}</s>`],
    [/^\*([^*]+)\*/, (m) => `<i>${inline(m[1])}</i>`],
    [/^_([^_]+)_/, (m) => `<i>${inline(m[1])}</i>`],
    [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m) => `<a href="${escapeHtml(m[2])}">${inline(m[1])}</a>`],
  ];
  outer: while (rest) {
    for (const [re, html] of rules) {
      const m = re.exec(rest);
      if (m) {
        out.push(html(m));
        rest = rest.slice(m[0].length);
        continue outer;
      }
    }
    const next = rest.slice(1).search(/[`*~_[]/);
    const take = next < 0 ? rest.length : next + 1;
    out.push(escapeHtml(rest.slice(0, take)));
    rest = rest.slice(take);
  }
  return out.join("");
}

/** Markdown (the subset the toolbar writes) → the editor's HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        items.push(`<li>${inline(m[3])}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const h = /^#\s+(.*)$/.exec(line);
    if (h) out.push(`<h1>${inline(h[1])}</h1>`);
    else out.push(`<div>${line ? inline(line) : "<br>"}</div>`);
    i++;
  }
  return out.join("");
}

/** The editor's DOM → Markdown. */
export function htmlToMarkdown(root: Node): string {
  const marks = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\u00a0/g, " ");
    if (node.nodeType !== 1) return "";
    const el = node as HTMLElement;
    const inner = () => [...el.childNodes].map(marks).join("");
    const tag = el.tagName.toLowerCase();
    const wrap = (m: string) => {
      const t = inner();
      return t.trim() ? `${m}${t}${m}` : t;
    };
    switch (tag) {
      case "b":
      case "strong":
        return wrap("**");
      case "i":
      case "em":
        return wrap("*");
      case "s":
      case "strike":
      case "del":
        return wrap("~~");
      case "code":
        return `\`${el.textContent ?? ""}\``;
      case "a": {
        const href = el.getAttribute("href") ?? "";
        return href ? `[${inner()}](${href})` : inner();
      }
      case "br":
        return "\n";
      case "span": {
        // Chromium's execCommand styles marks with spans (bold / italic / line-through) in some cases.
        const s = el.style;
        let t = inner();
        if (t.trim()) {
          if (s.fontWeight === "bold" || Number(s.fontWeight) >= 600) t = `**${t}**`;
          if (s.fontStyle === "italic") t = `*${t}*`;
          if (s.textDecoration.includes("line-through") || s.textDecorationLine?.includes("line-through")) t = `~~${t}~~`;
        }
        return t;
      }
      default:
        return inner();
    }
  };
  const lines: string[] = [];
  const block = (node: Node) => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? "";
      if (t.trim()) lines.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      let n = 1;
      for (const li of el.children) lines.push(`${tag === "ol" ? `${n++}.` : "-"} ${marks(li).replace(/\n+$/, "")}`);
      return;
    }
    if (tag === "pre") {
      lines.push("```", (el.textContent ?? "").replace(/\n$/, ""), "```");
      return;
    }
    if (tag === "h1") {
      lines.push(`# ${marks(el).trim()}`);
      return;
    }
    if (tag === "div" || tag === "p") {
      const text = marks(el);
      lines.push(...text.replace(/\n$/, "").split("\n"));
      return;
    }
    lines.push(marks(el));
  };
  // Inline content directly in the root (the first line before any block) counts as a line of its own.
  let pending: Node[] = [];
  const flushInline = () => {
    if (!pending.length) return;
    const text = pending.map(marks).join("");
    lines.push(...text.split("\n"));
    pending = [];
  };
  for (const node of root.childNodes) {
    const isBlock = node.nodeType === 1 && /^(div|p|ul|ol|pre|h1)$/i.test((node as HTMLElement).tagName);
    if (isBlock) {
      flushInline();
      block(node);
    } else pending.push(node);
  }
  flushInline();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/** A description's text without its marks (search, tooltips). */
export function plainDescription(md: string): string {
  return md
    .replace(/^```.*$/gm, "")
    .replace(/^#\s+/gm, "")
    .replace(/^(\s*)([-*]|\d+\.)\s+/gm, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
