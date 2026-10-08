// Evaluated in the page: dumps the Design tab like the live capture of Figma (x,y wxh relative to the panel body).
(() => {
  const root = document.querySelector('[data-panel="right"] [role="tabpanel"]');
  const R = root.getBoundingClientRect();
  const ox = R.left, oy = R.top - root.scrollTop;
  const hex = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const h = (v) => Math.round(v).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b) + (a < 1 ? h(a * 255) : "");
  };
  const out = [];
  const box = (r) => `${Math.round(r.left - ox)},${Math.round(r.top - oy)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const walk = (el) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label");
    const interactive = /^(button|input|textarea|select)$/.test(tag) || el.getAttribute("role");
    const bg = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent" ? hex(s.backgroundColor) : null;
    if (r.width > 0 && r.height > 0 && (interactive || bg || label)) {
      let line = `${box(r)} ${el.getAttribute("role") ?? tag}`;
      if (tag === "input") line += ` =${el.type === "checkbox" ? (el.checked ? "on" : "off") : el.value}`;
      if (label) line += ` [${label}]`;
      if (el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true") line += " CHECKED";
      if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " DISABLED";
      if (bg) line += ` bg=${bg}`;
      if (s.borderRadius !== "0px") line += ` r=${s.borderRadius}`;
      out.push(line);
    }
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(c);
        const tr = range.getBoundingClientRect();
        if (tr.width > 0) out.push(`${box(tr)} "${c.textContent.trim()}" ${s.fontSize}/${s.fontWeight} ${hex(s.color)}`);
      } else if (c.nodeType === 1) walk(c);
    }
    if (tag === "input" && el.value && el.type !== "checkbox") {
      // the value's text, as the live capture lists it next to the field
    }
  };
  walk(root);
  return out.join("\n");
})();
