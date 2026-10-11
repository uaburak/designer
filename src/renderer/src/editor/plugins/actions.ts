/**
 * Actions (⌘K) › Plugins & widgets and the Tools tab (docs/plugins.md §6): the plugins as rows by section — Recents,
 * Saved, Development, From ‹org› — and, while typing, each plugin's `menu` commands as rows of their own (Figma's
 * Quick Actions). A row with parameters (the manifest's, or its menu command's) prompts for them before it runs.
 */
import type { PluginManifest, PluginMenuItem, PluginParameter, PluginRef } from "@shared/plugins/types";
import type { PluginService } from "./service";

export interface PluginRow {
  key: string;
  label: string;
  section: string;
  ref: PluginRef;
  command: string;
  parameters: PluginParameter[] | null;
  disabled: string | null;
}

function commandRows(manifest: PluginManifest | null, ref: PluginRef, section: string, disabled: string | null): PluginRow[] {
  const out: PluginRow[] = [];
  const walk = (items: readonly PluginMenuItem[], path: string[]) => {
    for (const m of items) {
      if ("separator" in m) continue;
      if ("menu" in m) walk(m.menu, [...path, m.name]);
      else out.push({ key: `${section}:${ref.id}:${m.command}`, label: [ref.name, ...path, m.name].join(" › "), section, ref, command: m.command, parameters: m.parameters ?? null, disabled });
    }
  };
  walk(manifest?.menu ?? [], []);
  return out;
}

const score = (label: string, q: string) => {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 3;
  if (l.split(/[\s›/-]+/).some((w) => w.startsWith(q))) return 2;
  return l.includes(q) ? 1 : 0;
};

/** The rows of Plugins & widgets (`query` empty: by section; else the matches, commands included, best first). */
export function pluginRows(s: PluginService, query: string, orgName: string | null = null): PluginRow[] {
  const snap = s.get();
  const row = (ref: PluginRef, section: string, disabled: string | null = null): PluginRow => ({
    key: `${section}:${ref.source.type}:${ref.id}`,
    label: ref.name,
    section,
    ref,
    command: "",
    parameters: s.manifestOf(ref.id)?.parameters ?? null,
    disabled,
  });
  const org = `From ${orgName ?? snap.orgName ?? "your organization"}`;
  const sections: PluginRow[] = [
    ...snap.recents.map((r) => row(r, "Recents")),
    ...snap.saved.map((r) => row(r, "Saved")),
    ...snap.development.map((e) => row(e.ref, "Development", e.disabled)),
    ...snap.organization.map((e) => row(e.ref, org, e.disabled)),
  ];
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const all: PluginRow[] = [];
  const seen = new Set<string>();
  for (const e of s.entries()) {
    const section = e.ref.source.type === "development" ? "Development" : org;
    for (const r of [row(e.ref, section, e.disabled), ...commandRows(e.manifest, e.ref, section, e.disabled)]) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      all.push(r);
    }
  }
  return all
    .map((r) => ({ r, k: score(r.label, q) }))
    .filter((x) => x.k > 0)
    .sort((a, b) => b.k - a.k)
    .map((x) => x.r);
}

/** A suggestion as the parameters prompt shows it (Figma's: a string, or {name, data, icon?}). */
export interface Suggestion {
  name: string;
  data: unknown;
}

export function suggestionsOf(v: unknown): Suggestion[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? { name: x, data: x } : x && typeof x === "object" ? { name: String((x as { name?: unknown }).name ?? ""), data: "data" in (x as object) ? (x as { data: unknown }).data : (x as { name?: unknown }).name } : { name: String(x), data: x }));
}
