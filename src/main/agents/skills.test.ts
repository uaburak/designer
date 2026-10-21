// Agents manage the owner's Skills (docs/research/agent-parity.md §3): list / create / update / remove through the
// store's calls, install from the web or GitHub through reach's gate (policy, consent, log) with the chat's
// confirmation card showing what will be saved; outside clients refused; the confirmation list of the app tools.
import { describe, expect, it } from "vitest";
import { DEFAULT_REACH_SETTINGS, REACH_TOOL_BY_NAME, type AccessLogEntry, type ReachPolicy, type ReachSettings } from "../../shared/agents/reach";
import { APP_TOOLS, SKILL_TOOLS, confirmationFor, type ConfirmRequest } from "../../shared/agents/appTools";
import { MAIN_TOOLS, TOOL_BY_NAME } from "../../shared/agents/tools";
import type { AiSkill } from "../../shared/ai/types";
import { ReachHub, type ReachConsentRequest } from "./reach/hub";
import { DEFAULT_SKILL_SOURCES, fetchSkill, rawSkillUrl, scoreSkill, skillHeader, skillWebRunner, type SkillWebDeps } from "./reach/skillWeb";
import { mentionsCode, runSkillTool, skillSourceVia, type SkillToolDeps } from "./skills";
import { McpServer } from "./mcpServer";

const SKILL_MD = `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality.
license: Apache-2.0
---

# Frontend design

Pick a bold aesthetic direction, then design the layout, type and colour with intent.
`;

function memoryRepo(initial: AiSkill[] = []) {
  const list = [...initial];
  let n = 0;
  return {
    list,
    skills: async () => list.map((s) => ({ ...s })),
    saveSkill: async (s: { id?: string; name: string; description: string; instructions: string; enabled?: boolean }) => {
      const at = list.findIndex((x) => x.id === s.id);
      const skill: AiSkill = { id: s.id ?? `sk${++n}`, name: s.name, description: s.description, instructions: s.instructions, enabled: s.enabled ?? true, createdAt: 1, updatedAt: 2 };
      if (at >= 0) list[at] = skill;
      else list.push(skill);
      return skill;
    },
    removeSkill: async (id: string) => void list.splice(list.findIndex((x) => x.id === id), 1),
  };
}

/** A web of fixed answers: url → body (string), or {status, location}. */
function fakeWeb(pages: Record<string, string | { status: number; location?: string; type?: string; body?: string }>, addresses: Record<string, string[]> = {}): SkillWebDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (host) => addresses[host] ?? ["140.82.112.3"],
    fetch: async (url) => {
      asked.push(url);
      const p = pages[url];
      if (p === undefined) return new Response("not found", { status: 404 });
      if (typeof p === "string") return new Response(p, { status: 200, headers: { "content-type": url.includes("api.github.com") ? "application/json" : "text/plain" } });
      return new Response(p.body ?? "", { status: p.status, headers: { ...(p.location ? { location: p.location } : {}), "content-type": p.type ?? "text/plain" } });
    },
  };
}

const settings = (web: ReachPolicy, github: ReachPolicy = "off", repos: string[] = []): ReachSettings => ({ ...DEFAULT_REACH_SETTINGS, policies: { ...DEFAULT_REACH_SETTINGS.policies, web, github }, github: { repos } });

function setup(o: { web?: ReachPolicy; github?: ReachPolicy; repos?: string[]; consent?: boolean; confirm?: boolean | null; pages?: Parameters<typeof fakeWeb>[0]; addresses?: Record<string, string[]>; skills?: AiSkill[] } = {}) {
  const repo = memoryRepo(o.skills);
  const web = fakeWeb(o.pages ?? { "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md": SKILL_MD });
  const asks: ReachConsentRequest[] = [];
  const cards: ConfirmRequest[] = [];
  const log: AccessLogEntry[] = [];
  let s = settings(o.web ?? "allow", o.github ?? "off", o.repos ?? []);
  const hub = new ReachHub({
    settings: () => s,
    setPolicy: (cap, p) => (s = { ...s, policies: { ...s.policies, [cap]: p } }),
    forcedOff: async () => [],
    ask: async (req) => (asks.push(req), { allow: o.consent !== false }),
    log: (e) => log.push(e),
    runners: { web: skillWebRunner(web), github: async () => ({ content: [{ type: "text", text: "unused" }] }) },
  });
  let changed = 0;
  const deps: SkillToolDeps = {
    repo: async () => repo,
    builtIns: [{ name: "motion-design", description: "Motion" }],
    confirm: async (req) => (cards.push(req), o.confirm === undefined ? true : o.confirm),
    readSource: skillSourceVia(hub, { turnId: "t1", chatId: "c1", fileKey: "f1", agent: "Claude Code" }, {
      web: (url, ctx) => fetchSkill(url, ctx, web),
      github: async (args) => {
        if (!s.github.repos.includes(String(args.repo))) throw new Error(`${String(args.repo)} isn't one of the repositories the owner lets you read`);
        return { text: SKILL_MD, source: `github:${String(args.repo)}/${String(args.path)}` };
      },
    }),
    changed: () => void changed++,
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await runSkillTool(name, args, deps);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { r, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { repo, web, asks, cards, log, hub, deps, call, changed: () => changed };
}

describe("the tool lists", () => {
  it("lists the skills and app tools for every session; main answers the skills ones", () => {
    for (const t of [...SKILL_TOOLS, ...APP_TOOLS]) expect(TOOL_BY_NAME.get(t.name), t.name).toBeTruthy();
    for (const t of SKILL_TOOLS) expect(MAIN_TOOLS.has(t.name)).toBe(true);
    expect(REACH_TOOL_BY_NAME.get("find_skills")?.capability).toBe("web");
    expect(REACH_TOOL_BY_NAME.get("read_skill")?.capability).toBe("web");
    const names = [...TOOL_BY_NAME.keys()];
    expect(new Set(names).size).toBe(names.length);
  });

  it("the MCP server lists them to an outside client too", async () => {
    const server = new McpServer({ activeFileKey: () => "f1", isOpen: () => true, runTool: async () => ({ content: [] }), extraTools: async () => [{ name: "find_skills", description: "x", inputSchema: { type: "object" } }] }, "outside");
    await server.start(0);
    try {
      const res = await fetch(server.url!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer outside" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const list = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      for (const n of ["install_skill", "list_files", "get_comments", "export_nodes", "set_app_setting"]) expect(list).toContain(n);
      expect(list).not.toContain("find_skills"); // reach tools: chats only
    } finally {
      await server.stop();
    }
  });
});

describe("confirmation of destructive or outward app actions", () => {
  it("asks for trash, restore, publish, share, delete comment, plugin runs and mentions — not for safe calls", () => {
    expect(confirmationFor("file_action", { action: "trash", fileKeys: ["a", "b"] })?.action).toBe("move files to the trash");
    expect(confirmationFor("file_action", { action: "rename", fileKey: "a", name: "x" })).toBeNull();
    expect(confirmationFor("restore_version", { id: "v1" })).not.toBeNull();
    expect(confirmationFor("restore_version", { id: "v1", duplicate: true })).toBeNull();
    expect(confirmationFor("publish_library", { description: "New buttons" })?.target).toBe("New buttons");
    expect(confirmationFor("share_file", { invite: { email: "a@b.co", role: "editor" } })?.target).toContain("a@b.co");
    expect(confirmationFor("share_file", {})).toBeNull();
    expect(confirmationFor("delete_comment", { commentId: "c1" })).not.toBeNull();
    expect(confirmationFor("add_comment", { message: "hi" })).toBeNull();
    expect(confirmationFor("add_comment", { message: "hi @Ana", mentions: ["u1"] })?.preview).toBe("hi @Ana");
    expect(confirmationFor("run_plugin", { id: "p1" })).not.toBeNull();
    expect(confirmationFor("get_comments", {})).toBeNull();
  });
});

describe("skills from the web (skillWeb.ts)", () => {
  it("turns GitHub pages into raw SKILL.md addresses", () => {
    expect(rawSkillUrl("https://github.com/anthropics/skills/tree/main/skills/frontend-design")).toBe("https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md");
    expect(rawSkillUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md")).toBe("https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md");
    expect(rawSkillUrl("https://github.com/acme/ux-skill")).toBe("https://raw.githubusercontent.com/acme/ux-skill/HEAD/SKILL.md");
    expect(rawSkillUrl("https://example.com/skills/ux.md")).toBe("https://example.com/skills/ux.md");
    expect(() => rawSkillUrl("not a url")).toThrow();
  });

  it("refuses private addresses, a redirect into one, and web pages", async () => {
    const ctx = { settings: settings("allow"), signal: new AbortController().signal };
    await expect(fetchSkill("http://127.0.0.1/SKILL.md", ctx, fakeWeb({}))).rejects.toThrow(/local|private/i);
    const sneaky = fakeWeb({ "https://evil.example/SKILL.md": "x" }, { "evil.example": ["10.0.0.5"] });
    await expect(fetchSkill("https://evil.example/SKILL.md", ctx, sneaky)).rejects.toThrow(/private/);
    const redirect = fakeWeb({ "https://ok.example/SKILL.md": { status: 302, location: "http://169.254.169.254/latest" } });
    await expect(fetchSkill("https://ok.example/SKILL.md", ctx, redirect)).rejects.toThrow();
    expect(redirect.asked).toEqual(["https://ok.example/SKILL.md"]);
    const html = fakeWeb({ "https://ok.example/skill.md": { status: 200, type: "text/html", body: "<!doctype html><html></html>" } });
    await expect(fetchSkill("https://ok.example/skill.md", ctx, html)).rejects.toThrow(/web page/);
  });

  it("find_skills ranks a UX query's design skills first (GitHub mocked)", async () => {
    const repo = DEFAULT_SKILL_SOURCES[0];
    const raw = (p: string) => `https://raw.githubusercontent.com/${repo}/main/${p}`;
    const web = fakeWeb({
      [`https://api.github.com/repos/${repo}`]: JSON.stringify({ default_branch: "main" }),
      [`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`]: JSON.stringify({ tree: [{ path: "skills/pdf/SKILL.md", type: "blob" }, { path: "skills/frontend-design/SKILL.md", type: "blob" }, { path: "skills/frontend-design/scripts/x.py", type: "blob" }, { path: "README.md", type: "blob" }] }),
      [raw("skills/pdf/SKILL.md")]: "---\nname: pdf\ndescription: Fill and merge PDF files.\n---\nUse pypdf.",
      [raw("skills/frontend-design/SKILL.md")]: SKILL_MD,
    });
    const run = skillWebRunner(web);
    const r = await run("find_skills", { query: "ux" }, { turnId: "t", chatId: "c", fileKey: "f", agent: "a", settings: settings("allow"), policy: "allow", signal: new AbortController().signal });
    const text = r.content[0].type === "text" ? r.content[0].text : "";
    expect(r.isError).toBeFalsy();
    expect(text).toContain("<untrusted-data");
    expect(text).toContain("frontend-design");
    expect(text).toContain('install_skill {url: "https://github.com/anthropics/skills/tree/main/skills/frontend-design"}');
    expect(text).not.toMatch(/- pdf —/);
    expect(scoreSkill("ux", { name: "frontend-design", description: "interfaces with high design quality", path: "" })).toBeGreaterThan(0);
    expect(skillHeader("---\nname: cut\ndescription: A cut file\n", "x")).toEqual({ name: "cut", description: "A cut file" });
  });
});

describe("install_skill: web or GitHub → the owner's card → Agents › Skills", () => {
  const url = "https://github.com/anthropics/skills/tree/main/skills/frontend-design";

  it("reads through reach's gate (asking when the policy is Ask), shows the skill on the card, then saves it", async () => {
    const s = setup({ web: "ask" });
    const { json, r } = await s.call("install_skill", { url });
    expect(r.isError).toBeFalsy();
    expect(s.asks.map((a) => a.tool)).toEqual(["read_skill"]);
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0].action).toBe("add a skill from outside Wecra");
    expect(s.cards[0].preview).toContain("name: frontend-design");
    expect(s.cards[0].preview).toContain("source: https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md");
    expect(s.cards[0].preview).toContain("Pick a bold aesthetic direction");
    expect(json.installed).toMatchObject({ name: "frontend-design", enabled: true });
    expect(s.log.map((e) => [e.tool, e.outcome])).toEqual([["read_skill", "ok"]]);
    expect(s.changed()).toBe(1);
    const listed = (await s.call("list_skills")).json;
    expect(listed.skills.map((k: { name: string }) => k.name)).toEqual(["frontend-design"]);
    expect(listed.builtIn.map((k: { name: string }) => k.name)).toEqual(["motion-design"]);
  });

  it("saves nothing when the owner denies the card, or the read", async () => {
    const denied = setup({ confirm: false });
    expect((await denied.call("install_skill", { url })).r.isError).toBe(true);
    expect(denied.repo.list).toHaveLength(0);
    const noRead = setup({ web: "ask", consent: false });
    const r = await noRead.call("install_skill", { url });
    expect(r.r.isError).toBe(true);
    expect(noRead.cards).toHaveLength(0);
    expect(noRead.repo.list).toHaveLength(0);
  });

  it("is refused with Web off, for an outside client, and from a repository the owner didn't pick", async () => {
    const off = setup({ web: "off" });
    expect((await off.call("install_skill", { url })).text).toMatch(/turned off/);
    const outside = setup({ confirm: null });
    expect((await outside.call("install_skill", { url })).text).toMatch(/Agents chat/);
    expect(outside.repo.list).toHaveLength(0);
    const gh = setup({ github: "allow", repos: ["acme/skills"] });
    expect((await gh.call("install_skill", { repo: "other/skills", path: "ux" })).r.isError).toBe(true);
    const ok = await gh.call("install_skill", { repo: "acme/skills", path: "ux", name: "acme-ux" });
    expect(ok.json.installed.name).toBe("acme-ux");
  });

  it("won't overwrite a skill of the same name unless asked; validates the file", async () => {
    const existing: AiSkill = { id: "old", name: "frontend-design", description: "Mine", instructions: "Mine.", enabled: false, createdAt: 1, updatedAt: 1 };
    const s = setup({ skills: [existing] });
    expect((await s.call("install_skill", { url })).text).toMatch(/already exists/);
    const replaced = await s.call("install_skill", { url, replace: true });
    expect(replaced.json.installed.id).toBe("old");
    expect(s.cards[0].action).toBe("replace a skill with one from outside Wecra");
    const bad = setup({ pages: { "https://example.com/x.md": "---\nname: x\n---\n" } });
    expect((await bad.call("install_skill", { url: "https://example.com/x.md" })).text).toMatch(/description/);
    expect(mentionsCode("Run `python scripts/fill.py` then npm install x")).toBe(true);
    expect(mentionsCode("Use a 4-column grid.")).toBe(false);
  });
});

describe("create / update / remove", () => {
  it("creates from fields or a SKILL.md, after the card; refuses bad names and duplicates", async () => {
    const s = setup();
    expect((await s.call("create_skill", { name: "UX Review", description: "d", instructions: "i" })).text).toMatch(/lowercase/);
    const made = await s.call("create_skill", { name: "ux-review", description: "Review a screen's UX.", instructions: "Check hierarchy, contrast, states." });
    expect(made.json.created.name).toBe("ux-review");
    expect(s.cards[0]).toMatchObject({ action: "add a skill" });
    expect((await s.call("create_skill", { text: "---\nname: ux-review\ndescription: again\n---\nx" })).text).toMatch(/already exists/);
    const fromText = await s.call("create_skill", { text: "---\nname: copy-tone\ndescription: Write in the brand's tone.\n---\nShort sentences." });
    expect(fromText.json.created.name).toBe("copy-tone");
    expect((await s.call("create_skill", { name: "huge", description: "d", instructions: "x".repeat(70 * 1024) })).text).toMatch(/too long/);
  });

  it("updates (turn off, rename) and removes, each confirmed; built-ins can't be touched", async () => {
    const s = setup({ skills: [{ id: "a1", name: "ux-review", description: "d", instructions: "i", enabled: true, createdAt: 1, updatedAt: 1 }] });
    const off = await s.call("update_skill", { name: "ux-review", enabled: false, newName: "ux-audit" });
    expect(off.json.updated).toMatchObject({ name: "ux-audit", enabled: false });
    expect(s.cards[0].target).toContain("turn off");
    expect((await s.call("remove_skill", { name: "motion-design" })).text).toMatch(/built-in/);
    const denied = setup({ confirm: false, skills: s.repo.list });
    expect((await denied.call("remove_skill", { id: "a1" })).r.isError).toBe(true);
    expect(denied.repo.list).toHaveLength(1);
    expect((await s.call("remove_skill", { id: "a1" })).json.removed.name).toBe("ux-audit");
    expect(s.repo.list).toHaveLength(0);
  });
});
