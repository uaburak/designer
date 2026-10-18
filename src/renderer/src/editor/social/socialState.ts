/**
 * The posts index (docs/social.md §6.2, §10): the current page's posts — its top-level frames carrying a post record —
 * grouped by campaign (the page's campaigns in their order, then "No campaign"), with each post's place and size for
 * the board, the safe areas and the pins. Kept from the document: any committed change, an undo or redo, a page switch
 * marks it stale and tells the panels; it is read again only when asked (one read of the page's children). Not React
 * state: the panels read it with useSyncExternalStore through `useSocialBoard`.
 */
import { useSyncExternalStore } from "react";
import type { Guid, NodeChange } from "@/engine/codec";
import { SOCIAL_KEYS, SOCIAL_PLUGIN_ID, type PluginDataEntry, type SocialCampaign, type SocialPostData } from "@shared/social/types";
import type { EditorController } from "../controller";
import { motionRead } from "../motion/motionState";
import { campaignsIn, postIn } from "./posts";
import type { PlacedPost } from "./board";

export interface PostRow extends PlacedPost {
  id: Guid;
  name: string;
  data: SocialPostData;
  /** It has a timeline with something on it (keyframes, presets, audio) */
  animated: boolean;
  /** Another post on the page carries the same record (a plain ⌘D in Design copies it) */
  duplicateOf: Guid | null;
}

export interface CampaignGroup {
  /** null: "No campaign" */
  campaign: SocialCampaign | null;
  posts: PostRow[];
}

export interface SocialBoard {
  page: Guid;
  campaigns: SocialCampaign[];
  /** Every campaign (empty ones too), then the posts without one (when any) */
  groups: CampaignGroup[];
  posts: PostRow[];
  /** The page's other top-level layers' bounds (where a first post goes beside them), null when there are none */
  others: { x: number; y: number; width: number; height: number } | null;
}

const EMPTY: SocialBoard = { page: "", campaigns: [], groups: [], posts: [], others: null };
const POST_TYPES = new Set(["FRAME", "INSTANCE", "SYMBOL"]);

type Row = NodeChange & { pluginData?: PluginDataEntry[] };

/** Reads the board of `page` from the engine. */
export function readBoard(ed: EditorController, page: Guid): SocialBoard {
  if (ed.engine.destroyed) return EMPTY;
  const p = ed.engine.readNode(page, { childIds: true, fields: ["pluginData", "type"] }) as Row | null;
  if (!p) return { ...EMPTY, page };
  const campaigns = campaignsIn(p.pluginData);
  const kids = (p.childIds ?? []) as Guid[];
  const rows = kids.length ? (ed.engine.readNodes(kids, { fields: ["pluginData", "name", "type", "size", "transform"] }) as Row[]) : [];
  const posts: PostRow[] = [];
  let others: SocialBoard["others"] = null;
  const seen = new Map<string, Guid>();
  for (const r of rows) {
    const x = r.transform?.m02 ?? 0;
    const y = r.transform?.m12 ?? 0;
    const width = r.size?.x ?? 0;
    const height = r.size?.y ?? 0;
    const data = POST_TYPES.has(ed.withRealType(r).type ?? "") ? postIn(r.pluginData) : null;
    if (!data) {
      const right = Math.max(x + width, others ? others.x + others.width : -Infinity);
      const bottom = Math.max(y + height, others ? others.y + others.height : -Infinity);
      const left = Math.min(x, others?.x ?? Infinity);
      const top = Math.min(y, others?.y ?? Infinity);
      others = { x: left, y: top, width: right - left, height: bottom - top };
      continue;
    }
    // The record as written (its JSON) names a twin: a frame duplicated outside Social keeps the same record.
    const key = r.pluginData?.find((e) => e.pluginID === SOCIAL_PLUGIN_ID && e.key === SOCIAL_KEYS.post)?.value ?? "";
    const duplicateOf = seen.get(key) ?? null;
    if (!duplicateOf) seen.set(key, r.guid);
    posts.push({ id: r.guid, name: r.name ?? "", data, campaignId: data.campaignId, x, y, width, height, animated: isAnimated(ed, r.guid), duplicateOf });
  }
  const known = new Set(campaigns.map((c) => c.id));
  const groups: CampaignGroup[] = campaigns.map((c) => ({ campaign: c, posts: posts.filter((x) => x.campaignId === c.id) }));
  const loose = posts.filter((x) => !x.campaignId || !known.has(x.campaignId));
  if (loose.length) groups.push({ campaign: null, posts: loose });
  // Within a row, left to right as on the board.
  for (const g of groups) g.posts.sort((a, b) => a.y - b.y || a.x - b.x);
  return { page, campaigns, groups, posts, others };
}

/** A post with a timeline that has something on it: keyframes or presets on a layer, or audio. */
export function isAnimated(ed: EditorController, id: Guid): boolean {
  const model = motionRead(() => ed.engine.motionTimeline(id), null);
  return !!model && (model.audio.length > 0 || model.layers.some((l) => l.tracks.length > 0 || l.clips.length > 0 || !!l.instance));
}

/** The index of one editor: stale on any document change, read again when asked. */
export class SocialIndex {
  private board: SocialBoard | null = null;
  private readonly listeners = new Set<() => void>();
  private attached = false;
  private readonly ed: EditorController;

  constructor(ed: EditorController) {
    this.ed = ed;
  }

  /** Watches the document from the first read on, for the editor's life (a change only marks the board stale). */
  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    const stale = () => {
      if (!this.board) return;
      this.board = null;
      this.listeners.forEach((l) => l());
    };
    this.ed.engine.on("DOCUMENT_CHANGED", stale);
    this.ed.store.subscribe("page", stale);
    this.ed.store.subscribe("structure", stale);
    this.ed.store.subscribe("undo", stale);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.attach();
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The current page's board (the same object until something changes). */
  get = (): SocialBoard => {
    this.attach();
    if (this.board && this.board.page === this.ed.store.page) return this.board;
    this.board = readBoard(this.ed, this.ed.store.page);
    return this.board;
  };

  /** A post's row on the current page, or null. */
  post(id: Guid): PostRow | null {
    return this.get().posts.find((p) => p.id === id) ?? null;
  }
}

const indexes = new WeakMap<EditorController, SocialIndex>();

/** The editor's posts index. */
export function socialOf(ed: EditorController): SocialIndex {
  let index = indexes.get(ed);
  if (!index) indexes.set(ed, (index = new SocialIndex(ed)));
  return index;
}

/** The current page's board, re-rendering on a change. */
export function useSocialBoard(ed: EditorController): SocialBoard {
  const index = socialOf(ed);
  return useSyncExternalStore(index.subscribe, index.get);
}
