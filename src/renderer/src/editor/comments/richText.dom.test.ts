// @vitest-environment happy-dom
// Rich comment text (atlas 16 §2.6): the composer's field read into Figma's message_meta segments and written back,
// the plain text Figma exports for them, what the store keeps, and the formatting keys.
import { describe, expect, it } from "vitest";
import { cleanSegments, segmentsText, type CommentSegment } from "@shared/comments";
import { formatKey, isRich, mentionChip, readSegments, writeSegments } from "./richText";

function field(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("rich comment text", () => {
  it("reads styles, links, mentions and line breaks as segments, merging neighbours alike", () => {
    const el = field('Hi <b>bold <i>both</i></b> <s>gone</s> <a href="https://x.co">link</a><br>next<br>');
    el.append(" ", mentionChip("u1", "@Ana"));
    expect(readSegments(el)).toEqual([
      { t: "Hi " },
      { t: "bold ", styles: ["b"] },
      { t: "both", styles: ["b", "i"] },
      { t: " " },
      { t: "gone", styles: ["s"] },
      { t: " " },
      { t: "link", link: "https://x.co" },
      { t: "\nnext\n " },
      { t: "@Ana", user_id: "u1" },
    ]);
  });

  it("reads lists as items, and writes segments back into the field the same", () => {
    const segs: CommentSegment[] = [{ t: "Todo:" }, { styles: ["ol"], children: [{ children: [{ t: "one", styles: ["b"] }] }, { children: [{ t: "two" }] }] }, { t: "after" }];
    const el = document.createElement("div");
    writeSegments(el, segs);
    expect(el.querySelectorAll("ol li")).toHaveLength(2);
    expect(readSegments(el)).toEqual(segs);
    expect(segmentsText(segs)).toBe("Todo:\n1. one\n2. two\nafter");
    expect(segmentsText([{ styles: ["ul"], children: [{ children: [{ t: "a" }] }] }])).toBe("* a\n");
  });

  it("keeps segments only when they say more than the text", () => {
    expect(isRich([{ t: "plain" }, { t: "@Ana", user_id: "u1" }])).toBe(false);
    expect(isRich([{ t: "x", styles: ["i"] }])).toBe(true);
    expect(isRich([{ styles: ["ul"], children: [] }])).toBe(true);
  });

  it("the store keeps known shapes only: no nested lists, no script links", () => {
    expect(cleanSegments([{ t: "a", styles: ["b", "zz"], link: "javascript:alert(1)" }])).toEqual([{ t: "a", styles: ["b"] }]);
    expect(cleanSegments([{ styles: ["ol"], children: [{ children: [{ styles: ["ul"], children: [] }] }] }])).toBeNull();
    expect(cleanSegments("nope")).toBeNull();
  });

  it("Figma's keys: ⌘B ⌘I ⌘⇧X ⌘K ⌘⇧7 ⌘⇧8", () => {
    const k = (code: string, shift = false) => formatKey({ key: "", code, metaKey: true, ctrlKey: false, shiftKey: shift, altKey: false }, true);
    expect([k("KeyB"), k("KeyI"), k("KeyX", true), k("KeyK"), k("Digit7", true), k("Digit8", true), k("KeyX")]).toEqual(["bold", "italic", "strikeThrough", "link", "insertOrderedList", "insertUnorderedList", null]);
    expect(formatKey({ key: "", code: "KeyB", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, false)).toBe("bold");
  });
});
