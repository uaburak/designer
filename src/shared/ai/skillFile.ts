/**
 * A Skill as a single `.md` file (docs/ai.md §2.10; the Agent Skills format Figma's custom skills take): YAML
 * frontmatter with `name` and `description`, then the instructions. Read when a file is uploaded ("Upload a file"),
 * written by Export (and by the store, 6g, for `Workspace/spaces/ai/skills/<id>.md`). And `/name` in a prompt: the
 * first skill named is the one invoked (Figma's rule).
 */
import { SKILL_LIMITS, SKILL_NAME_RE, type AiSkill } from "./types";

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

/** Why a draft can't be saved (Figma's limits: a lowercase-hyphen name ≤ 64, a description ≤ 1,024), or null. */
export function skillProblem(s: SkillDraft): string | null {
  if (!s.name) return "Add a name.";
  if (s.name.length > SKILL_LIMITS.name || !SKILL_NAME_RE.test(s.name)) return "Use lowercase letters, numbers and hyphens for the name (up to 64).";
  if (!s.description.trim()) return "Add a description, so agents know when to use it.";
  if (s.description.length > SKILL_LIMITS.description) return "Keep the description under 1,024 characters.";
  if (!s.instructions.trim()) return "Add instructions.";
  if (s.instructions.length > SKILL_LIMITS.instructions) return "The instructions are too long (64 KB at most).";
  return null;
}

/** A name made from any text: "Brand Voice!" → "brand-voice". */
export const skillNameOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.name)
    .replace(/-+$/, "");

/** A YAML scalar as written in frontmatter: plain, '…' or "…" (JSON escapes). */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** A `.md` file's skill (its file name the name's fallback), or why it can't be read. */
export function parseSkillFile(text: string, fileName = ""): SkillDraft | { error: string } {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const fields: Record<string, string> = {};
  let body = src;
  if (m) {
    body = m[2];
    const lines = m[1].split("\n");
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let value = kv[2];
      // A folded or literal block (`description: >` / `|`): the indented lines after it.
      if (/^[>|][-+]?$/.test(value.trim())) {
        const folded = value.trim().startsWith(">");
        const block: string[] = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
        value = block.join(folded ? " " : "\n").trim();
        fields[kv[1]] = value;
      } else fields[kv[1]] = scalar(value);
    }
  }
  const name = skillNameOf(fields.name ?? fileName.replace(/\.md$/i, ""));
  const draft = { name, description: (fields.description ?? "").trim(), instructions: body.trim() };
  const problem = skillProblem(draft);
  return problem ? { error: problem } : draft;
}

/** The skill as its `.md` file (Export). */
export function skillFileText(s: SkillDraft): string {
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.instructions.trim()}\n`;
}

/**
 * `/name` in a prompt: the first enabled skill named (a token `/name` at the start or after a space) and the prompt
 * without that token; null when it names none.
 */
export function invokedSkill<T extends Pick<AiSkill, "name" | "enabled">>(prompt: string, skills: readonly T[]): { skill: T; prompt: string } | null {
  const re = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    const skill = skills.find((s) => s.enabled && s.name === m![2]);
    if (skill) {
      const start = m.index + m[1].length;
      const rest = `${prompt.slice(0, start)}${prompt.slice(start + m[2].length + 1)}`.replace(/\s{2,}/g, " ").trim();
      return { skill, prompt: rest };
    }
  }
  return null;
}

/** The `/` popup: the enabled skills whose name starts with what is typed after the `/` at the caret. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([a-z0-9-]*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}
