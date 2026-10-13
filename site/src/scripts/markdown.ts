// A small Markdown renderer for release notes (docs/site.md §2, /changelog): headings, lists (nested by
// indent), paragraphs, fenced code, **bold**, `code` and [links](https://…). Everything else is text,
// and every character of the input is escaped, so the output is safe for innerHTML.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Inline Markdown of one line or paragraph. */
export function renderInline(text: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  // NUL marks our placeholders, so none may come from the input.
  let s = text.replace(/\u0000/g, "");
  s = s.replace(/`([^`]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, href: string) => {
    // `href` is already escaped (&amp; and &quot; are right inside an attribute).
    if (!/^https?:\/\/[^\s]+$/i.test(href)) return all;
    return keep(`<a href="${href}" rel="noopener noreferrer">${label}</a>`);
  });
  s = s.replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(?=\S)(.+?)__/g, "<strong>$1</strong>");
  // Placeholders may nest (a code span inside a link label), so restore until none are left.
  for (let i = 0; i < 4 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[Number(n)]);
  return s;
}

interface ListFrame {
  indent: number;
  tag: "ul" | "ol";
  open: boolean; // an <li> is open
}

/** Block Markdown. Headings are shifted by `headingShift` (notes' `##` sit under the release's `<h2>`). */
export function renderMarkdown(md: string, headingShift = 1): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const lists: ListFrame[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${renderInline(para.join(" "))}</p>`);
    para = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      const l = lists.pop()!;
      if (l.open) out.push("</li>");
      out.push(`</${l.tag}>`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flushPara();
      closeLists();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      const level = Math.min(6, heading[1].length + headingShift);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, "  ").length;
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      closeLists(indent);
      let top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag !== tag) {
        closeLists(indent - 1);
        top = lists[lists.length - 1];
      }
      if (!top || top.indent < indent) {
        out.push(`<${tag}>`);
        top = { indent, tag, open: false };
        lists.push(top);
      } else if (top.open) {
        out.push("</li>");
      }
      out.push(`<li>${renderInline(item[3])}`);
      top.open = true;
      continue;
    }
    if (lists.length && /^\s+/.test(line)) {
      // A continuation line of the open list item.
      out.push(" " + renderInline(line.trim()));
      continue;
    }
    closeLists();
    para.push(line.trim());
  }
  flushPara();
  closeLists();
  return out.join("");
}
