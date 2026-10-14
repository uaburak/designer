// The DOM walker, run in the page by capture.mjs (page.evaluate with this file's source): every visible element as a
// box (fills, borders, radius, shadows, flex layout, padding, clip), its text as text runs, the ds icons by name, other
// SVGs, images and canvases as pictures. Colours are read twice — this pass (light) and `readDark()` after the theme
// switch — so build.mjs can find each colour's token by its light and dark value together.
/* eslint-disable */
(() => {
  const U = (window.__uikit = window.__uikit || {});
  U.els = [];
  U.texts = [];

  const hex = (c) => {
    if (!c || c === "transparent") return null;
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    let r, g, b, a = 1;
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      [r, g, b] = p;
      if (p.length > 3) a = p[3];
    } else if ((m = /^color\(srgb ([^)]+)\)$/.exec(c))) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      [r, g, b] = p.slice(0, 3).map((v) => v * 255);
      if (p.length > 3) a = p[3];
    } else return null;
    if (a === 0) return null;
    const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b) + (a < 1 ? h(a * 255) : "");
  };
  const px = (v) => (v && v !== "normal" && v !== "auto" ? parseFloat(v) : null);

  const shadows = (s) => {
    if (!s || s === "none") return [];
    const parts = s.split(/,(?![^(]*\))/);
    return parts
      .map((p) => {
        const inset = /inset/.test(p);
        const col = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(p);
        const nums = p.replace(/(rgba?\([^)]*\)|color\([^)]*\))/, "").replace("inset", "").trim().split(/\s+/).map(parseFloat);
        return { inset, x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color: hex(col ? col[1] : "") };
      })
      .filter((x) => x.color);
  };

  const modClasses = (el) => [...el.classList].map((c) => c.replace(/^_?([A-Za-z0-9]+?)_([A-Za-z0-9-]+?)_[A-Za-z0-9_-]{5}$/, "$1.$2"));

  const colorsOf = (el, cs) => ({
    bg: hex(cs.backgroundColor),
    bt: hex(cs.borderTopColor),
    br: hex(cs.borderRightColor),
    bb: hex(cs.borderBottomColor),
    bl: hex(cs.borderLeftColor),
    oc: hex(cs.outlineColor),
    fg: hex(cs.color),
    ph: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? hex(getComputedStyle(el, "::placeholder").color) : null,
    sh: shadows(cs.boxShadow).map((s) => s.color),
    pb: pseudoColors(el, "::before"),
    pa: pseudoColors(el, "::after"),
  });
  const pseudoColors = (el, which) => {
    const p = getComputedStyle(el, which);
    return p && p.content !== "none" ? [hex(p.backgroundColor), hex(p.borderTopColor) || hex(p.borderLeftColor)] : null;
  };

  /** A pseudo-element's box when it is drawn (content, a fill or a border) and positioned absolutely in px. */
  const pseudo = (el, which, r, idx) => {
    const cs = getComputedStyle(el, which);
    if (!cs || cs.content === "none" || cs.display === "none") return null;
    const bg = hex(cs.backgroundColor);
    const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderRightWidth);
    if (!bg && !bw) return null;
    if (cs.position !== "absolute") return null;
    const L = px(cs.left), T = px(cs.top), R = px(cs.right), B = px(cs.bottom), W = px(cs.width), H = px(cs.height);
    const w = W ?? (L != null && R != null ? r.width - L - R : null);
    const h = H ?? (T != null && B != null ? r.height - T - B : null);
    if (!w || !h) return null;
    const x = L ?? (R != null ? r.width - R - w : 0);
    const y = T ?? (B != null ? r.height - B - h : 0);
    return {
      kind: "box",
      tag: which,
      name: which === "::before" ? "before" : "after",
      x: r.left + x, y: r.top + y, w, h,
      bg, op: parseFloat(cs.opacity),
      bw: [parseFloat(cs.borderTopWidth), parseFloat(cs.borderRightWidth), parseFloat(cs.borderBottomWidth), parseFloat(cs.borderLeftWidth)],
      bc: hex(cs.borderTopColor) || hex(cs.borderLeftColor),
      rad: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => Math.min(parseFloat(v) || 0, Math.min(w, h) / 2)),
      abs: true,
      pseudoOf: idx,
      which,
      children: [],
    };
  };

  const iconKeys = U.iconKeys || {};
  const iconName = (svg) => {
    const ds = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    return iconKeys[ds.join("\n")] || null;
  };

  /** An SVG's markup with its computed paint inlined (classes don't travel), drawn later as a picture. */
  const svgMarkup = (svg) => {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll("*")];
    const dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((s, i) => {
      const cs = getComputedStyle(s);
      const d = dst[i];
      for (const k of ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "color"]) {
        const v = cs.getPropertyValue(k);
        if (v) d.style.setProperty(k, v);
      }
    });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const r = svg.getBoundingClientRect();
    clone.setAttribute("width", r.width);
    clone.setAttribute("height", r.height);
    return clone.outerHTML;
  };

  const lineRects = (range) => {
    const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const tops = new Set(rs.map((r) => Math.round(r.top)));
    return tops.size;
  };

  const textStyle = (cs) => ({
    font: cs.fontFamily,
    size: parseFloat(cs.fontSize),
    weight: Number(cs.fontWeight) || 400,
    lh: px(cs.lineHeight),
    ls: px(cs.letterSpacing) || 0,
    align: cs.textAlign,
    tt: cs.textTransform,
    td: cs.textDecorationLine,
    ws: cs.whiteSpace,
    ell: cs.textOverflow === "ellipsis",
    italic: cs.fontStyle === "italic",
  });

  const visibleIn = (r, clip) => !clip || (r.right > clip.left && r.left < clip.right && r.bottom > clip.top && r.top < clip.bottom);

  function walk(el, clip, depth) {
    if (el.nodeType !== 1) return null;
    if (el.hasAttribute && (el.hasAttribute("data-uikit-skip") || el.id === "uikit-skip")) return null;
    const tag = el.tagName;
    if (["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "BR"].includes(tag)) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return null;
    const r = el.getBoundingClientRect();
    const zero = r.width === 0 || r.height === 0 || cs.display === "contents";
    if (!zero && !visibleIn(r, clip)) return null;
    const idx = U.els.length;
    U.els.push(el);
    const op = parseFloat(cs.opacity);
    const node = {
      i: idx,
      tag: tag.toLowerCase(),
      ds: el.dataset ? el.dataset.ds || null : null,
      cls: modClasses(el),
      label: el.getAttribute("aria-label") || el.getAttribute("title") || null,
      state: [el.getAttribute("aria-pressed"), el.getAttribute("aria-checked"), el.getAttribute("aria-selected"), el.getAttribute("aria-expanded"), el.disabled ? "disabled" : null, el.getAttribute("data-state")].filter(Boolean).join(",") || null,
      gid: el.dataset ? el.dataset.galleryId || null : null,
      x: r.left, y: r.top, w: r.width, h: r.height,
      op: op < 1 ? op : undefined,
      c: colorsOf(el, cs),
      children: [],
    };
    if (op === 0) return null;
    if (tag === "svg" || el instanceof SVGElement) {
      if (tag !== "svg") return null;
      if (r.width === 0 || r.height === 0) return null;
      const name = el.dataset.ds === "Icon" ? iconName(el) : null;
      if (name) {
        node.kind = "icon";
        node.icon = name;
        const tf = cs.transform;
        const m = /^matrix\(([^)]+)\)$/.exec(tf || "");
        if (m) {
          const [a, b] = m[1].split(",").map(Number);
          const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
          if (deg) node.rot = deg;
        }
      } else {
        node.kind = "svg";
        node.svg = svgMarkup(el);
      }
      return node;
    }
    if (tag === "IMG") {
      node.kind = "img";
      node.src = el.currentSrc || el.src;
      node.fit = cs.objectFit;
      node.rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => Math.min(parseFloat(v) || 0, Math.min(r.width, r.height) / 2));
      return node;
    }
    if (tag === "CANVAS" || tag === "VIDEO" || tag === "IFRAME") {
      node.kind = "raster";
      return node;
    }
    node.kind = "box";
    node.d = cs.display;
    node.pos = cs.position;
    node.fd = cs.flexDirection;
    node.fw = cs.flexWrap;
    node.jc = cs.justifyContent;
    node.ai = cs.alignItems;
    node.as = cs.alignSelf;
    node.fg = parseFloat(cs.flexGrow) || 0;
    node.fb = cs.flexBasis;
    node.gap = [px(cs.rowGap) || 0, px(cs.columnGap) || 0];
    node.pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
    node.bw = cs.borderTopStyle === "none" && cs.borderLeftStyle === "none" && cs.borderRightStyle === "none" && cs.borderBottomStyle === "none" ? [0, 0, 0, 0] : [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((v, k) => ([cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle][k] === "none" ? 0 : parseFloat(v)));
    node.mar = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(parseFloat);
    node.ow = cs.outlineStyle !== "none" ? parseFloat(cs.outlineWidth) : 0;
    node.oo = parseFloat(cs.outlineOffset) || 0;
    node.rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => {
      const n = v.endsWith("%") ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : parseFloat(v) || 0;
      return Math.min(n, Math.min(r.width, r.height) / 2);
    });
    node.sh = shadows(cs.boxShadow);
    node.clip = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    node.bgi = cs.backgroundImage !== "none" ? cs.backgroundImage : null;
    node.z = cs.zIndex;
    node.tf = cs.transform !== "none" ? cs.transform : null;
    node.ts = textStyle(cs);
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["checkbox", "radio", "range", "color", "file", "hidden"].includes(type)) {
        if (type === "hidden" || cs.opacity === "0" || r.width === 0) return null;
      } else {
        const value = tag === "SELECT" ? el.options[el.selectedIndex]?.text || "" : el.value;
        const ph = !value && el.placeholder;
        const chars = value || el.placeholder || "";
        if (chars) {
          const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
          const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
          const lh = px(cs.lineHeight) || Math.round(parseFloat(cs.fontSize) * 1.25);
          node.children.push({
            kind: "text",
            chars,
            ph: !!ph,
            x: r.left + pl,
            y: tag === "TEXTAREA" ? r.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth) : r.top + (r.height - lh) / 2,
            w: Math.max(1, r.width - pl - pr),
            h: lh,
            fixed: true,
            multi: tag === "TEXTAREA",
            ts: { ...textStyle(cs), lh },
            ci: idx,
            c: node.c,
            useph: !!ph,
          });
        }
      }
      return node;
    }
    const before = pseudo(el, "::before", r, idx);
    if (before) node.children.push(before);
    const childClip = node.clip && !zero ? intersect(clip, r) : clip;
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) {
        const t = ch.textContent;
        if (!t || !t.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(ch);
        const rr = range.getBoundingClientRect();
        if (rr.width === 0 || !visibleIn(rr, childClip)) continue;
        const lines = lineRects(range);
        node.children.push({ kind: "text", chars: cs.whiteSpace.startsWith("pre") ? t : t.replace(/\s+/g, " ").trim(), x: rr.left, y: rr.top, w: rr.width, h: rr.height, lines, ts: textStyle(cs), ci: idx, c: node.c });
      } else if (ch.nodeType === 1) {
        const n = walk(ch, childClip, depth + 1);
        if (Array.isArray(n)) node.children.push(...n);
        else if (n) node.children.push(n);
      }
    }
    const after = pseudo(el, "::after", r, idx);
    if (after) node.children.push(after);
    // A box with nothing to draw and nothing inside is dropped.
    const drawn = node.c.bg || node.bw.some((w) => w > 0) || node.sh.length || node.bgi || node.ow;
    if (!drawn && !node.children.length && !node.ds) return null;
    // A box of no size that draws nothing (display: contents, a portal root): its children join its parent.
    if (zero && !drawn) return node.children;
    if (r.width === 0 && r.height === 0 && !node.children.length) return null;
    return node;
  }

  function intersect(a, r) {
    const b = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    if (!a) return b;
    return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  }

  U.capture = (selector, viewportClip) => {
    U.els = [];
    const root = typeof selector === "string" ? document.querySelector(selector) : selector;
    const clip = viewportClip ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : null;
    const t = walk(root, clip, 0);
    return Array.isArray(t) ? null : t;
  };
  U.captureAll = (selector) => {
    U.els = [];
    return [...document.querySelectorAll(selector)].map((e) => walk(e, null, 0));
  };
  U.walkOne = (el) => walk(el, null, 0);
  /** The colours of every captured element again (after a theme switch). */
  U.readColors = () => U.els.map((el) => colorsOf(el, getComputedStyle(el)));
})();
