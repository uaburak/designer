/**
 * The composer's two small menus (Claude's desktop composer: "Opus 5.5" and "High" beside Send): a model by its short
 * name, grouped under its agent in the menu, and its effort when the agent has one. Antigravity's models carry their
 * effort in the slug (gemini-3.8-flash-low / -medium / -high: one model, three efforts); Claude Code and Codex take it
 * as a flag (`ProviderInfo.efforts`); the others have none (the effort menu is hidden).
 */
import type { SelectEntry, SelectOption } from "@/ds";
import type { ProviderInfo } from "@shared/agents/types";

export interface EffortOption {
  id: string;
  label: string;
  /** The model to run for it: the slug of that effort (Antigravity), or the model itself (a flag) */
  model: string;
}

export interface ModelOption {
  /** The model without its effort ("gemini-3.8-flash", "opus") */
  key: string;
  /** Its short name ("3.8 Flash", "Opus 5.5") */
  label: string;
  efforts: EffortOption[];
  /** Antigravity's way: the effort is the slug's */
  inSlug: boolean;
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LABEL: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
const byEffort = (a: { id: string }, b: { id: string }) => EFFORT_ORDER.indexOf(a.id) - EFFORT_ORDER.indexOf(b.id);

const VENDOR = /^(?:gemini|claude|google|anthropic)\b[\s-]*/i;
const ALIAS_LABEL: Record<string, string> = { default: "Default", auto: "Auto" };

/**
 * A model's short name: the agent's own label without the vendor ("Gemini 3.8 Flash" → "3.8 Flash", "Claude Opus 5.5"
 * → "Opus 5.5"), or from its id ("claude-opus-5-5-20261001" → "Opus 5.5", "gemini-3.1-pro" → "3.1 Pro").
 */
export function shortModelName(name: string): string {
  const s = name.trim();
  if (/\s/.test(s) || /^[A-Z]/.test(s)) return s.replace(VENDOR, "") || s;
  const id = s.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").replace(/@.*$/, "");
  if (!/^(?:claude|gemini)-/i.test(id)) return s;
  const words: string[] = [];
  for (const t of id.replace(VENDOR, "").split("-").filter(Boolean)) {
    const prev = words[words.length - 1];
    if (/^\d+$/.test(t) && prev && /^\d+(?:\.\d+)*$/.test(prev) && !prev.includes(".")) words[words.length - 1] = `${prev}.${t}`;
    else words.push(/^\d/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));
  }
  return words.join(" ") || s;
}

const SLUG_EFFORT = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;
const LABEL_EFFORT = /^(.+?)\s*\((Minimal|Low|Medium|High|Extra high|Xhigh|Max)\)$/i;

/** An Antigravity slug's model and effort ("gemini-3.8-flash-high" → gemini-3.8-flash, high), from its label too. */
function splitSlug(slug: string, label?: string): { key: string; effort: string | null; name: string } {
  const m = SLUG_EFFORT.exec(slug);
  const l = label ? LABEL_EFFORT.exec(label) : null;
  const name = l ? l[1] : (label ?? (m ? m[1] : slug));
  return m ? { key: m[1], effort: m[2], name } : { key: slug, effort: null, name };
}

/** What a CLI alias resolved to in its last turn (Claude Code: "opus" → "claude-opus-5-5"), keyed by provider and alias. */
export type ResolvedModels = Record<string, Record<string, string>>;

/** The provider's models for the menu: short names, each with its efforts. */
export function modelOptions(p: ProviderInfo, resolved: ResolvedModels = {}): ModelOption[] {
  const models = p.models.length ? p.models : [""];
  const slugged = !p.efforts?.length && p.kind === "antigravity";
  if (slugged) {
    const out: ModelOption[] = [];
    for (const slug of models) {
      const s = splitSlug(slug, p.modelLabels?.[slug]);
      let o = out.find((x) => x.key === s.key);
      if (!o) out.push((o = { key: s.key, label: shortModelName(s.name), efforts: [], inSlug: true }));
      // A model without an effort in its slug has none to pick.
      if (s.effort) o.efforts.push({ id: s.effort, label: effortLabel(s.effort), model: slug });
    }
    out.forEach((o) => o.efforts.sort(byEffort));
    return out;
  }
  const efforts = [...(p.efforts ?? [])].sort((a, b) => byEffort({ id: a }, { id: b }));
  return models.map((m) => {
    const real = resolved[p.id]?.[m || "default"];
    const label = real ? shortModelName(real) : m ? (p.modelLabels?.[m] ? shortModelName(p.modelLabels[m]) : (ALIAS_LABEL[m] ?? (p.kind === "openai-compatible" ? m : m.charAt(0).toUpperCase() + m.slice(1)))) : p.label;
    return { key: m, label, efforts: efforts.map((e) => ({ id: e, label: effortLabel(e), model: m })), inSlug: false };
  });
}

/** The model and effort a stored choice means: its option, and the effort (the slug's, or the flag's). */
export function currentOf(p: ProviderInfo, model: string | undefined, effort: string | undefined, resolved?: ResolvedModels): { option: ModelOption | undefined; effort: EffortOption | undefined } {
  const options = modelOptions(p, resolved);
  const m = model ?? p.models[0] ?? "";
  const flagEffort = (o: ModelOption) => o.efforts.find((x) => x.id === effort) ?? o.efforts.find((x) => x.id === p.efforts?.[0]) ?? o.efforts[0];
  for (const o of options) {
    if (o.inSlug) {
      const e = o.efforts.find((x) => x.model === m);
      if (e) return { option: o, effort: e };
      if (o.key === m) return { option: o, effort: undefined };
    } else if (o.key === m) return { option: o, effort: flagEffort(o) };
  }
  const first = options[0];
  return { option: first, effort: !first ? undefined : first.inSlug ? (first.efforts.find((x) => x.model === p.models[0]) ?? first.efforts[0]) : flagEffort(first) };
}

/** Switching to another model of an agent: the same effort when it has it, else the agent's default for it. */
export function pickModel(p: ProviderInfo, key: string, effort: string | undefined, resolved?: ResolvedModels): { model: string; effort?: string } {
  const o = modelOptions(p, resolved).find((x) => x.key === key);
  if (!o) return { model: key };
  // The agent's own default (its first slug, or its flag's first effort), else Medium, else the first.
  const pick = o.efforts.find((e) => e.id === effort) ?? o.efforts.find((e) => (o.inSlug ? e.model === p.models[0] : e.id === p.efforts?.[0])) ?? o.efforts.find((e) => e.id === "medium") ?? o.efforts[0];
  return { model: pick?.model ?? o.key, ...(pick ? { effort: pick.id } : {}) };
}

export const MODEL_SEP = "\u0000";

/** The model menu: each connected agent under its heading, its models by their short names. */
export function modelMenu(providers: ProviderInfo[], resolved?: ResolvedModels): SelectEntry[] {
  return providers
    .filter((p) => p.available)
    .flatMap((p): SelectEntry[] => [{ header: p.label }, ...modelOptions(p, resolved).map((o): SelectOption => ({ value: `${p.id}${MODEL_SEP}${o.key}`, label: o.label }))]);
}

/** The effort menu of the current model (empty: hidden). */
export const effortMenu = (o: ModelOption | undefined): SelectOption[] => (o?.efforts ?? []).map((e) => ({ value: e.id, label: e.label }));
