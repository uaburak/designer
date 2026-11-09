// The team (docs/studio.md §9): cleaning, the defaults and the owner's copies, the tools a member may not call, the
// opening block and the composer's @.
import { describe, expect, it } from "vitest";
import { DEFAULT_TEAM, cleanTeam, deniedTools, memberBrief, memberIdFor, mentionOf, mentionQuery, resetMember, teamOf, turnMember, withMember, withoutMember } from "./team";

describe("the team", () => {
  it("is Wecra's defaults until the owner changes it; his copy takes a default's place, his own come after", () => {
    expect(teamOf(undefined).map((m) => [m.id, m.origin])).toEqual(DEFAULT_TEAM.map((m) => [m.id, "default"]));
    let team = withMember(undefined, { ...DEFAULT_TEAM[1], name: "Reels", enabled: false });
    team = withMember(team, { id: "story-designer", name: "Story Designer", role: "Stories", instructions: "", route: null, skills: [], tools: null, enabled: true });
    team = withoutMember(team, "reviewer");
    const all = teamOf(team);
    expect(all.map((m) => m.id)).toEqual(["post-designer", "reels-maker", "copywriter", "story-designer"]);
    expect(all[1]).toMatchObject({ name: "Reels", enabled: false, origin: "override" });
    expect(all[3].origin).toBeUndefined();
    expect(teamOf(resetMember(team, "reels-maker"))[1]).toMatchObject({ name: "Reels Maker", origin: "default" });
    expect(teamOf(resetMember(team, "reviewer")).some((m) => m.id === "reviewer")).toBe(true);
    expect(teamOf(withoutMember(team, "story-designer")).some((m) => m.id === "story-designer")).toBe(false);
  });

  it("cleans what a view sends: bad ids and names dropped, unknown tool groups and skills left out, lengths bounded", () => {
    const t = cleanTeam({
      members: [
        { id: "Bad Id", name: "x" },
        { id: "ok", name: "  Ok\n  one ", role: "r".repeat(400), skills: ["motion-opus", "Bad Skill", "motion-opus"], tools: ["motion", "nope"], route: { providerId: "codex", model: "m" } },
        { id: "ok", name: "dup" },
      ],
      removed: ["reviewer", "not-a-default"],
    });
    expect(t.members).toHaveLength(1);
    expect(t.members[0]).toMatchObject({ id: "ok", name: "Ok one", skills: ["motion-opus"], tools: ["motion"], route: { providerId: "codex", model: "m" }, enabled: true });
    expect(t.members[0].role).toHaveLength(300);
    expect(t.removed).toEqual(["reviewer"]);
    expect(cleanTeam(null)).toEqual({ members: [], removed: [] });
  });

  it("denies the tools of the groups a member hasn't got; reading is never denied; null tools deny nothing", () => {
    const denied = deniedTools(["layers", "social"]);
    expect(denied.has("animate")).toBe(true);
    expect(denied.has("add_comment")).toBe(true);
    expect(denied.has("create_nodes")).toBe(false);
    expect(denied.has("get_screenshot")).toBe(false);
    expect(deniedTools(null).size).toBe(0);
  });

  it("opens a member's turn with who it is, its instructions, its Skills and what isn't its job", () => {
    const m = turnMember(DEFAULT_TEAM.find((x) => x.id === "copywriter")!);
    const brief = memberBrief(m, [{ name: "turkish-microcopy", instructions: "Write natural Turkish." }]);
    expect(brief).toContain("You are Copywriter");
    expect(brief).toContain('<skill name="turkish-microcopy">\nWrite natural Turkish.\n</skill>');
    expect(brief).toContain("motion");
  });

  it("names new members from their name, unique; reads @member at the message's start", () => {
    expect(memberIdFor("Story Tasarımcısı", [])).toBe("story-tasarimcisi");
    expect(memberIdFor("Reels Maker", ["reels-maker"])).toBe("reels-maker-2");
    expect(mentionOf("@reels-maker make a reel")).toEqual({ id: "reels-maker", rest: "make a reel" });
    expect(mentionOf("make a reel @reels-maker")).toBeNull();
    expect(mentionQuery("@ree", 4)).toEqual({ start: 0, query: "ree" });
    expect(mentionQuery("hi @ree", 7)).toBeNull();
  });
});
