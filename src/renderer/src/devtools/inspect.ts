// TEMPORARY developer tool (see DevPanel.tsx): picking an element like the browser's Inspect — a hovered element is
// outlined with its name, a click picks it (the app never sees that click), Esc stops. Plus naming an element and a
// selector that matches every element like it (e.g. every file card).

/** The element's own name: its ds component, else its CSS module class without the hash, else its tag. */
export function nameOf(el: Element): string {
  const ds = el.getAttribute("data-ds");
  if (ds) return ds;
  const cls = moduleClass(el);
  if (cls) return cls.replace(/^_/, "").replace(/_[a-z0-9]{5}(_\d+)?$/i, "");
  return el.tagName.toLowerCase();
}

/** The first class that looks like a CSS module's (`_name_hash` in development, else any class). */
function moduleClass(el: Element): string | null {
  const list = Array.from(el.classList);
  return list.find((c) => /^_[A-Za-z]\w*_[a-z0-9]{5}/i.test(c)) ?? list[0] ?? null;
}

const part = (el: Element): string | null => {
  const ds = el.getAttribute("data-ds");
  if (ds) return `[data-ds="${ds}"]`;
  const cls = moduleClass(el);
  return cls ? `.${CSS.escape(cls)}` : null;
};

/**
 * A selector for "elements like this one": its own name, narrowed by its nearest named ancestors until it no longer
 * matches things elsewhere that aren't the same kind (at most three levels; never positional, so a style edit on one
 * file card reaches every file card).
 */
export function selectorFor(el: Element): string {
  const own = part(el) ?? el.tagName.toLowerCase();
  let sel = own;
  let up = el.parentElement;
  for (let depth = 0; up && up !== document.body && depth < 3; up = up.parentElement) {
    const p = part(up);
    if (!p) continue;
    const next = `${p} ${sel}`;
    if (document.querySelectorAll(next).length === document.querySelectorAll(sel).length && depth > 0) break;
    sel = next;
    depth++;
    if (document.querySelectorAll(sel).length <= 24) break;
  }
  return sel;
}

/** The properties the report shows and edits. */
export const PROPS = ["background-color", "color", "border-radius", "padding", "gap", "font-size", "font-weight", "border", "width", "height", "box-shadow", "opacity"] as const;

export function lookOf(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const p of PROPS) out[p] = cs.getPropertyValue(p).trim();
  return out;
}

export interface Picker {
  stop(): void;
}

/**
 * Starts picking: `onPick` gets the clicked element (outside the panel). `ignore` is the panel (never picked).
 * The outline and its label are drawn on a fixed overlay above everything.
 */
export function startPicking(ignore: HTMLElement | null, onPick: (el: Element) => void, onStop: () => void): Picker {
  const box = document.createElement("div");
  const tag = document.createElement("div");
  box.setAttribute("data-dev-inspect", "");
  Object.assign(box.style, { position: "fixed", zIndex: "2147482999", pointerEvents: "none", outline: "2px solid #ff3d8b", background: "rgba(255, 61, 139, 0.08)", borderRadius: "2px", display: "none" });
  Object.assign(tag.style, { position: "absolute", left: "-2px", bottom: "100%", marginBottom: "4px", padding: "2px 6px", borderRadius: "4px", background: "#ff3d8b", color: "#fff", font: "500 11px/16px Inter, system-ui, sans-serif", whiteSpace: "nowrap" });
  box.appendChild(tag);
  document.body.appendChild(box);
  let current: Element | null = null;

  const target = (e: MouseEvent): Element | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || (ignore && ignore.contains(el)) || box.contains(el)) return null;
    return el;
  };
  const show = (el: Element | null) => {
    current = el;
    if (!el) return void (box.style.display = "none");
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = `${nameOf(el)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    tag.style.bottom = r.top < 24 ? "auto" : "100%";
    tag.style.top = r.top < 24 ? "100%" : "auto";
  };
  const move = (e: MouseEvent) => show(target(e));
  const swallow = (e: Event) => {
    const t = e.target as Node | null;
    if (t && ignore?.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const click = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (t && ignore?.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = target(e) ?? current;
    if (el) onPick(el);
  };
  // ⌥-scroll walks up to the parent (a card rather than its title)
  const wheel = (e: WheelEvent) => {
    if (!e.altKey || !current) return;
    e.preventDefault();
    const next = e.deltaY < 0 ? current.parentElement : (current.firstElementChild ?? current);
    if (next && next !== document.body) show(next);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stop();
    } else if (e.key === "ArrowUp" && current?.parentElement && current.parentElement !== document.body) {
      e.preventDefault();
      show(current.parentElement);
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      onPick(current);
    }
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("click", click, true);
  for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) window.addEventListener(t, swallow, true);
  window.addEventListener("wheel", wheel, { capture: true, passive: false });
  window.addEventListener("keydown", key, true);
  document.documentElement.style.cursor = "crosshair";

  function stop() {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("click", click, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) window.removeEventListener(t, swallow, true);
    window.removeEventListener("wheel", wheel, { capture: true });
    window.removeEventListener("keydown", key, true);
    document.documentElement.style.cursor = "";
    box.remove();
    onStop();
  }
  return { stop };
}

/** Outlines every element matching `selector` for a moment (hovering a report item). */
export function flash(selector: string): () => void {
  const boxes: HTMLElement[] = [];
  let els: Element[] = [];
  try {
    els = Array.from(document.querySelectorAll(selector)).slice(0, 60);
  } catch {
    return () => {};
  }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const b = document.createElement("div");
    Object.assign(b.style, { position: "fixed", zIndex: "2147482999", pointerEvents: "none", outline: "2px solid #ff3d8b", borderRadius: "2px", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.appendChild(b);
    boxes.push(b);
  }
  return () => boxes.forEach((b) => b.remove());
}

/** Which view this is (the page's role, as main.tsx picks it). */
export function viewName(): string {
  const p = new URLSearchParams(location.search);
  for (const v of ["editor", "present", "tabbar", "welcome", "gallery", "admin", "engine"]) if (p.has(v)) return v;
  return "files";
}
