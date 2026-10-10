/**
 * A small XML reader for pasted SVG (docs/desktop.md §13): elements, attributes, text and CDATA, the five XML
 * entities, character references and the entities an internal DOCTYPE subset declares (Illustrator's older SVGs
 * write `<!ENTITY ns_svg "…">` and use `&ns_svg;` in attributes). No namespaces beyond dropping an element's prefix,
 * no validation. Pure, so main, the views and tests share it.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text and CDATA, joined (what `<style>` holds). */
  text: string;
}

const BUILTIN: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string, entities: Record<string, string>): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return BUILTIN[e] ?? entities[e] ?? m;
  });
}

/** The document's root element, or null when there is none. */
export function parseXml(src: string): XmlElement | null {
  const entities: Record<string, string> = {};
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decode(src.slice(i), entities);
      break;
    }
    if (lt > i) top.text += decode(src.slice(i, lt), entities);
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith("<!", lt)) {
      // DOCTYPE (with an internal subset in [ … ]) or another declaration.
      let j = lt + 2;
      let depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      const decl = src.slice(lt, j);
      for (const m of decl.matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) entities[m[1]] = m[2] ?? m[3] ?? "";
      i = j + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = localName(src.slice(lt + 2, end < 0 ? n : end).trim());
      // Close up to the matching element (tolerating a missing end tag in between).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote = "";
      for (; j < n; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(body);
      if (!nameMatch) {
        i = j + 1;
        continue;
      }
      const el: XmlElement = { name: localName(nameMatch[0]), attrs: {}, children: [], text: "" };
      for (const m of body.slice(nameMatch[0].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[m[1]] = decode(m[2] ?? m[3] ?? "", entities);
      top.children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }
  return root.children.find((c) => c.name === "svg") ?? root.children[0] ?? null;
}

const localName = (qname: string) => {
  const colon = qname.indexOf(":");
  return colon >= 0 ? qname.slice(colon + 1) : qname;
};
