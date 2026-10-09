// @vitest-environment happy-dom
// Round 9 — Component configuration's description (live popovers/component-configuration.txt): what the editor holds
// (its DOM, as the toolbar and Chromium's editing commands leave it) comes back as the Markdown it was read from.
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml } from "../panels/design/richText";

const read = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return htmlToMarkdown(el);
};

describe("the description's Markdown", () => {
  it("round-trips what the toolbar writes", () => {
    const md = "# Button\nPrimary **action**, *quiet* and ~~old~~ with `code`\n- one\n- two\n1. first\n2. second\n```\nlet a = 1;\n```\nSee [docs](https://example.com)";
    expect(read(markdownToHtml(md))).toBe(md);
  });

  it("reads Chromium's own marks: <strong>, styled spans, a first line outside any block, <br> lines", () => {
    expect(read('Use it <strong>once</strong><div><span style="font-weight: bold;">bold</span> and <span style="font-style: italic;">it</span></div><div><br></div><div>end</div>')).toBe("Use it **once**\n**bold** and *it*\n\nend");
    expect(read("one<br>two")).toBe("one\ntwo");
  });

  it("an empty editor is an empty description", () => {
    expect(read("")).toBe("");
    expect(read("<div><br></div>")).toBe("");
  });
});
