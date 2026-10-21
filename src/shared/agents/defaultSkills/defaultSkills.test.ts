// Wecra's default skills (docs/ai.md §8.6): each passes the skill checks a user's skill passes, names only tools that
// exist, ends with a checklist; the merge with the owner's skills (overrides, defaults turned off, the old alias).
import { describe, expect, it } from "vitest";
import { parseSkillFile, skillFileText, skillProblem } from "../../ai/skillFile";
import type { AiSkill } from "../../ai/types";
import { SKILL_TOOLS, APP_TOOLS } from "../appTools";
import { REACH_TOOLS } from "../reach";
import { MANAGER_TOOLS, TOOLS } from "../tools";
import { DEFAULT_SKILLS, DEFAULT_SKILL_BY_NAME, SKILL_ALIASES, defaultSkillFor, defaultSkillId, skillToAnswer, withDefaults } from "./index";

const TOOL_NAMES = new Set([...TOOLS, ...MANAGER_TOOLS, ...SKILL_TOOLS, ...APP_TOOLS, ...REACH_TOOLS].map((t) => t.name));
/** Arguments that look like tools (edit_variable_collection's actions). */
const NOT_TOOLS = new Set(["add_mode", "rename_mode", "delete_mode", "duplicate_mode", "set_default_mode"]);
/** snake_case words that look like a tool call: a verb, then the rest. */
const TOOLISH = /\b(?:get|set|create|add|remove|update|delete|list|apply|bind|export|insert|make|new|check|fill|score|generate|open|capture|read|search|repo|save|run|edit|duplicate|reparent|place|accept|report|install|find)_[a-z_]+\b/g;

describe("the default skill pack", () => {
  it("has the asked-for skills, motion-opus and sound-design, with unique names", () => {
    const names = DEFAULT_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["frontend-design", "canvas-design", "brand-guidelines", "theme-factory", "ux-review", "accessibility-audit", "wecra-design-system", "component-authoring", "prototype-builder", "code-to-design", "turkish-microcopy", "dev-handoff", "social-campaign", "motion-opus", "sound-design"])
      expect(DEFAULT_SKILL_BY_NAME.has(n), n).toBe(true);
  });

  it.each(DEFAULT_SKILLS.map((s) => [s.name, s] as const))("%s passes the skill checks and round-trips as a SKILL.md", (_name, s) => {
    expect(skillProblem(s)).toBeNull();
    expect(parseSkillFile(skillFileText(s))).toEqual({ name: s.name, description: s.description, instructions: s.instructions });
    expect(s.description).toMatch(/\bUse\b/); // says when to use it
    expect(s.instructions.length).toBeGreaterThan(1500);
    expect(s.instructions.length).toBeLessThan(16 * 1024);
  });

  it.each(DEFAULT_SKILLS.filter((s) => s.name !== "sound-design").map((s) => [s.name, s] as const))("%s names only real tools and ends with a checklist", (_name, s) => {
    const unknown = [...new Set(s.instructions.match(TOOLISH) ?? [])].filter((w) => !TOOL_NAMES.has(w) && !NOT_TOOLS.has(w));
    expect(unknown).toEqual([]);
    expect(s.instructions).toMatch(/## Checklist\n(- \[ \] .+\n?){4,}$/);
  });
});

describe("withDefaults", () => {
  const own = (over: Partial<AiSkill>): AiSkill => ({ id: "a1", name: "brand-voice", description: "d", instructions: "i", enabled: true, createdAt: 1, updatedAt: 2, ...over });

  it("lists the defaults by name among the owner's skills; his copy of a default wins and is marked", () => {
    const list = withDefaults([own({}), own({ id: "a2", name: "ux-review", instructions: "Mine." })], ["theme-factory"]);
    expect(list.map((s) => s.name)).toEqual([...list.map((s) => s.name)].sort());
    expect(list).toHaveLength(DEFAULT_SKILLS.length + 1);
    expect(list.find((s) => s.name === "brand-voice")!.origin).toBeUndefined();
    expect(list.find((s) => s.name === "ux-review")).toMatchObject({ id: "a2", origin: "override", instructions: "Mine." });
    expect(list.find((s) => s.name === "theme-factory")).toMatchObject({ id: defaultSkillId("theme-factory"), origin: "default", enabled: false });
    expect(list.find((s) => s.name === "motion-opus")).toMatchObject({ origin: "default", enabled: true });
  });

  it("get_skill answers: the owner's copy over the shipped text, nothing for a default turned off, the alias unless he has his own", () => {
    const list = withDefaults([own({ id: "a2", name: "ux-review", instructions: "Mine." })], ["theme-factory"]);
    expect(skillToAnswer("ux-review", list)?.instructions).toBe("Mine.");
    expect(skillToAnswer("theme-factory", list)).toBeUndefined();
    expect(skillToAnswer("motion-design", list)?.name).toBe("motion-opus");
    expect(skillToAnswer("motion-design", withDefaults([own({ name: "motion-design", instructions: "Old." })]))?.instructions).toBe("Old.");
    expect(skillToAnswer("motion-design", withDefaults([], ["motion-opus"]))).toBeUndefined();
  });

  it("answers the old motion-design name with motion-opus", () => {
    expect(SKILL_ALIASES["motion-design"]).toBe("motion-opus");
    expect(defaultSkillFor("motion-design")?.name).toBe("motion-opus");
    expect(defaultSkillFor("nope")).toBeUndefined();
  });
});
