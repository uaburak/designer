// Round 6a: the actions' answers (schemas.ts), prompts and kits.
import { describe, expect, it } from "vitest";
import { AnswerError, draftSchema, readDraft, readInteractions, readRename, readTexts, readTextsSoFar, RENAME_SCHEMA } from "./schemas";
import { formatOutline, OUTLINE_MAX_DEPTH, SYSTEM_PREFIX, firstDraftPrompt, renamePrompt, textPrompt, type OutlineNode } from "./prompts";
import { autoKit, KITS, kitFor, LIBRARY_CHOICES } from "./kits";

describe("readers", () => {
  it("rename: known ids only, names one line and ≤ 60; none renamed is bad", () => {
    const m = readRename({ names: [{ id: "1:2", name: "  Sign up\n button " }, { id: "9:9", name: "x" }, { id: "1:3", name: "A".repeat(80) }] }, new Set(["1:2", "1:3"]));
    expect(m.get("1:2")).toBe("Sign up button");
    expect(m.get("1:3")).toHaveLength(60);
    expect(m.has("9:9")).toBe(false);
    expect(() => readRename({ names: [{ id: "9:9", name: "x" }] }, new Set(["1:2"]))).toThrow(AnswerError);
    expect(() => readRename({ nope: [] }, new Set(["1:2"]))).toThrow(AnswerError);
    expect(RENAME_SCHEMA.required).toEqual(["names"]);
  });

  it("texts: a group's values must differ", () => {
    const ids = new Set(["a", "b", "c"]);
    expect(readTexts({ texts: [{ id: "a", characters: "X" }, { id: "b", characters: "Y" }] }, ids, [["a", "b"]]).get("b")).toBe("Y");
    expect(() => readTexts({ texts: [{ id: "a", characters: "X" }, { id: "b", characters: "X" }] }, ids, [["a", "b"]])).toThrow(/same text/);
    expect(readTexts({ texts: [{ id: "a", characters: "1\r\n2" }] }, ids).get("a")).toBe("1\n2");
  });

  it("texts as far as they have streamed: each text's characters so far, a cut escape left out, known ids only", () => {
    const ids = new Set(["1:2", "1:3"]);
    const full = JSON.stringify({ texts: [{ id: "1:2", characters: 'Say "hi"\nnow' }, { id: "1:3", characters: "Ünïcode" }, { id: "9:9", characters: "x" }] });
    expect(readTextsSoFar(full, ids)).toEqual(new Map([["1:2", 'Say "hi"\nnow'], ["1:3", "Ünïcode"]]));
    expect(readTextsSoFar(full.slice(0, full.indexOf("hi") + 2), ids)).toEqual(new Map([["1:2", 'Say "hi']]));
    expect(readTextsSoFar('{"texts":[{"id":"1:2","characters":"a\\', ids).get("1:2")).toBe("a");
    expect(readTextsSoFar('{"texts":[{"id":"1:2","characters":"a\\u00', ids).get("1:2")).toBe("a");
    expect(readTextsSoFar('{"texts":[{"id":"1:2","charac', ids).size).toBe(0);
  });

  it("interactions: sources and destinations checked, never to its own frame, one per source", () => {
    const frameOf = (id: string) => (id.startsWith("a") ? "A" : "B");
    const out = readInteractions(
      { interactions: [{ sourceId: "a1", trigger: "ON_CLICK", action: "NAVIGATE", destinationId: "B" }, { sourceId: "a1", trigger: "ON_CLICK", action: "BACK" }, { sourceId: "a2", trigger: "ON_CLICK", action: "NAVIGATE", destinationId: "A" }, { sourceId: "b1", trigger: "ON_CLICK", action: "BACK" }, { sourceId: "zz", trigger: "ON_CLICK", action: "BACK" }] },
      new Set(["a1", "a2", "b1"]),
      new Set(["A", "B"]),
      frameOf
    );
    expect(out).toEqual([{ sourceId: "a1", trigger: "ON_CLICK", action: "NAVIGATE", destinationId: "B" }, { sourceId: "b1", trigger: "ON_CLICK", action: "BACK" }]);
  });

  it("draft: unknown blocks left out, props kept as strings / numbers / string lists", () => {
    const plan = readDraft({ name: "Home", platform: "web", blocks: [{ block: "hero", props: { title: "Hi", n: 3, list: ["a", 1, "b"], bad: { x: 1 } } }, { block: "spaceship", props: {} }] }, new Set(["hero"]));
    expect(plan).toEqual({ name: "Home", platform: "web", blocks: [{ block: "hero", props: { title: "Hi", n: 3, list: ["a", "b"] } }] });
    expect(() => readDraft({ name: "x", platform: "app", blocks: [{ block: "spaceship", props: {} }] }, new Set(["hero"]))).toThrow(AnswerError);
    expect(JSON.stringify(draftSchema(["hero", "nav"]))).toContain('"enum":["hero","nav"]');
  });
});

describe("prompts", () => {
  it("every system prompt starts with Figma AI's line; the outline is one line per layer, depth ≤ 6, texts ≤ 200", () => {
    let deep: OutlineNode = { id: "9:0", type: "FRAME", name: "Deep", width: 1, height: 1 };
    for (let i = 1; i < 10; i++) deep = { id: `9:${i}`, type: "FRAME", name: `L${i}`, width: 1, height: 1, children: [deep] };
    const text = formatOutline([{ id: "1:1", type: "TEXT", name: "T", width: 10.4, height: 5, text: "x".repeat(300), mark: "rename" }, deep]);
    expect(text.split("\n")[0]).toBe(`1:1 TEXT "T" 10×5 text="${"x".repeat(199)}…" [rename]`);
    expect(text.split("\n")).toHaveLength(1 + OUTLINE_MAX_DEPTH);
    expect(renamePrompt(text).system.startsWith(SYSTEM_PREFIX)).toBe(true);
    expect(textPrompt({ kind: "translate", language: "Turkish" }, [{ id: "1:1", characters: "Hi" }], "").system).toContain("Turkish");
    expect(firstDraftPrompt("x", KITS[0], { name: "old" }).prompt).toContain('"name":"old"');
  });
});

describe("kits", () => {
  it("four libraries plus Auto, each with 4 themes; Auto picks web / wireframe from the prompt", () => {
    expect(LIBRARY_CHOICES.map((c) => c.label)).toEqual(["Auto", "App wireframe", "Website wireframe", "App design", "Website design"]);
    for (const k of KITS) expect(k.themes).toHaveLength(4);
    expect(autoKit("A landing page for a bakery").id).toBe("web-design");
    expect(autoKit("wireframe of a fitness app").id).toBe("app-wireframe");
    expect(kitFor("web-wireframe", "an app").id).toBe("web-wireframe");
  });
});
