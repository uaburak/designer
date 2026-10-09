/**
 * "Frame ▾" in the Design panel's header (live popovers/frame-presets-menu.txt: Section, Frame, Group first): what a
 * frame-like layer is, and turning it into another of the three in place — one undo step, its layers kept where they
 * are, its name, place and size kept.
 *
 * Frame ↔ Group is a field change (a group is a FRAME that fits its children, as Figma's files keep it). Frame / Group
 * → Section goes through the engine's own section (Wrap in new section: the theme's section look), the section then
 * taking the frame's place and size before the frame is removed with its layers kept (Figma's live menu offers it for
 * a frame on the page; a section can't sit in a frame). Section → Frame / Group is not offered (unverified: the live
 * capture is of a frame).
 */
import type { Guid } from "@/engine/codec";
import type { EditorController } from "../../controller";
import { fields, isGroupNode, typeOf, type PanelNode } from "./shared";

export type FrameKind = "Frame" | "Group" | "Section";

export function frameKindOf(n: PanelNode): FrameKind | null {
  if (isGroupNode(n)) return "Group";
  const t = typeOf(n);
  return t === "SECTION" ? "Section" : t === "FRAME" ? "Frame" : null;
}

/** Can these become sections? Frames and groups on the page or in a section (the engine's Wrap in new section rule). */
export function canBecomeSection(ed: EditorController, nodes: readonly PanelNode[]): boolean {
  return (
    nodes.length > 0 &&
    nodes.every((n) => {
      const kind = frameKindOf(n);
      if (kind !== "Frame" && kind !== "Group") return false;
      const parent = n.parentIndex?.guid;
      if (!parent) return false;
      if (ed.store.pages.some((p) => p.guid === parent)) return true;
      const p = ed.engine.readNode(parent, { fields: ["type"] });
      return !!p && typeOf(ed.withRealType(p)) === "SECTION";
    })
  );
}

/** Which kinds the menu offers for these layers (the others shown disabled). */
export function offeredKinds(ed: EditorController, nodes: readonly PanelNode[]): Record<FrameKind, boolean> {
  const kinds = new Set(nodes.map(frameKindOf));
  const sections = kinds.has("Section");
  return { Section: sections || canBecomeSection(ed, nodes), Frame: !sections, Group: !sections };
}

/** Turns the layers into `to` (one undo step); returns whether anything changed. */
export function convertFrameKind(ed: EditorController, nodes: readonly PanelNode[], to: FrameKind): boolean {
  const refs = nodes.filter((n) => frameKindOf(n) !== to).map((n) => n.guid);
  if (!refs.length) return false;
  const now = frameKindOf(nodes.find((n) => n.guid === refs[0]) ?? nodes[0]);
  if (to === "Frame" && now === "Group") {
    ed.setProps(refs, fields({ resizeToFit: false, frameMaskDisabled: true } as never), "Convert to frame");
    return true;
  }
  if (to === "Group" && now === "Frame") {
    ed.setProps(refs, fields({ resizeToFit: true, fillPaints: [], strokePaints: [], effects: [], stackMode: "NONE", frameMaskDisabled: true } as never), "Convert to group");
    return true;
  }
  if (to === "Section" && canBecomeSection(ed, nodes)) {
    const made: Guid[] = [];
    ed.batch("Convert to section", () => {
      for (const id of refs) {
        const f = ed.engine.readNode(id, { fields: ["name", "transform", "size"] });
        if (!f) continue;
        ed.engine.setSelection([id]);
        ed.engine.command("WRAP_IN_SECTION");
        const section = ed.engine.getSelection().refs[0];
        if (!section || section === id) continue;
        // The section takes the frame's place and size; the frame sits at its origin, so its layers keep their place.
        ed.engine.setProps([section], { name: f.name, transform: f.transform, size: f.size });
        ed.engine.setProps([id], { transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } });
        ed.engine.setSelection([id]);
        // (An empty frame has nothing to keep: it is deleted.)
        ed.engine.command(ed.engine.commandState("REMOVE_KEEP_CONTENTS") & 1 ? "REMOVE_KEEP_CONTENTS" : "DELETE");
        made.push(section);
      }
      if (made.length) ed.engine.setSelection(made);
    });
    return made.length > 0;
  }
  return false;
}
