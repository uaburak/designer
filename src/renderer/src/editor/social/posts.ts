/**
 * A post's record and a page's campaigns as they sit in the document (docs/social.md §3.1, §3.2): plugin data under
 * the reserved plugin ID `designer.social` — `post` on the top-level frame, `campaigns` on the page (CANVAS). Reads are
 * tolerant (bad JSON, missing or mistyped fields read as the defaults; a record without a format is not a post);
 * writes keep every other pluginData entry. The writes here are raw engine writes: they run inside an action's Writer
 * (actions.ts), which makes them one undo step.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { POST_STATUSES, readSocial, withSocial, type PluginDataEntry, type PostProblem, type SocialCampaign, type SocialPostData } from "@shared/social/types";
import type { EditorController } from "../controller";

type WithPluginData = NodeChange & { pluginData?: PluginDataEntry[] };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A post's record with every field present; null when `raw` isn't one (no format id). */
export function normalizePost(raw: unknown): SocialPostData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.formatId !== "string" || !r.formatId) return null;
  const template = r.template && typeof r.template === "object" && typeof (r.template as { key?: unknown }).key === "string" ? { key: (r.template as { key: string }).key, variant: str((r.template as { variant?: unknown }).variant) } : null;
  const group = r.group && typeof r.group === "object" && typeof (r.group as { id?: unknown }).id === "string" ? { id: (r.group as { id: string }).id, index: Number((r.group as { index?: unknown }).index) || 0 } : null;
  return {
    v: 1,
    formatId: r.formatId,
    brandId: typeof r.brandId === "string" ? r.brandId : null,
    productIds: strs(r.productIds),
    campaignId: typeof r.campaignId === "string" ? r.campaignId : null,
    template,
    group,
    caption: str(r.caption),
    hashtags: strs(r.hashtags),
    altText: str(r.altText),
    status: POST_STATUSES.includes(r.status as SocialPostData["status"]) ? (r.status as SocialPostData["status"]) : "draft",
    problems: Array.isArray(r.problems) ? (r.problems.filter((p) => p && typeof p === "object" && typeof (p as PostProblem).id === "string") as PostProblem[]) : [],
    exportedAt: typeof r.exportedAt === "number" ? r.exportedAt : null,
  };
}

/** A new post's record: a draft of `formatId`, nothing written yet. */
export function postRecord(formatId: string, over: Partial<SocialPostData> = {}): SocialPostData {
  return { v: 1, formatId, brandId: null, productIds: [], campaignId: null, template: null, group: null, caption: "", hashtags: [], altText: "", status: "draft", problems: [], exportedAt: null, ...over };
}

/** The post record in pluginData entries, or null. */
export const postIn = (entries: readonly PluginDataEntry[] | undefined): SocialPostData | null => normalizePost(readSocial<unknown>(entries, "post"));

/** The node's post record, or null when it isn't a post. */
export function readPost(ed: EditorController, id: Guid): SocialPostData | null {
  if (ed.engine.destroyed) return null;
  const n = ed.engine.readNode(id, { fields: ["pluginData"] }) as WithPluginData | null;
  return postIn(n?.pluginData);
}

/** Writes the node's post record (null: it stops being a post), every other pluginData entry kept. Inside a Writer. */
export function writePost(ed: EditorController, id: Guid, data: SocialPostData | null): void {
  const n = ed.engine.readNode(id, { fields: ["pluginData"] }) as WithPluginData | null;
  if (!n) return;
  ed.engine.setProps([id], { pluginData: withSocial(n.pluginData, "post", data) });
}

/** A page's campaigns in their order (bad entries dropped). */
export function campaignsIn(entries: readonly PluginDataEntry[] | undefined): SocialCampaign[] {
  const list = readSocial<unknown>(entries, "campaigns");
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string")
    .map((c) => ({ id: c.id as string, name: str(c.name), brandId: typeof c.brandId === "string" ? c.brandId : null, created: typeof c.created === "number" ? c.created : 0 }));
}

export function readCampaigns(ed: EditorController, page: Guid): SocialCampaign[] {
  if (ed.engine.destroyed) return [];
  const n = ed.engine.readNode(page, { fields: ["pluginData"] }) as WithPluginData | null;
  return campaignsIn(n?.pluginData);
}

/** Writes the page's campaigns (an empty list removes the entry). Inside a Writer. */
export function writeCampaigns(ed: EditorController, page: Guid, list: readonly SocialCampaign[]): void {
  const n = ed.engine.readNode(page, { fields: ["pluginData"] }) as WithPluginData | null;
  if (!n) return;
  ed.engine.setProps([page], { pluginData: withSocial(n.pluginData, "campaigns", list.length ? list : null) });
}

/** Hashtags as a post keeps them: without "#", trimmed, each once (case-insensitive), in order. */
export function cleanHashtags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** A fresh id for a campaign or a carousel's group (not a node id). */
export const socialId = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
