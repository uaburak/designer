/**
 * create_responsive_variant: a frame's copy at another width, re-laid out the way a designer adapts a desktop screen
 * to a phone — a vertical auto layout stack (layers in reading order), rows that don't fit stacked (or wrapped when
 * they are small cards), children filling the width, headings scaled down, images and shapes fitted keeping their
 * aspect ratio. Deterministic, so the flagship flow works with any model; the agent refines the result.
 */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import type { ToolEnv } from "./mcpTools";
import { IDENTITY, sizingFields } from "./nodeSpec";

const read = (env: ToolEnv, id: Guid) => {
  const n = env.ed.engine.readNode(id, { childIds: true });
  return n ? env.ed.withRealType(n) : null;
};

const isFrameLike = (n: NodeChange) => n.type === "FRAME" || n.type === "SYMBOL";
const hasLayout = (n: NodeChange) => !!n.stackMode && n.stackMode !== "NONE" && n.stackMode !== "GRID";
const hasImage = (n: NodeChange) => (n.fillPaints ?? []).some((p) => p.type === "IMAGE" && p.visible !== false);

/** A text size for a narrower screen (the skill's type scale: display 32–40, h1 28–32, h2 22–24, body as it is). */
export function mobileFontSize(size: number, ratio: number): number {
  if (ratio >= 0.8 || size <= 18) return size;
  if (size <= 24) return Math.max(16, Math.round(size * 0.9));
  if (size <= 40) return Math.max(20, Math.round(size * 0.75));
  if (size <= 64) return Math.max(28, Math.min(40, Math.round(size * 0.6)));
  return Math.max(32, Math.min(44, Math.round(size * 0.5)));
}

/** Layers in reading order: rows (layers whose vertical spans overlap) top to bottom, each left to right. */
export function readingOrder(nodes: readonly NodeChange[]): NodeChange[] {
  const box = (n: NodeChange) => ({ x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0, w: n.size?.x ?? 0, h: n.size?.y ?? 0 });
  const sorted = [...nodes].sort((a, b) => box(a).y - box(b).y || box(a).x - box(b).x);
  const rows: { top: number; bottom: number; items: NodeChange[] }[] = [];
  for (const n of sorted) {
    const b = box(n);
    const row = rows.find((r) => Math.min(r.bottom, b.y + b.h) - Math.max(r.top, b.y) > Math.min(b.h, r.bottom - r.top) * 0.5);
    if (row) {
      row.items.push(n);
      row.top = Math.min(row.top, b.y);
      row.bottom = Math.max(row.bottom, b.y + b.h);
    } else rows.push({ top: b.y, bottom: b.y + b.h, items: [n] });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.flatMap((r) => r.items.sort((a, b) => box(a).x - box(b).x));
}

const HUG = "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";

export function responsiveVariant(env: ToolEnv, source: NodeChange, width: number, name?: string): { id: Guid; notes: string[] } {
  const e = env.ed.engine;
  const notes: string[] = [];
  if (!isFrameLike(source) && source.type !== "INSTANCE" && source.type !== "SECTION") throw new Error(`${source.guid} is a ${source.type}: pick a frame`);
  const ratio = width / Math.max(1, source.size?.x ?? width);

  // The copy, next to the source (its own selection put back after).
  const before = [...env.ed.selection];
  e.setSelection([source.guid]);
  e.command("DUPLICATE");
  const copyId = e.getSelection().refs[0];
  e.setSelection(before);
  if (!copyId || copyId === source.guid) throw new Error("The frame couldn't be duplicated");
  let copy = read(env, copyId)!;
  // An instance is detached first: its layers are re-laid out (Figma's agent detaches too when it restructures).
  if (copy.type === "INSTANCE") {
    e.setSelection([copyId]);
    e.command("DETACH_INSTANCE");
    e.setSelection(before);
    copy = read(env, copyId) ?? copy;
    notes.push("detached the instance copy");
  }
  const t = source.transform ?? IDENTITY;
  const label = width <= 480 ? "Mobile" : width <= 1024 ? "Tablet" : `${width}`;
  e.setProps([copyId], {
    name: name ?? `${source.name ?? "Frame"} — ${label}`,
    transform: { ...t, m02: t.m02 + (source.size?.x ?? 0) + 120 },
  });
  notes.push(`copied "${source.name}" to the right, ${width} wide`);

  adaptContainer(env, read(env, copyId)!, width, ratio, true, notes, 0);
  return { id: copyId, notes };
}

/** A frame becomes a vertical stack at `width` (the root), or adapts inside its parent's width. */
function adaptContainer(env: ToolEnv, frame: NodeChange, width: number, ratio: number, root: boolean, notes: string[], depth: number): void {
  const e = env.ed.engine;
  const kids = ((frame.childIds ?? []) as Guid[]).map((id) => read(env, id)).filter((n): n is NodeChange => !!n);
  const w0 = frame.size?.x ?? width;
  const h0 = frame.size?.y ?? 0;
  const fields: NodeFields = {};
  if (!hasLayout(frame)) {
    // Backgrounds (a layer covering the frame) stay behind the stack, absolute.
    const backgrounds = kids.filter((k) => (k.size?.x ?? 0) >= w0 * 0.9 && (k.size?.y ?? 0) >= h0 * 0.9 && kids.length > 1);
    const flow = readingOrder(kids.filter((k) => !backgrounds.includes(k) && k.visible !== false));
    // Spacing as the source had it: the smallest vertical gap between rows, within 12–32.
    const ys = flow.map((k) => ({ top: k.transform?.m12 ?? 0, bottom: (k.transform?.m12 ?? 0) + (k.size?.y ?? 0) }));
    let gap = 24;
    for (let i = 1; i < ys.length; i++) {
      const g = ys[i].top - ys[i - 1].bottom;
      if (g > 0) gap = Math.min(gap, g);
    }
    const pad = root ? Math.round(Math.max(16, Math.min(24, Math.min(...flow.map((k) => k.transform?.m02 ?? 24), 24) || 20))) : 0;
    Object.assign(fields, {
      stackMode: "VERTICAL",
      stackSpacing: Math.max(12, Math.min(32, Math.round(gap))),
      stackHorizontalPadding: pad,
      stackPaddingRight: pad,
      stackVerticalPadding: root ? Math.max(pad, 24) : 0,
      stackPaddingBottom: root ? Math.max(pad, 24) : 0,
      stackPrimarySizing: HUG,
      stackCounterSizing: "FIXED",
      stackCounterAlignItems: "MIN",
    } satisfies NodeFields);
    if (root || w0 > width) fields.size = { x: width, y: frame.size?.y ?? 100 };
    e.setProps([frame.guid], fields);
    // Layout order = reading order: the first in reading order is the bottom child.
    flow.forEach((k, i) => e.moveNodes([k.guid], frame.guid, i + backgrounds.length));
    for (const b of backgrounds) e.setProps([b.guid], { stackPositioning: "ABSOLUTE", size: { x: width, y: b.size?.y ?? 0 }, horizontalConstraint: "STRETCH", verticalConstraint: "STRETCH" } as NodeFields);
    if (depth === 0) notes.push(`stacked ${flow.length} layers vertically in reading order`);
  } else {
    // An auto layout frame: its padding and gap scaled, its direction decided by what fits.
    const padL = frame.stackHorizontalPadding ?? 0;
    const padR = frame.stackPaddingRight ?? padL;
    const k = Math.min(1, Math.max(ratio, 0.5));
    // Padding and gaps scaled down for the narrower screen (at most 24 at the sides, 32 above and below).
    const scaled = (v: number | undefined, max: number) => Math.min(max, Math.round((v ?? 0) * k));
    Object.assign(fields, {
      stackHorizontalPadding: root ? scaled(padL, 24) || 16 : scaled(padL, 24),
      stackPaddingRight: root ? scaled(padR, 24) || 16 : scaled(padR, 24),
      stackVerticalPadding: scaled(frame.stackVerticalPadding, 32),
      stackPaddingBottom: scaled(frame.stackPaddingBottom ?? frame.stackVerticalPadding, 32),
      stackSpacing: scaled(frame.stackSpacing, 32),
    } satisfies NodeFields);
    if (root) {
      fields.size = { x: width, y: frame.size?.y ?? 100 };
      if (frame.stackMode === "VERTICAL") fields.stackPrimarySizing = HUG;
    }
    if (frame.stackMode === "HORIZONTAL") {
      const gap = fields.stackSpacing ?? 0;
      const inner = width - (fields.stackHorizontalPadding ?? 0) - (fields.stackPaddingRight ?? 0);
      const total = kids.reduce((s, c) => s + (c.size?.x ?? 0), 0) + gap * Math.max(0, kids.length - 1);
      if (total > inner) {
        const small = kids.length >= 3 && kids.every((c) => (c.size?.x ?? 0) <= 180);
        if (small) {
          Object.assign(fields, { stackWrap: "WRAP", stackCounterSpacing: gap || 12 } satisfies NodeFields);
          notes.push(`wrapped the row "${frame.name}"`);
        } else {
          Object.assign(fields, { stackMode: "VERTICAL", stackPrimarySizing: HUG, stackCounterSizing: "FIXED", stackPrimaryAlignItems: "MIN", stackCounterAlignItems: "MIN", stackSpacing: Math.max(12, Math.min(24, gap || 16)) } satisfies NodeFields);
          notes.push(`stacked the row "${frame.name}"`);
        }
      }
    } else if (frame.stackMode === "VERTICAL" && !root) fields.stackPrimarySizing = HUG;
    if (Object.keys(fields).length) e.setProps([frame.guid], fields);
  }
  // The children, now under a (possibly new) layout.
  const now = read(env, frame.guid)!;
  const inner = (now.size?.x ?? width) - (now.stackHorizontalPadding ?? 0) - (now.stackPaddingRight ?? now.stackHorizontalPadding ?? 0);
  for (const id of (now.childIds ?? []) as Guid[]) {
    const c = read(env, id);
    if (!c || c.stackPositioning === "ABSOLUTE" || c.visible === false) continue;
    adaptChild(env, c, now, inner, ratio, notes, depth + 1);
  }
}

function adaptChild(env: ToolEnv, c: NodeChange, parent: NodeChange, inner: number, ratio: number, notes: string[], depth: number): void {
  const e = env.ed.engine;
  const vertical = parent.stackMode === "VERTICAL";
  const wrapping = parent.stackWrap === "WRAP";
  const w = c.size?.x ?? 0;
  const h = c.size?.y ?? 0;
  if (c.type === "TEXT") {
    const size = c.fontSize ?? 12;
    const next = mobileFontSize(size, ratio);
    const fields: NodeFields = {};
    if (next !== size) {
      fields.fontSize = next;
      if (c.lineHeight?.units === "PIXELS") fields.lineHeight = { value: Math.round((c.lineHeight.value * next) / size), units: "PIXELS" };
      if (size >= 32) notes.push(`heading "${(c.textData?.characters ?? "").slice(0, 24)}" ${size} → ${next}`);
    }
    // Wraps at the column's width (vertical stacks), or shrinks with its row.
    if (vertical || w > inner) Object.assign(fields, sizingFields(c, parent, "H", "FILL"), { textAutoResize: "HEIGHT" } satisfies NodeFields);
    if (Object.keys(fields).length) e.setProps([c.guid], fields);
    return;
  }
  const container = (isFrameLike(c) || c.type === "INSTANCE") && (c.childIds?.length ?? 0) > 0 && !hasImage(c);
  if (container && depth < 6 && c.type !== "INSTANCE") {
    if (vertical || w > inner) {
      // Fills the column, then adapts inside it.
      e.setProps([c.guid], { ...sizingFields(c, parent, "H", "FILL"), ...(hasLayout(c) ? {} : { size: { x: Math.min(w, inner), y: h } }) });
      adaptContainer(env, read(env, c.guid)!, Math.min(w, inner), ratio, false, notes, depth);
      const after = read(env, c.guid)!;
      if (hasLayout(after)) e.setProps([c.guid], sizingFields(after, parent, "V", "HUG"));
    }
    return;
  }
  // Images, shapes, instances, groups: fitted to the column keeping their aspect ratio.
  if (w > inner && w > 0) {
    const k = inner / w;
    e.setProps([c.guid], { size: { x: Math.round(inner), y: Math.round(h * k) } });
    if (hasImage(c)) notes.push(`scaled the image "${c.name}" to ${Math.round(inner)} wide`);
  } else if (vertical && !wrapping && hasImage(c) && w >= inner * 0.6) {
    const k = inner / Math.max(1, w);
    e.setProps([c.guid], { size: { x: Math.round(inner), y: Math.round(h * k) } });
  }
}
