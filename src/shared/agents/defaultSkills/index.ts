/**
 * Wecra's default skills (docs/ai.md §8.6; [ours]): a pack of skills shipped with the app, listed in Agents › Skills
 * with a "Default" badge, on unless the owner turns one off, and editable — editing saves the owner's own skill of the
 * same name (an override, in the store like any skill), "Reset to default" removes it. Which defaults are off is kept
 * per user in the store (`ai.defaultSkillsOff` / `ai.setDefaultSkillOn`, `skills.json`). One merge (`withDefaults`)
 * serves the settings page, the `/` list, the chat's skill list (renderer), `get_skill` and the skill tools (main).
 */
import type { AiSkill } from "../../ai/types";
import { ACCESSIBILITY_AUDIT } from "./accessibilityAudit";
import { BRAND_GUIDELINES } from "./brandGuidelines";
import { CANVAS_DESIGN } from "./canvasDesign";
import { CODE_TO_DESIGN } from "./codeToDesign";
import { COMPONENT_AUTHORING } from "./componentAuthoring";
import { DEV_HANDOFF } from "./devHandoff";
import { FRONTEND_DESIGN } from "./frontendDesign";
import { MOTION_OPUS } from "./motionOpus";
import { PROTOTYPE_BUILDER } from "./prototypeBuilder";
import { SOCIAL_CAMPAIGN } from "./socialCampaign";
import { SOUND_SKILL } from "./soundDesign";
import { THEME_FACTORY } from "./themeFactory";
import { TURKISH_MICROCOPY } from "./turkishMicrocopy";
import { UX_REVIEW } from "./uxReview";
import { WECRA_DESIGN_SYSTEM } from "./wecraDesignSystem";
import type { DefaultSkill } from "./types";

export type { DefaultSkill } from "./types";
export { MOTION_OPUS, SOUND_SKILL };

export const DEFAULT_SKILLS: readonly DefaultSkill[] = [
  ACCESSIBILITY_AUDIT,
  BRAND_GUIDELINES,
  CANVAS_DESIGN,
  CODE_TO_DESIGN,
  COMPONENT_AUTHORING,
  DEV_HANDOFF,
  FRONTEND_DESIGN,
  MOTION_OPUS,
  PROTOTYPE_BUILDER,
  SOCIAL_CAMPAIGN,
  SOUND_SKILL,
  THEME_FACTORY,
  TURKISH_MICROCOPY,
  UX_REVIEW,
  WECRA_DESIGN_SYSTEM,
];

export const DEFAULT_SKILL_BY_NAME: ReadonlyMap<string, DefaultSkill> = new Map(DEFAULT_SKILLS.map((s) => [s.name, s]));

/** Old names answered by a default (motion-design was the built-in motion skill before motion-opus took it in). */
export const SKILL_ALIASES: Readonly<Record<string, string>> = { "motion-design": MOTION_OPUS.name };

/** A default's id in merged lists ("default:ux-review"); never a store id (those are `[A-Za-z0-9_-]`). */
export const DEFAULT_SKILL_PREFIX = "default:";
export const defaultSkillId = (name: string) => `${DEFAULT_SKILL_PREFIX}${name}`;

/**
 * A skill as the owner sees it: his own, a default as shipped (`origin: "default"`, id "default:<name>"), or his
 * copy of a default (`origin: "override"`, the store's id — it wins over the shipped text).
 */
export type SkillEntry = AiSkill & { origin?: "default" | "override" };

/** The owner's skills with the defaults merged in, by name. `off`: the defaults he turned off. */
export function withDefaults(own: readonly AiSkill[], off: readonly string[] = [], defaults: readonly DefaultSkill[] = DEFAULT_SKILLS): SkillEntry[] {
  const byName = new Map(own.map((s) => [s.name, s]));
  const out: SkillEntry[] = own.map((s) => (defaults.some((d) => d.name === s.name) ? { ...s, origin: "override" as const } : { ...s }));
  for (const d of defaults)
    if (!byName.has(d.name)) out.push({ id: defaultSkillId(d.name), name: d.name, description: d.description, instructions: d.instructions, enabled: !off.includes(d.name), createdAt: 0, updatedAt: 0, origin: "default" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What `get_skill {name}` answers from a merged list: the enabled skill of that name — the owner's own or his copy of
 * a default before the shipped one — or, when nothing has that name, the default an old name points to (motion-design →
 * motion-opus). A default turned off answers nothing.
 */
export function skillToAnswer(name: string, entries: readonly SkillEntry[]): SkillEntry | undefined {
  const alias = entries.some((k) => k.name === name) ? undefined : SKILL_ALIASES[name];
  return entries.find((k) => k.enabled && k.name === (alias ?? name));
}

/** The default `name` refers to (an alias resolved), or undefined. */
export const defaultSkillFor = (name: string, defaults: readonly DefaultSkill[] = DEFAULT_SKILLS): DefaultSkill | undefined =>
  defaults.find((d) => d.name === name) ?? defaults.find((d) => d.name === SKILL_ALIASES[name]);
