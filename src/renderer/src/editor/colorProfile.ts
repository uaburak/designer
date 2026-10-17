/**
 * The document's colour profile (DOCUMENT.documentColorProfile, atlas 07 §14): sRGB or Display P3 (a LEGACY file reads
 * as sRGB). Changing it, as Figma's modal offers, either **converts** — every colour of the file rewritten so it looks
 * the same in the new profile (into sRGB, P3 colours outside it are clamped) — or **assigns** — the numbers kept, so
 * the colours look different. Convert is the default, the choice remembered per machine (Figma's localStorage
 * `preferred-document-color-profile-change-option`). One undo step; the canvas takes the new space at once (and on
 * undo / redo, attachColorProfile). Images keep their own pixels and tags.
 */
import { p3ToSrgb, srgbToP3 } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "./controller";
import { changesOf } from "./engineCompat";

export type DocumentProfile = "SRGB" | "DISPLAY_P3";
export type ProfileChange = "convert" | "assign";

const CHOICE_KEY = "preferred-document-color-profile-change-option";

export function documentProfile(ed: EditorController): DocumentProfile {
  const doc = ed.engine.readNode("0:0") as { documentColorProfile?: string } | null;
  return doc?.documentColorProfile === "DISPLAY_P3" ? "DISPLAY_P3" : "SRGB";
}

/** The last choice in the modal (Convert unless Assign was picked). */
export function preferredChange(): ProfileChange {
  try {
    return localStorage.getItem(CHOICE_KEY) === "assign" ? "assign" : "convert";
  } catch {
    return "convert";
  }
}

const isColor = (v: unknown): v is { r: number; g: number; b: number; a?: number } =>
  !!v && typeof v === "object" && !Array.isArray(v) && ["r", "g", "b"].every((k) => typeof (v as Record<string, unknown>)[k] === "number") && Object.keys(v).every((k) => k === "r" || k === "g" || k === "b" || k === "a");

/** `value` with every colour in it (any object of r, g, b and a) passed through `convert`; the same object when none is. */
export function mapColors<T>(value: T, convert: (c: { r: number; g: number; b: number }) => { r: number; g: number; b: number }): T {
  if (isColor(value)) return { ...value, ...convert(value) } as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((x) => {
      const y = mapColors(x, convert);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === "object") {
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(value)) {
      const y = mapColors(x, convert);
      if (y !== x) (out ??= { ...(value as Record<string, unknown>) })[k] = y;
    }
    return (out ?? value) as T;
  }
  return value;
}

/** The fields of a node that are never colours (and must not be written back). */
const SKIP = new Set(["guid", "phase", "type", "parentIndex", "childIds"]);

/** The fields of `n` whose colours change when converted (empty when none do). */
export function convertedFields(n: NodeChange, to: DocumentProfile): Record<string, unknown> {
  const convert = to === "DISPLAY_P3" ? (c: { r: number; g: number; b: number }) => srgbToP3(c.r, c.g, c.b) : (c: { r: number; g: number; b: number }) => p3ToSrgb(c.r, c.g, c.b);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (SKIP.has(k) || v === null || typeof v !== "object") continue;
    const next = mapColors(v, convert);
    if (next !== v) out[k] = next;
  }
  return out;
}

/** Changes the file's profile to `to`: converting its colours or assigning the profile to them (one undo step). */
export function changeColorProfile(ed: EditorController, to: DocumentProfile, how: ProfileChange): void {
  try {
    localStorage.setItem(CHOICE_KEY, how);
  } catch {
    // no storage: this session only
  }
  if (documentProfile(ed) === to) return;
  ed.batch(how === "convert" ? "Convert color profile" : "Assign color profile", () => {
    if (how === "convert")
      for (const n of ed.engine.readNodes(["0:0"], { subtree: true })) {
        const fields = convertedFields(n, to);
        if (Object.keys(fields).length) ed.engine.setProps([n.guid as Guid], fields);
      }
    ed.engine.setProps(["0:0"], { documentColorProfile: to } as never);
  });
  ed.engine.refreshColorProfile();
}

/** The canvas follows the profile when an undo or redo (or a collaborator) changes it. */
export function attachColorProfile(ed: EditorController): () => void {
  let last = ed.engine.colorProfile;
  return ed.engine.on("DOCUMENT_CHANGED", (e) => {
    if (!changesOf(e).some((c) => c.guid === "0:0" && "documentColorProfile" in c)) return;
    const now = documentProfile(ed);
    if (now === last) return;
    last = now;
    ed.engine.refreshColorProfile();
  });
}
