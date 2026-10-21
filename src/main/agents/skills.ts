import type { ConfirmRequest } from "../../shared/agents/appTools";
import { textResult, type ToolResult } from "../../shared/agents/tools";
import { parseSkillFile, skillNameOf, skillProblem, type SkillDraft } from "../../shared/ai/skillFile";
import type { AiRepository, AiSkill } from "../../shared/ai/types";
import type { ReachCaller, ReachHub, RunContext } from "./reach/hub";

/**
 * Agents manage the owner's Skills (Agents › Skills; docs/ai.md §2.10, docs/research/agent-parity.md §3): list,
 * create, update, remove, and install one found on the web or GitHub. The skills live in the store
 * (`Workspace/spaces/ai/skills/<id>.md`, `ai.saveSkill` / `ai.removeSkill` — the same calls the settings page makes),
 * so a new one shows in the UI and is offered to agents from the next message. Every change waits for the owner's
 * click on the chat's confirmation card, which shows exactly what will be saved; an outside MCP client (no chat) is
 * refused. A skill is text: its format and size are checked (skillFile.ts), nothing in it is run. Electron-free.
 */

export interface SkillToolDeps {
  repo(): Promise<Pick<AiRepository, "skills" | "saveSkill" | "removeSkill">>;
  /** Wecra's built-in skills (listed, not editable) */
  builtIns: readonly { name: string; description: string }[];
  /** The chat's confirmation card: the owner's answer; null without a chat (an outside client) */
  confirm(req: ConfirmRequest): Promise<boolean | null>;
  /** install_skill's source, read through reach's gate (Web or GitHub): its text, or the refusal as a result */
  readSource(args: Record<string, unknown>): Promise<{ text: string; source: string } | ToolResult>;
  /** A skill was saved or removed (the views read the list again) */
  changed?(): void;
}

const error = (text: string): ToolResult => textResult(text, true);

type Source = { text: string; source: string };

/**
 * install_skill's source through reach's gate (hub.ts): a `url` as Web's read_skill, `repo` + `path` as GitHub's
 * read_repo_file — the owner's policy (Off refused, Ask's card, Always allow), the org's switch, the budget, the time
 * limit and the access log, as for any read from outside. No caller (an outside client): refused.
 */
export function skillSourceVia(
  hub: Pick<ReachHub, "call">,
  caller: ReachCaller | null,
  readers: { web(url: string, ctx: RunContext): Promise<Source>; github(args: Record<string, unknown>, ctx: RunContext): Promise<Source> }
): SkillToolDeps["readSource"] {
  return async (args) => {
    if (!caller) return error("install_skill reads from the web or GitHub, which works only in Wecra's Agents chats.");
    let got: Source | null = null;
    const read = (job: () => Promise<Source>) => async (): Promise<ToolResult> => {
      try {
        got = await job();
        return textResult(`read ${got.source}`);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    };
    const url = str(args.url)?.trim();
    const r = url
      ? await hub.call(caller, "read_skill", { url }, (_tool, _a, ctx) => read(() => readers.web(url, ctx))())
      : await hub.call(caller, "read_repo_file", { repo: args.repo, path: args.path, ref: args.ref }, (_tool, a, ctx) => read(() => readers.github(a, ctx))());
    return got ?? (r.isError ? r : error("The skill couldn't be read."));
  };
}
const NO_CHAT = "Changing Skills needs the owner's confirmation in Wecra's Agents chat: ask them to do it there (or in Agent settings › Skills).";
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Phrases that mean a skill expects to run something: told to the owner on the card (nothing is ever run). */
const RUNS_CODE = /(^|\n)\s*(```(bash|sh|shell|zsh|python|py|js|javascript|ts|powershell))|\bscripts\/|\b(pip|npm|npx|pnpm|yarn|brew)\s+(install|run|i)\b|\bpython3?\s+\S+\.py\b|\bnode\s+\S+\.m?js\b/i;

export const mentionsCode = (instructions: string) => RUNS_CODE.test(instructions);

function preview(d: SkillDraft, extra: string[] = []): string {
  const body = d.instructions.length > 1800 ? `${d.instructions.slice(0, 1800)}\n[… ${d.instructions.length - 1800} more characters]` : d.instructions;
  return [`name: ${d.name}`, `description: ${d.description}`, ...extra, "", body].join("\n");
}

const view = (s: AiSkill) => ({ id: s.id, name: s.name, description: s.description, enabled: s.enabled, characters: s.instructions.length, updatedAt: new Date(s.updatedAt).toISOString() });

async function findSkill(deps: SkillToolDeps, args: Record<string, unknown>): Promise<{ all: AiSkill[]; skill: AiSkill | null; why?: string }> {
  const all = await (await deps.repo()).skills();
  const id = str(args.id)?.trim();
  const name = str(args.name)?.trim().replace(/^\//, "").toLowerCase();
  if (!id && !name) return { all, skill: null, why: "Give the skill's id or name (list_skills lists them)." };
  const skill = all.find((s) => (id && s.id === id) || (!id && s.name === name)) ?? null;
  if (!skill) {
    const builtIn = deps.builtIns.some((b) => b.name === name);
    return { all, skill: null, why: builtIn ? `“${name}” is one of Wecra's built-in skills: it can't be changed or removed (create a skill of the same name to use your own instead).` : `No skill ${id ?? `named “${name}”`} (list_skills lists them).` };
  }
  return { all, skill };
}

/** A draft from `text` (a whole SKILL.md) or the fields. */
function draftOf(args: Record<string, unknown>): SkillDraft | { error: string } {
  if (typeof args.text === "string" && args.text.trim()) {
    const parsed = parseSkillFile(args.text, str(args.name) ?? "");
    if ("error" in parsed) return parsed;
    return str(args.name) ? { ...parsed, name: skillNameOf(str(args.name)!) } : parsed;
  }
  const d = { name: skillNameOf(str(args.name) ?? ""), description: (str(args.description) ?? "").trim(), instructions: (str(args.instructions) ?? "").trim() };
  if (str(args.name) && d.name !== str(args.name)) return { error: `name: lowercase letters, numbers and hyphens (e.g. “${d.name || "ux-review"}”).` };
  const problem = skillProblem(d);
  return problem ? { error: problem } : d;
}

async function save(deps: SkillToolDeps, s: { id?: string; name: string; description: string; instructions: string; enabled?: boolean }): Promise<AiSkill> {
  const saved = await (await deps.repo()).saveSkill(s);
  deps.changed?.();
  return saved;
}

const NEXT = "It is in Agents › Skills now; enabled skills are offered to agents from the next message (get_skill reads it in this one).";

export async function runSkillTool(name: string, args: Record<string, unknown>, deps: SkillToolDeps): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_skills": {
        const all = await (await deps.repo()).skills();
        const own = new Set(all.map((s) => s.name));
        return textResult({ skills: all.sort((a, b) => a.name.localeCompare(b.name)).map(view), builtIn: deps.builtIns.filter((b) => !own.has(b.name)).map((b) => ({ name: b.name, description: b.description, builtIn: true })), how: "get_skill {name} reads one; create_skill / update_skill / remove_skill / install_skill change them (the owner confirms each)." });
      }
      case "create_skill": {
        const d = draftOf(args);
        if ("error" in d) return error(d.error);
        const all = await (await deps.repo()).skills();
        if (all.some((s) => s.name === d.name)) return error(`A skill named “${d.name}” already exists: update_skill changes it.`);
        const warn = mentionsCode(d.instructions) ? ["note: it mentions scripts or commands — agents here can't run them; only the text is kept"] : [];
        const ok = await deps.confirm({ action: "add a skill", target: `${d.name} (written by the agent)`, preview: preview(d, warn) });
        if (ok === null) return error(NO_CHAT);
        if (!ok) return error(`The owner didn't add “${d.name}”. Don't ask again for this request.`);
        const saved = await save(deps, { ...d, enabled: args.enabled !== false });
        return textResult({ created: view(saved), note: NEXT });
      }
      case "update_skill": {
        const found = await findSkill(deps, { id: args.id, name: args.id ? undefined : args.name });
        if (!found.skill) return error(found.why!);
        const s = found.skill;
        const next = {
          name: str(args.newName) !== undefined ? skillNameOf(str(args.newName)!) : s.name,
          description: str(args.description) !== undefined ? str(args.description)!.trim() : s.description,
          instructions: str(args.instructions) !== undefined ? str(args.instructions)!.trim() : s.instructions,
        };
        const problem = skillProblem(next);
        if (problem) return error(problem);
        if (next.name !== s.name && found.all.some((x) => x.name === next.name)) return error(`A skill named “${next.name}” already exists.`);
        const enabled = typeof args.enabled === "boolean" ? args.enabled : s.enabled;
        const changes = [next.name !== s.name ? `name → ${next.name}` : "", next.description !== s.description ? "description" : "", next.instructions !== s.instructions ? "instructions" : "", enabled !== s.enabled ? (enabled ? "turn on" : "turn off") : ""].filter(Boolean);
        if (!changes.length) return textResult({ unchanged: view(s) });
        const ok = await deps.confirm({ action: "change a skill", target: `${s.name}: ${changes.join(", ")}`, preview: next.instructions !== s.instructions || next.description !== s.description ? preview(next) : undefined });
        if (ok === null) return error(NO_CHAT);
        if (!ok) return error(`The owner didn't change “${s.name}”.`);
        const saved = await save(deps, { id: s.id, ...next, enabled });
        return textResult({ updated: view(saved), note: NEXT });
      }
      case "remove_skill": {
        const found = await findSkill(deps, args);
        if (!found.skill) return error(found.why!);
        const ok = await deps.confirm({ action: "remove a skill", target: `${found.skill.name} — ${found.skill.description.slice(0, 200)}` });
        if (ok === null) return error(NO_CHAT);
        if (!ok) return error(`The owner kept “${found.skill.name}”.`);
        await (await deps.repo()).removeSkill(found.skill.id);
        deps.changed?.();
        return textResult({ removed: { id: found.skill.id, name: found.skill.name } });
      }
      case "install_skill": {
        if (!str(args.url) && !str(args.repo)) return error("Give `url` (a SKILL.md or skill folder on the web — find_skills finds them) or `repo` + `path` (a GitHub repository you may read).");
        const src = await deps.readSource(args);
        if ("content" in src) return src;
        const fallback = (str(args.path) ?? str(args.url) ?? "").replace(/\/?SKILL\.md$/i, "").replace(/\/+$/, "").split("/").pop() ?? "";
        const parsed = parseSkillFile(src.text, fallback);
        if ("error" in parsed) return error(`${src.source} isn't a skill Wecra can install: ${parsed.error}`);
        const d: SkillDraft = str(args.name) ? { ...parsed, name: skillNameOf(str(args.name)!) } : parsed;
        const problem = skillProblem(d);
        if (problem) return error(problem);
        const all = await (await deps.repo()).skills();
        const existing = all.find((s) => s.name === d.name);
        if (existing && args.replace !== true) return error(`A skill named “${d.name}” already exists: install_skill with replace: true updates it, or name: "…" adds it under another name.`);
        const extra = [`source: ${src.source}`, ...(mentionsCode(d.instructions) ? ["note: it mentions scripts or commands — only the text is installed, nothing is run"] : [])];
        const ok = await deps.confirm({ action: existing ? "replace a skill with one from outside Wecra" : "add a skill from outside Wecra", target: `${d.name} — ${src.source}`, preview: preview(d, extra) });
        if (ok === null) return error(NO_CHAT);
        if (!ok) return error(`The owner didn't install “${d.name}”. Don't ask again for this request.`);
        const saved = await save(deps, { ...(existing ? { id: existing.id } : {}), ...d, enabled: args.enabled !== false });
        return textResult({ installed: view(saved), source: src.source, note: `${NEXT} Only its SKILL.md text was installed.` });
      }
    }
    return error(`Unknown tool ${name}`);
  } catch (err) {
    return error(`Skills: ${err instanceof Error ? err.message : String(err)}`);
  }
}
