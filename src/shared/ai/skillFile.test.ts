// A Skill's `.md` file (docs/ai.md §2.10): read on Upload a file, written by Export; `/name` in a prompt.
import { describe, expect, it } from "vitest";
import { invokedSkill, parseSkillFile, skillFileText, skillNameOf, skillProblem, slashQuery } from "./skillFile";

describe("skill files", () => {
  it("reads frontmatter (plain, quoted, folded) and the instructions", () => {
    expect(parseSkillFile('---\nname: brand-voice\ndescription: "Our tone: warm, short"\n---\n\nWrite warmly.\n')).toEqual({ name: "brand-voice", description: "Our tone: warm, short", instructions: "Write warmly." });
    expect(parseSkillFile("﻿---\r\nname: 'a11y-check'\r\ndescription: >\r\n  Checks contrast\r\n  and sizes\r\n---\r\nCheck it.")).toEqual({ name: "a11y-check", description: "Checks contrast and sizes", instructions: "Check it." });
  });

  it("takes the file's name when the frontmatter has none, made a valid name", () => {
    expect(parseSkillFile("---\ndescription: Lists\n---\nDo lists.", "Release Notes.md")).toMatchObject({ name: "release-notes" });
    expect(skillNameOf("  Brand Voice! v2 ")).toBe("brand-voice-v2");
  });

  it("says what is missing", () => {
    expect(parseSkillFile("Just text", "x.md")).toEqual({ error: "Add a description, so agents know when to use it." });
    expect(skillProblem({ name: "Bad Name", description: "d", instructions: "i" })).toMatch(/lowercase/);
    expect(skillProblem({ name: "ok", description: "d".repeat(1025), instructions: "i" })).toMatch(/1,024/);
  });

  it("Export writes a file Upload reads back", () => {
    const s = { name: "tone", description: 'Say "hi": politely', instructions: "Be kind.\n\nAlways." };
    expect(parseSkillFile(skillFileText(s))).toEqual(s);
  });

  it("/name runs the first enabled skill named, its token taken out of the prompt", () => {
    const skills = [{ name: "tone", enabled: true }, { name: "grid", enabled: false }, { name: "audit", enabled: true }];
    expect(invokedSkill("/tone make this friendlier", skills)).toEqual({ skill: skills[0], prompt: "make this friendlier" });
    expect(invokedSkill("check /grid then /audit and /tone", skills)).toEqual({ skill: skills[2], prompt: "check /grid then and /tone" });
    expect(invokedSkill("a/tone path", skills)).toBeNull();
    expect(invokedSkill("/unknown", skills)).toBeNull();
  });

  it("the / list's query at the caret", () => {
    expect(slashQuery("/to", 3)).toEqual({ start: 0, query: "to" });
    expect(slashQuery("make /a", 7)).toEqual({ start: 5, query: "a" });
    expect(slashQuery("a/b", 3)).toBeNull();
    expect(slashQuery("/tone done", 10)).toBeNull();
  });
});
