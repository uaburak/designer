/**
 * Branching's pure parts (docs/editor.md "Branching", docs/data.md §15): the change list grouped as Figma's review
 * lists it (page, then top-level layer — DiffChunk's display node), the change tags, the review badges, the picks of
 * Resolve conflicts as `Resolutions`, and the branches modal's rows. Wording: docs/research/figma/R21-branching-ui.md.
 */
import { t, tp } from "@/i18n";
import type { BranchRecord, BranchReview, MergePreview } from "../../../../shared/merge/branches";
import type { ChunkDetail, DiffChunk, Resolutions, Side } from "../../../../shared/merge/types";

export type ChangeTag = "Added" | "Edited" | "Removed" | "Updated library";

/**
 * A chunk's tag (Figma's DiffChunk phases, atlas 16 §4.5): its display node created, removed, a library copy the other
 * side updated (UPDATED_LIBRARY — its English isn't read: "Updated library"), or changed inside.
 */
export function changeTag(c: Pick<DiffChunk, "phase" | "libraryUpdate">): ChangeTag {
  return c.phase === "CREATED" ? "Added" : c.phase === "REMOVED" ? "Removed" : c.libraryUpdate ? "Updated library" : "Edited";
}

/**
 * A field's name as the change details say it. Figma's own vocabulary (`branching_node_treatments.property.*`, 152
 * keys) isn't read in English: the panel's words for the fields it shows, else the field's name in words.
 */
const PROPERTY_NAMES: Record<string, string> = {
  name: "Name",
  visible: "Visibility",
  locked: "Lock",
  opacity: "Opacity",
  blendMode: "Blend mode",
  transform: "Position",
  size: "Size",
  parentIndex: "Layer order",
  fillPaints: "Fill",
  strokePaints: "Stroke",
  strokeWeight: "Stroke weight",
  strokeAlign: "Stroke position",
  effects: "Effects",
  cornerRadius: "Corner radius",
  rectangleTopLeftCornerRadius: "Corner radius",
  rectangleTopRightCornerRadius: "Corner radius",
  rectangleBottomLeftCornerRadius: "Corner radius",
  rectangleBottomRightCornerRadius: "Corner radius",
  textData: "Text",
  fontName: "Font",
  fontSize: "Font size",
  lineHeight: "Line height",
  letterSpacing: "Letter spacing",
  stackMode: "Auto layout",
  stackSpacing: "Gap",
  stackHorizontalPadding: "Padding",
  stackVerticalPadding: "Padding",
  stackPaddingRight: "Padding",
  stackPaddingBottom: "Padding",
  componentPropDefs: "Component properties",
  symbolData: "Overrides",
  prototypeInteractions: "Interactions",
  exportSettings: "Export",
  layoutGrids: "Layout guides",
  horizontalConstraint: "Constraints",
  verticalConstraint: "Constraints",
  mask: "Mask",
  vectorData: "Vector",
  styleIdForFill: "Fill style",
  styleIdForStrokeFill: "Stroke style",
  styleIdForEffect: "Effect style",
  styleIdForText: "Text style",
  variableConsumptionMap: "Variables",
};

export function propertyName(field: string): string {
  const known = PROPERTY_NAMES[field];
  if (known) return t(known);
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A node's change details as lines: "Fill changed", "Effects added" … (one per property name); created / removed whole */
export function detailLines(d: Pick<ChunkDetail, "phase" | "fields">): string[] {
  if (d.phase === "created") return [t("Added")];
  if (d.phase === "removed") return [t("Removed")];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of d.fields) {
    const name = propertyName(f.field);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(f.change === "added" ? t("{property} added", { property: name }) : f.change === "removed" ? t("{property} removed", { property: name }) : t("{property} changed", { property: name }));
  }
  return out;
}

export interface ChunkGroup {
  /** The page's id, or "assets" for the internal page's chunks */
  id: string;
  /** The page's name ("Assets": variables, styles, components on the internal page — unverified) */
  name: string;
  chunks: DiffChunk[];
}

/** Chunks by page in the order they come (the merge core's: the document's page order), assets last. */
export function groupChunks(chunks: readonly DiffChunk[]): ChunkGroup[] {
  const pages = new Map<string, ChunkGroup>();
  let assets: ChunkGroup | null = null;
  for (const c of chunks) {
    if (c.canvasIsInternal || !c.canvasId) {
      (assets ??= { id: "assets", name: t("Assets"), chunks: [] }).chunks.push(c);
      continue;
    }
    let g = pages.get(c.canvasId);
    if (!g) pages.set(c.canvasId, (g = { id: c.canvasId, name: c.canvasName || t("Page"), chunks: [] }));
    g.chunks.push(c);
  }
  return [...pages.values(), ...(assets ? [assets] : [])];
}

/** Chunks holding conflicts, in list order. */
export const conflictChunks = (p: Pick<MergePreview, "chunks">) => p.chunks.filter((c) => c.conflicts.length > 0);

/**
 * The side picked for a chunk: its own pick, else Resolve all's, else — when each of its conflicts is picked one by
 * one and all agree — that side; null while unpicked.
 */
export function pickOf(picks: Resolutions, chunk: Pick<DiffChunk, "index" | "conflicts">): Side | null {
  const own = picks[`chunk:${chunk.index}`];
  if (own) return own;
  if (picks["*"]) return picks["*"];
  const sides = new Set(chunk.conflicts.map((id) => picks[id]));
  if (sides.size === 1) {
    const [s] = [...sides];
    return s ?? null;
  }
  return null;
}

/** A pick per chunk (`chunk:<index>`, docs/data.md §15.6); a new pick replaces the conflict-level ones it covers. */
export function withPick(picks: Resolutions, chunk: Pick<DiffChunk, "index" | "conflicts">, side: Side): Resolutions {
  const next: Resolutions = { ...picks, [`chunk:${chunk.index}`]: side };
  for (const id of chunk.conflicts) delete next[id];
  return next;
}

/** Resolve all › Pick main file / Pick branch: every chunk's conflicts to one side (`*`); single picks give way. */
export const pickAll = (side: Side): Resolutions => ({ "*": side });

/** Every conflict chunk picked (Next / Apply changes / Merge enabled). */
export function allPicked(picks: Resolutions, p: Pick<MergePreview, "chunks">): boolean {
  return conflictChunks(p).every((c) => pickOf(picks, c) !== null);
}

export type BadgeKind = "In review" | "Approved" | "Changes suggested" | "Merged" | "Archived";

/** The badge next to a branch's name (R21: the grey "In review", "Approved", "Changes suggested"; Merged / Archived). */
export function branchBadge(b: Pick<BranchRecord, "status" | "review">): BadgeKind | null {
  if (b.status === "merged") return "Merged";
  if (b.status === "archived") return "Archived";
  return reviewBadge(b.review);
}

export function reviewBadge(r: BranchReview | null): "In review" | "Approved" | "Changes suggested" | null {
  if (!r || r.state === "closed") return null;
  return r.state === "approved" ? "Approved" : r.state === "changes-suggested" ? "Changes suggested" : "In review";
}

export const badgeTone = (b: BadgeKind): "default" | "success" | "warning" => (b === "Approved" ? "success" : b === "Changes suggested" ? "warning" : "default");

/** Who the viewer is in a branch's review: its author, one of its reviewers, or neither. */
export function reviewRole(b: Pick<BranchRecord, "createdBy" | "review">, me: { id: string | null }): "author" | "reviewer" | "other" {
  if (me.id !== null && b.review?.reviewers.some((r) => r.userId === me.id)) return "reviewer";
  if (b.createdBy.id === me.id || b.createdBy.id === null) return "author";
  return "other";
}

/** "Send to 1 reviewer" / "Send to 3 reviewers" (R21 [request]: the alt text and the button). */
export const sendLabel = (n: number) => tp(n, "Send to {n} reviewer", "Send to {n} reviewers");

/** A branches-modal row's line under the name: "‹author› · ‹when›". */
export function branchMeta(b: Pick<BranchRecord, "createdBy" | "createdAt">, now = Date.now()): string {
  return `${b.createdBy.id === null ? t("You") : (b.createdBy.name ?? t("Someone"))} · ${ago(b.createdAt, now)}`;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t("Just now");
  const m = Math.round(s / 60);
  if (m < 60) return tp(m, "{n} minute ago", "{n} minutes ago");
  const h = Math.round(m / 60);
  if (h < 24) return tp(h, "{n} hour ago", "{n} hours ago");
  const d = Math.round(h / 24);
  return tp(d, "{n} day ago", "{n} days ago");
}

/** A branch's link: main's link with `/branch/<key>` (docs/data.md §15.1 Access); local branches have none. */
export function branchLink(mainLink: string, branchKey: string): string {
  try {
    const u = new URL(mainLink);
    u.pathname = `${u.pathname.replace(/\/$/, "")}/branch/${branchKey}`;
    return u.toString();
  } catch {
    return `${mainLink.replace(/\/$/, "")}/branch/${branchKey}`;
  }
}
