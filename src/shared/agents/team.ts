/**
 * The team (docs/studio.md §9 [ours]): agents with one job each — a name, a role the manager reads, standing
 * instructions, an agent and model, the Skills they always work with and the tool groups they may use. Wecra ships a
 * default team (Post Designer, Reels Maker, Copywriter, Reviewer); the owner edits a default (his copy wins, Reset to
 * default drops it), removes one, or adds his own. Kept in AgentSettings.team (main's userData/agents/settings.json).
 * Pure: main, the views and the tests use it.
 */
import type { AgentRoute } from "../studio/types";
import type { AiRoute } from "../ai/types";

/** The tool groups a member may be limited to; reading tools are always on (READ_TOOLS). */
export type ToolGroupId = "layers" | "styles" | "prototype" | "motion" | "sound" | "social" | "app";

export const TOOL_GROUPS: readonly { id: ToolGroupId; label: string; tools: readonly string[] }[] = [
  { id: "layers", label: "Layers and pictures", tools: ["create_nodes", "update_nodes", "place_image", "delete_nodes", "duplicate_nodes", "reparent_nodes", "set_auto_layout", "set_properties", "run_command", "pathfinder", "create_responsive_variant", "export_nodes"] },
  { id: "styles", label: "Variables and styles", tools: ["bind_variable", "apply_variable", "create_variable_collection", "edit_variable_collection", "create_variable", "set_variable_value", "edit_variable", "set_variable_mode", "apply_style", "create_paint_style", "create_text_style", "create_effect_style", "create_grid_style"] },
  { id: "prototype", label: "Prototype", tools: ["add_interaction", "update_interaction", "remove_interaction", "set_flow_starting_point", "remove_flow_starting_point", "set_prototype_settings"] },
  { id: "motion", label: "Motion", tools: ["set_keyframes", "remove_keyframes", "set_timeline", "add_animation", "edit_animation", "remove_animations", "apply_animation_style", "save_animation_style", "detach_animation_style", "animate", "export_animation"] },
  { id: "sound", label: "Sound", tools: ["add_audio", "edit_audio", "generate_sound", "score_motion"] },
  { id: "social", label: "Social posts", tools: ["new_post", "apply_template", "fill_slots", "set_post", "resize_post", "set_campaign", "check_posts", "save_as_template", "export_posts"] },
  {
    id: "app",
    label: "Comments, versions and files",
    tools: ["add_comment", "reply_comment", "edit_comment", "resolve_comment", "delete_comment", "save_version", "restore_version", "swap_library", "set_library_enabled", "accept_library_updates", "insert_library_component", "publish_library", "create_file", "file_action", "share_file", "set_dev_status", "run_plugin", "set_app_setting", "create_skill", "update_skill", "remove_skill", "install_skill"],
  },
];

export const TOOL_GROUP_IDS: readonly ToolGroupId[] = TOOL_GROUPS.map((g) => g.id);

/** One member of the team. */
export interface TeamMember {
  /** "post-designer": what the manager's delegate_task and the composer's @ name */
  id: string;
  name: string;
  /** One line: what this member does — the manager picks by it */
  role: string;
  /** Standing instructions: they open every task the member runs */
  instructions: string;
  /** Its agent, model and effort; null: the manager's General work */
  route: AgentRoute | null;
  /** The image model its pictures come from (make_posts); null / absent: the manager's (Agent settings › Manager › Images) */
  image?: AiRoute | null;
  /** Skills it always works with (names), their instructions given with each task */
  skills: string[];
  /** The tool groups it may use; null: every tool */
  tools: ToolGroupId[] | null;
  enabled: boolean;
}

/** A member as the settings list and the manager see it: a default, the owner's copy of one, or the owner's own. */
export interface TeamEntry extends TeamMember {
  origin?: "default" | "override";
}

/** What AgentSettings keeps: the owner's members (his own and his copies of defaults) and the defaults he removed. */
export interface TeamSettings {
  members: TeamMember[];
  removed: string[];
}

export const EMPTY_TEAM: TeamSettings = { members: [], removed: [] };

export const TEAM_LIMITS = { members: 24, name: 40, role: 300, instructions: 8000, skills: 12 } as const;
export const MEMBER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_TEAM: readonly TeamMember[] = [
  {
    id: "post-designer",
    name: "Post Designer",
    role: "Designs static social media posts, stories and carousels on the canvas from the brand's colours, fonts, logo and product pictures.",
    instructions:
      "You design social media posts. Work in the post's frame at its format's size; keep text and the logo inside the safe area. Use the brand's colours, fonts and logo (variables and styles first, never invented ones). One clear message per post: a strong headline, the product large and sharp, a short call to action. Prefer the board's templates when one fits (list_templates, apply_template, fill_slots). Check your work with get_screenshot before you answer.",
    route: null,
    // The owner's posts take their pictures from Antigravity (2026-11-03); the Gemini API is the other choice.
    image: { providerId: "antigravity" },
    skills: ["social-campaign", "brand-guidelines", "canvas-design"],
    tools: ["layers", "styles", "social"],
    enabled: true,
  },
  {
    id: "reels-maker",
    name: "Reels Maker",
    role: "Turns posts into Reels and animated stories: motion, timing, sound and the MP4 export.",
    instructions:
      "You make Reels and animated stories. The post's frame is the timeline: animate its layers, never the frame. Write the whole piece as one animate script, look at it with get_motion_frames and refine. Keep it 6–15 s, the first second strong, text on screen long enough to read. Score it with sound (score_motion, generate_sound) unless told not to, and export an MP4 when asked.",
    route: null,
    skills: ["motion-opus", "sound-design", "social-campaign"],
    tools: ["layers", "styles", "motion", "sound", "social"],
    enabled: true,
  },
  {
    id: "copywriter",
    name: "Copywriter",
    role: "Writes and fixes captions, hashtags, alt text and the texts on posts, in Turkish or English, within each platform's limits.",
    instructions:
      "You write the words of social media posts: headlines and texts on the post, captions, hashtags and alt text (set_post). Short, concrete, in the brand's voice; the language the owner wrote in unless told otherwise. Respect the format's caption and hashtag limits (get_board, check_posts). Change only texts — no layout, colours or pictures.",
    route: null,
    skills: ["turkish-microcopy", "social-campaign", "brand-guidelines"],
    tools: ["layers", "social"],
    enabled: true,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Checks finished posts against the brief and the brand — typos, contrast, safe areas, the logo, platform limits — fixes small things and comments on the rest.",
    instructions:
      "You review social media posts. Look at each one (get_screenshot, check_posts) against the request and the brand: spelling, text inside the safe area, contrast, the right logo and colours, caption limits. Fix small things yourself (a typo, a text out of the safe area); for anything bigger add a comment pinned on the layer saying what is wrong and why. Answer with a short list: fixed, commented, fine.",
    route: null,
    skills: ["brand-guidelines", "accessibility-audit", "ux-review"],
    tools: ["layers", "social", "app"],
    enabled: true,
  },
];

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null);

function route(v: unknown): AgentRoute | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const providerId = str(r.providerId, 100);
  if (!providerId) return null;
  const model = str(r.model, 300);
  const effort = str(r.effort, 20);
  return { providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** One line, spaces collapsed, no control characters. */
const oneLine = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = Array.from(v.replace(/\s+/g, " "))
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim();
  return s ? Array.from(s).slice(0, max).join("") : null;
};

/** A member from a view or settings.json, every field checked and bounded; null when it has no usable id or name. */
export function cleanMember(v: unknown): TeamMember | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const id = typeof m.id === "string" && MEMBER_ID_RE.test(m.id) && m.id.length <= 64 ? m.id : null;
  const name = oneLine(m.name, TEAM_LIMITS.name);
  if (!id || !name) return null;
  const skills = Array.isArray(m.skills) ? [...new Set(m.skills.filter((s): s is string => typeof s === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 64))].slice(0, TEAM_LIMITS.skills) : [];
  const tools = Array.isArray(m.tools) ? TOOL_GROUP_IDS.filter((g) => (m.tools as unknown[]).includes(g)) : null;
  return {
    id,
    name,
    role: oneLine(m.role, TEAM_LIMITS.role) ?? "",
    instructions: typeof m.instructions === "string" ? m.instructions.trim().slice(0, TEAM_LIMITS.instructions) : "",
    route: route(m.route),
    image: route(m.image),
    skills,
    tools,
    enabled: m.enabled !== false,
  };
}

/** AgentSettings.team as a view sent it or settings.json kept it, cleaned. */
export function cleanTeam(v: unknown): TeamSettings {
  if (!v || typeof v !== "object") return { members: [], removed: [] };
  const t = v as Record<string, unknown>;
  const seen = new Set<string>();
  const members: TeamMember[] = [];
  for (const raw of Array.isArray(t.members) ? t.members : []) {
    const m = cleanMember(raw);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    members.push(m);
    if (members.length >= TEAM_LIMITS.members) break;
  }
  const removed = Array.isArray(t.removed) ? [...new Set(t.removed.filter((id): id is string => typeof id === "string" && DEFAULT_TEAM.some((d) => d.id === id)))] : [];
  return { members, removed };
}

/** The whole team: the defaults (the owner's copy in their place, the removed left out), then his own, in order. */
export function teamOf(team: TeamSettings | undefined, defaults: readonly TeamMember[] = DEFAULT_TEAM): TeamEntry[] {
  const own = team?.members ?? [];
  const removed = new Set(team?.removed ?? []);
  const out: TeamEntry[] = [];
  for (const d of defaults) {
    if (removed.has(d.id)) continue;
    const copy = own.find((m) => m.id === d.id);
    out.push(copy ? { ...copy, origin: "override" } : { ...d, image: d.image ? { ...d.image } : null, skills: [...d.skills], tools: d.tools ? [...d.tools] : null, origin: "default" });
  }
  for (const m of own) if (!defaults.some((d) => d.id === m.id)) out.push({ ...m });
  return out;
}

export const defaultMember = (id: string): TeamMember | undefined => DEFAULT_TEAM.find((d) => d.id === id);

/** A member saved: the owner's own, or his copy of a default. */
export function withMember(team: TeamSettings | undefined, member: TeamMember): TeamSettings {
  const t = team ?? EMPTY_TEAM;
  const members = t.members.some((m) => m.id === member.id) ? t.members.map((m) => (m.id === member.id ? member : m)) : [...t.members, member];
  return { members, removed: t.removed.filter((id) => id !== member.id) };
}

/** A member removed: the owner's own goes; a default (or his copy of it) is left out from now on. */
export function withoutMember(team: TeamSettings | undefined, id: string): TeamSettings {
  const t = team ?? EMPTY_TEAM;
  return { members: t.members.filter((m) => m.id !== id), removed: defaultMember(id) ? [...new Set([...t.removed, id])] : t.removed };
}

/** A default member back as Wecra ships it (the owner's copy dropped, and back in the team if removed). */
export function resetMember(team: TeamSettings | undefined, id: string): TeamSettings {
  const t = team ?? EMPTY_TEAM;
  return { members: t.members.filter((m) => m.id !== id), removed: t.removed.filter((x) => x !== id) };
}

/** An id for a new member from its name ("Story Designer" → "story-designer"), unique in the team. */
export function memberIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "member";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The tools a member may not call: every tool of the groups it doesn't have (null: none denied). */
export function deniedTools(tools: readonly ToolGroupId[] | null | undefined): Set<string> {
  if (!tools) return new Set();
  return new Set(TOOL_GROUPS.filter((g) => !tools.includes(g.id)).flatMap((g) => g.tools));
}

/** What a turn carries for the member running it (TurnRequest.member): main gives the instructions and Skills and limits the tools. */
export interface TurnMember {
  id: string;
  name: string;
  instructions: string;
  skills: string[];
  tools: ToolGroupId[] | null;
}

export const turnMember = (m: TeamMember): TurnMember => ({ id: m.id, name: m.name, instructions: m.instructions, skills: [...m.skills], tools: m.tools ? [...m.tools] : null });

/** A TurnMember from a view, cleaned (main). */
export function cleanTurnMember(v: unknown): TurnMember | null {
  const m = cleanMember({ ...(v && typeof v === "object" ? v : {}), role: "", route: null, image: null });
  return m ? turnMember(m) : null;
}

/**
 * The block that opens a member's turn: who it is, its instructions, its Skills' instructions (the ones that exist),
 * and the tools it hasn't got.
 */
export function memberBrief(m: TurnMember, skills: readonly { name: string; instructions: string }[]): string {
  const lines = [`[You are ${m.name}, a member of the owner's team.${m.instructions ? `\n${m.instructions}` : ""}]`];
  for (const s of skills) lines.push(`<skill name="${s.name}">\n${s.instructions}\n</skill>`);
  if (m.tools) {
    const off = TOOL_GROUPS.filter((g) => !m.tools!.includes(g.id)).map((g) => g.label.toLowerCase());
    if (off.length) lines.push(`[Not your job: ${off.join(", ")} — those tools aren't yours. Say so if the task needs them.]`);
  }
  return lines.join("\n\n");
}

/** The composer's `@member` at the message's start: the member's id and the rest of the message. */
export function mentionOf(text: string): { id: string; rest: string } | null {
  const m = /^@([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+|$)([\s\S]*)$/.exec(text.trimStart());
  return m ? { id: m[1], rest: m[2].trim() } : null;
}

/** The `@` being typed before the caret (the composer's list): where it starts and what was typed after it. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /^(\s*)@([a-z0-9-]*)$/.exec(before);
  return m ? { start: m[1].length, query: m[2] } : null;
}

/** The team as the manager's instructions list it. */
export function teamLines(team: readonly TeamEntry[]): string {
  return team
    .filter((m) => m.enabled)
    .map((m) => `- ${m.id} (${m.name}): ${m.role}`)
    .join("\n");
}
