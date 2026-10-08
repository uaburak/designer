// Evaluated in the page: dumps every open popup (popover, menu, listbox) like the live capture's POPUPS section —
// "@x,y wxh" absolute in the viewport, then each line relative to the popup.
(() => {
  const hex = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const h = (v) => Math.round(v).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b) + (a < 1 ? h(a * 255) : "");
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const roots = [...document.querySelectorAll('[data-ds="Popover"], [role="menu"], [role="listbox"]')].filter(
    (el) => visible(el) && !el.closest('[data-panel]') && !el.parentElement?.closest('[data-ds="Popover"], [role="menu"], [role="listbox"]'),
  );
  const out = ["POPUPS"];
  for (const root of roots) {
    const R = root.getBoundingClientRect();
    out.push(`@${Math.round(R.left)},${Math.round(R.top)} ${Math.round(R.width)}x${Math.round(R.height)}`);
    const box = (r) => `${Math.round(r.left - R.left)},${Math.round(r.top - R.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
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
        if (el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") line += " CHECKED";
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
    };
    walk(root);
  }
  return out.join("\n");
})();
