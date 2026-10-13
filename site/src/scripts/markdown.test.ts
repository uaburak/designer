import { describe, expect, it } from "vitest";
import { escapeHtml, renderInline, renderMarkdown } from "./markdown";

describe("renderInline", () => {
  it("escapes HTML", () => {
    expect(renderInline(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
  });

  it("renders bold and code", () => {
    expect(renderInline("**New** and __also__ with `a < b`")).toBe(
      "<strong>New</strong> and <strong>also</strong> with <code>a &lt; b</code>",
    );
  });

  it("leaves Markdown inside code alone", () => {
    expect(renderInline("`**not bold** [x](https://a.b)`")).toBe("<code>**not bold** [x](https://a.b)</code>");
  });

  it("links http(s) only", () => {
    expect(renderInline("[site](https://get.wecra.app/a?b=1&c=2)")).toBe(
      '<a href="https://get.wecra.app/a?b=1&amp;c=2" rel="noopener noreferrer">site</a>',
    );
    expect(renderInline("[x](http://example.com)")).toContain('href="http://example.com"');
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("<a");
    expect(renderInline("[x](data:text/html,hi)")).not.toContain("<a");
    expect(renderInline("[x](/relative)")).toBe("[x](/relative)");
  });

  it("cannot break out of the href attribute", () => {
    const html = renderInline('[x](https://a.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/"onmouseover/);
  });

  it("keeps code inside a link label", () => {
    expect(renderInline("[`npm i`](https://x.y)")).toBe('<a href="https://x.y" rel="noopener noreferrer"><code>npm i</code></a>');
  });

  it("drops NUL so placeholders cannot be forged", () => {
    expect(renderInline("\u00000\u0000 `a`")).toBe("0 <code>a</code>");
  });
});

describe("renderMarkdown", () => {
  it("renders headings shifted under the release title", () => {
    expect(renderMarkdown("## New\n# Top")).toBe("<h3>New</h3><h2>Top</h2>");
    expect(renderMarkdown("###### Deep", 1)).toBe("<h6>Deep</h6>");
  });

  it("renders lists, nested lists and paragraphs", () => {
    expect(renderMarkdown("Intro line\nstill intro\n\n- one\n- two\n  - inner\n- three\n\nAfter")).toBe(
      "<p>Intro line still intro</p><ul><li>one</li><li>two<ul><li>inner</li></ul></li><li>three</li></ul><p>After</p>",
    );
  });

  it("renders ordered lists", () => {
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("switches list kinds at the same indent", () => {
    expect(renderMarkdown("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("joins continuation lines into the list item", () => {
    expect(renderMarkdown("- first\n  more")).toBe("<ul><li>first more</li></ul>");
  });

  it("renders fenced code escaped", () => {
    expect(renderMarkdown("```\n<b>x</b>\n**y**\n```")).toBe("<pre><code>&lt;b&gt;x&lt;/b&gt;\n**y**</code></pre>");
  });

  it("escapes raw HTML blocks", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
  });

  it("handles empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
