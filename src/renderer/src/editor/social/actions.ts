/**
 * Social's actions (docs/social.md §6.7): the one implementation behind the chrome's controls and the agents' Social
 * tools. Each takes a Writer — the chrome passes the editor's batch (`editorWriter`: one click, one undo step), an
 * agent tool its `ToolEnv.write` (a chat turn stays one undo step per worker) — so both entry points run the same
 * function. Round 18a builds the posts, campaigns and resizing; templates, slots and brands (applyTemplate,
 * fillSlots, applyBrand, saveAsTemplate) are 18b's, the checks (checkPosts) 18c's — stubs here until they land.
 */
import type { Guid, Message, NodeChange } from "@/engine/codec";
import { keyAfter, keyBetween } from "@shared/schema/fractionalIndex";
import type { ImageArg } from "@shared/agents/images";
import { resolveFormat } from "@shared/social/formats";
import { withSocial, type PostProblem, type SlotRole, type SocialCampaign, type SocialPostData } from "@shared/social/types";
import type { SocialFormat } from "@shared/studio/types";
import type { EditorController } from "../controller";
import { newNodeGuid } from "../variables";
import { defaults, IDENTITY } from "../agents/nodeSpec";
import { presenceOf } from "../multiplayer/presence";
import { placePost, POST_GAP } from "./board";
import { cleanHashtags, postRecord, readCampaigns, readPost, socialId, writeCampaigns, writePost } from "./posts";
import { readBoard, type SocialBoard } from "./socialState";

/** Runs `fn` as one write labelled `label` (one undo step) and returns what it returns. */
export type Writer = <T>(label: string, fn: () => T) => T;

/** The chrome's writer: the editor's batch, one undo step per call. */
export function editorWriter(ed: EditorController): Writer {
  return <T,>(label: string, fn: () => T): T => {
    let out!: T;
    ed.batch(label, () => {
      out = fn();
    });
    return out;
  };
}

/** For actions run inside another write (several actions as one undo step): runs `fn` as it is. */
export const withinWrite: Writer = (_label, fn) => fn();

/** Viewers ("can view" in a shared file) read posts; every write control is off (docs/social.md §1.1). */
export function canWritePosts(ed: EditorController): boolean {
  const p = presenceOf(ed)?.state;
  return !(p?.shared && p.role === "viewer");
}

export interface NewPostOptions {
  formatId: string;
  /** A brand's own size ("brand:<brandId>:<formatId>" ids): its dimensions, which the catalogue doesn't know */
  format?: SocialFormat;
  name?: string;
  brandId?: string | null;
  campaignId?: string | null;
  template?: { key: string; variant?: string };
  productId?: string;
  at?: { x: number; y: number };
}

export type PostPatch = Partial<Pick<SocialPostData, "brandId" | "productIds" | "campaignId" | "caption" | "hashtags" | "altText" | "status">>;

export interface SaveAsTemplateOptions {
  name: string;
  platforms?: string[];
  formats?: string[];
  slots?: { nodeId: Guid; role: SlotRole; locked?: boolean; maxChars?: number }[];
}

const notBuilt = (name: string): never => {
  throw new Error(`${name}: not built (docs/social.md §10)`);
};

function formatOf(formatId: string, given?: SocialFormat): SocialFormat {
  const f = given ?? resolveFormat(formatId);
  if (!f) throw new Error(`Unknown format "${formatId}"`);
  return f;
}

/** Where a new post goes on the board: its campaign's row, a new row, or — the page's first — beside its other layers. */
function spotFor(board: SocialBoard, campaignId: string | null): { x: number; y: number } {
  if (!board.posts.length && board.others) return { x: board.others.x + board.others.width + POST_GAP, y: board.others.y };
  return placePost(board.posts, campaignId);
}

/** The page's last child's place, for a layer added on top. */
function topKey(ed: EditorController, page: Guid): string {
  const kids = (ed.engine.readNode(page, { childIds: true, fields: ["type"] })?.childIds ?? []) as Guid[];
  const last = kids[kids.length - 1];
  const pos = last ? ed.engine.readNode(last, { fields: ["parentIndex"] })?.parentIndex?.position : undefined;
  return pos ? keyAfter(pos) : keyBetween("", null);
}

/**
 * A new post on the current page: a white frame of the format's size named after it, carrying its record (a draft,
 * the brand, product and campaign given), placed on the board (§6.4) unless `at` says where. Templates are 18b's.
 */
export function newPost(ed: EditorController, w: Writer, opts: NewPostOptions): Guid {
  if (opts.template) return notBuilt("newPost from a template");
  const format = formatOf(opts.formatId, opts.format);
  const page = ed.store.page;
  const campaignId = opts.campaignId ?? null;
  const at = opts.at ?? spotFor(readBoard(ed, page), campaignId);
  const record = postRecord(opts.formatId, { brandId: opts.brandId ?? null, campaignId, productIds: opts.productId ? [opts.productId] : [] });
  return w("New post", () => {
    const guid = newNodeGuid(ed);
    const node = {
      guid,
      type: "FRAME",
      ...defaults("FRAME"),
      phase: "CREATED",
      name: opts.name ?? format.name,
      transform: { ...IDENTITY, m02: Math.round(at.x), m12: Math.round(at.y) },
      size: { x: format.width, y: format.height },
      parentIndex: { guid: page, position: topKey(ed, page) },
      pluginData: withSocial([], "post", record),
    } as NodeChange;
    const message: Message = { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [node] };
    const status = ed.engine.applyChanges(message, "user");
    if (status !== 0) throw new Error(`The engine refused the post (status ${status})`);
    return guid;
  });
}

/** Changes the posts' records (the fields given), one write; frames that aren't posts are left alone. */
export function setPost(ed: EditorController, w: Writer, ids: readonly Guid[], patch: PostPatch): void {
  const posts = ids.map((id) => [id, readPost(ed, id)] as const).filter((x): x is readonly [Guid, SocialPostData] => !!x[1]);
  if (!posts.length) return;
  const clean: PostPatch = { ...patch, ...(patch.hashtags ? { hashtags: cleanHashtags(patch.hashtags) } : {}) };
  w("Edit post", () => {
    for (const [id, data] of posts) writePost(ed, id, { ...data, ...clean, ...(clean.status === "exported" && data.status !== "exported" ? { exportedAt: Date.now() } : {}) });
  });
}

/** Leave (the Post section, a pin): the problems go from the post, one write. */
export function leaveProblems(ed: EditorController, w: Writer, id: Guid, problemIds: readonly string[]): void {
  const data = readPost(ed, id);
  if (!data || !data.problems.some((p) => problemIds.includes(p.id))) return;
  w("Leave problem", () => writePost(ed, id, { ...data, problems: data.problems.filter((p) => !problemIds.includes(p.id)) }));
}

/**
 * Resizes the posts to another format (as Figma's frame presets do: the frame's size, its layers by their
 * constraints), or with `duplicate` makes a copy in the new format at the end of its campaign's row — a fresh draft,
 * without the original's problems or export. A template's variant swap is 18b's. Returns the posts resized (the copies).
 */
export function resizePost(ed: EditorController, w: Writer, ids: readonly Guid[], formatId: string, opts: { duplicate: boolean; format?: SocialFormat }): Guid[] {
  const format = formatOf(formatId, opts.format);
  const posts = ids.map((id) => [id, readPost(ed, id)] as const).filter((x): x is readonly [Guid, SocialPostData] => !!x[1]);
  if (!posts.length) return [];
  return w(opts.duplicate ? "Duplicate post" : "Resize post", () => {
    const out: Guid[] = [];
    for (const [id, data] of posts) {
      if (!opts.duplicate) {
        ed.engine.setProps([id], { size: { x: format.width, y: format.height } });
        writePost(ed, id, { ...data, formatId, problems: [] });
        out.push(id);
        continue;
      }
      const copy = duplicateFrame(ed, id);
      if (!copy) continue;
      const at = placePost(readBoard(ed, ed.store.page).posts.filter((p) => p.id !== copy), data.campaignId);
      const t = ed.engine.readNode(copy, { fields: ["transform"] })?.transform ?? IDENTITY;
      ed.engine.setProps([copy], { name: format.name, size: { x: format.width, y: format.height }, transform: { ...t, m02: at.x, m12: at.y } });
      writePost(ed, copy, { ...data, formatId, status: "draft", problems: [], exportedAt: null, group: null });
      out.push(copy);
    }
    return out;
  });
}

/** A copy of a top-level frame (the engine's Duplicate; the selection put back after). Inside a Writer. */
function duplicateFrame(ed: EditorController, id: Guid): Guid | null {
  const before = [...ed.selection];
  ed.engine.setSelection([id]);
  ed.engine.command("DUPLICATE");
  const copy = ed.engine.getSelection().refs[0] ?? null;
  ed.engine.setSelection(before);
  return copy && copy !== id ? copy : null;
}

/**
 * Adds or changes a campaign on the page (by id), or removes it — its posts then sit in "No campaign" (their frames
 * stay where they are).
 */
export function setCampaign(ed: EditorController, w: Writer, page: Guid, campaign: SocialCampaign | { id: string; remove: true }): void {
  const list = readCampaigns(ed, page);
  w("remove" in campaign ? "Remove campaign" : "Edit campaign", () => {
    if ("remove" in campaign) {
      writeCampaigns(ed, page, list.filter((c) => c.id !== campaign.id));
      for (const p of readBoard(ed, page).posts) if (p.data.campaignId === campaign.id) writePost(ed, p.id, { ...p.data, campaignId: null });
      return;
    }
    const i = list.findIndex((c) => c.id === campaign.id);
    writeCampaigns(ed, page, i < 0 ? [...list, campaign] : list.map((c, k) => (k === i ? campaign : c)));
  });
}

/** A new campaign's record, created now (setCampaign writes it). */
export function newCampaign(name: string, brandId: string | null): SocialCampaign {
  return { id: socialId(), name, brandId, created: Date.now() };
}

export function applyTemplate(ed: EditorController, w: Writer, ids: readonly Guid[], opts: { key: string; variant?: string; brandId?: string; productId?: string }): Guid[] {
  void [ed, w, ids, opts];
  return notBuilt("applyTemplate");
}

export function fillSlots(ed: EditorController, w: Writer, id: Guid, values: Partial<Record<SlotRole, string>>, picture?: ImageArg): void {
  void [ed, w, id, values, picture];
  notBuilt("fillSlots");
}

/** The Brand collection's mode and the logo's Brand variant. */
export function applyBrand(ed: EditorController, w: Writer, ids: readonly Guid[], brandId: string): void {
  void [ed, w, ids, brandId];
  notBuilt("applyBrand");
}

export function saveAsTemplate(ed: EditorController, w: Writer, id: Guid, opts: SaveAsTemplateOptions): { key: string } | { error: string } {
  void [ed, w, id, opts];
  return notBuilt("saveAsTemplate");
}

/** The deterministic limits (§7.3): caption, hashtags, mentions, safe area, video, logo, contrast. */
export function checkPosts(ed: EditorController, ids: readonly Guid[]): PostProblem[] {
  void [ed, ids];
  return notBuilt("checkPosts");
}
