/**
 * The board's placement (docs/social.md §6.4): a campaign's posts sit in one row; a new post goes to the right of its
 * campaign's row, a new campaign's row under the page's lowest post, left-aligned with the first row. The row is a
 * reading of positions, never stored; frames the owner draws elsewhere are left alone. Pure — socialState.ts gives it
 * the page's posts, actions.ts and Studio's make_posts its answer.
 */

/** Between two posts of a row [ours] */
export const POST_GAP = 120;
/** Between two campaigns' rows [ours] */
export const ROW_GAP = 240;

export interface PlacedPost {
  campaignId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a new post of this size goes: right of its campaign's row, else a new row under every post (else 0, 0). */
export function placePost(posts: readonly PlacedPost[], campaignId: string | null): { x: number; y: number } {
  if (!posts.length) return { x: 0, y: 0 };
  const row = posts.filter((p) => p.campaignId === campaignId);
  if (row.length) {
    const right = Math.max(...row.map((p) => p.x + p.width));
    const top = Math.min(...row.map((p) => p.y));
    return { x: right + POST_GAP, y: top };
  }
  // The first row's left edge: the topmost row's leftmost post.
  const top = Math.min(...posts.map((p) => p.y));
  const left = Math.min(...posts.filter((p) => p.y === top).map((p) => p.x));
  const bottom = Math.max(...posts.map((p) => p.y + p.height));
  return { x: left, y: bottom + ROW_GAP };
}

/**
 * Where a new post goes on a Social file's board before it is arranged (§19): past every post, in creation order, so
 * the arrange puts it at the end of its grid.
 */
export const boardEnd = (posts: readonly PlacedPost[]): { x: number; y: number } => boardEndAt(posts.length);

/** The `i`th place past every post (several new posts in order: the arrange keeps that order). */
export const boardEndAt = (i: number): { x: number; y: number } => ({ x: 10_000_000 + i * 10, y: 10_000_000 });

/** Several new posts in one campaign, left to right (Studio's rows, make_posts): each placed after the one before. */
export function placePosts(posts: readonly PlacedPost[], campaignId: string | null, sizes: readonly { width: number; height: number }[]): { x: number; y: number }[] {
  const placed = [...posts];
  return sizes.map((s) => {
    const at = placePost(placed, campaignId);
    placed.push({ campaignId, ...at, ...s });
    return at;
  });
}

// ---- A Social file's board (docs/social.md §19): platform › format grids ------------------------------------------

/**
 * The board of a Social file, laid out as auto layout would (§19, the owner's ask 2026-10-24): a section per platform,
 * one under the other (the catalogue's platform order; a brand's own sizes last); in a section a grid per format, side
 * by side (the catalogue's format order); in a grid the posts in three columns, in the order they are read on the
 * board (rows top to bottom, left to right in a row — so dragging a post among the others reorders it). Room is kept
 * above each grid for its title, which the chrome draws over the canvas (BoardLabels). Units are the canvas's [ours]:
 * the posts are 1080 px wide; the gap between rows holds each post's name (drawn by the engine, as Buzz's grid view) at
 * a board's zoom (§21: the owner found 80 crowded, the names over the posts above).
 */
export const BOARD = {
  columns: 3,
  /** Between two posts of a grid, across and down */
  gap: 200,
  /** Between two grids of a section */
  gridGap: 480,
  /** Between two sections */
  sectionGap: 560,
  /** Above a section's grids: room for the grids' titles, drawn in screen pixels over it */
  sectionHead: 240,
} as const;

export interface BoardItem {
  id: string;
  /** The post's catalogue format id ("brand:…" for a brand's own size) */
  formatId: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface GridBox {
  formatId: string;
  /** The grid's posts in order */
  ids: string[];
  /** Its posts' box (the title goes above it) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** One column's width and the row pitch (where the next post would go) */
  column: number;
  /** Where a new post of the grid goes: the next cell */
  next: { x: number; y: number };
}

export interface SectionBox {
  /** A platform id, or "other" (a brand's own sizes, unknown formats) */
  platform: string;
  x: number;
  y: number;
  width: number;
  height: number;
  grids: GridBox[];
}

export interface BoardLayout {
  sections: SectionBox[];
  /** Each post's place */
  places: Map<string, { x: number; y: number }>;
}

/** Orders: the catalogue's platforms then "other"; in a platform its formats in catalogue order, then the rest by id */
export function boardLayout(items: readonly BoardItem[], order: { platformOf(formatId: string): string; rank(formatId: string): number; platforms: readonly string[] }, origin = { x: 0, y: 0 }): BoardLayout {
  const byPlatform = new Map<string, Map<string, BoardItem[]>>();
  for (const it of items) {
    const p = order.platformOf(it.formatId);
    const grids = byPlatform.get(p) ?? new Map<string, BoardItem[]>();
    byPlatform.set(p, grids);
    const g = grids.get(it.formatId) ?? [];
    g.push(it);
    grids.set(it.formatId, g);
  }
  const platforms = [...order.platforms.filter((p) => byPlatform.has(p)), ...[...byPlatform.keys()].filter((p) => !order.platforms.includes(p)).sort()];
  const places = new Map<string, { x: number; y: number }>();
  const sections: SectionBox[] = [];
  let top = origin.y;
  for (const platform of platforms) {
    const grids = byPlatform.get(platform)!;
    const formats = [...grids.keys()].sort((a, b) => order.rank(a) - order.rank(b) || a.localeCompare(b));
    let left = origin.x;
    let bottom = top + BOARD.sectionHead;
    const boxes: GridBox[] = [];
    for (const formatId of formats) {
      const posts = readingOrder(grids.get(formatId)!);
      const column = Math.max(...posts.map((p) => p.width));
      const y0 = top + BOARD.sectionHead;
      let y = y0;
      for (let i = 0; i < posts.length; i += BOARD.columns) {
        const row = posts.slice(i, i + BOARD.columns);
        row.forEach((p, k) => places.set(p.id, { x: left + k * (column + BOARD.gap), y }));
        y += Math.max(...row.map((p) => p.height)) + BOARD.gap;
      }
      const n = posts.length;
      const lastRowTop = n ? y - (Math.max(...posts.slice(Math.floor((n - 1) / BOARD.columns) * BOARD.columns).map((p) => p.height)) + BOARD.gap) : y0;
      const next = n % BOARD.columns === 0 ? { x: left, y } : { x: left + (n % BOARD.columns) * (column + BOARD.gap), y: lastRowTop };
      const width = BOARD.columns * column + (BOARD.columns - 1) * BOARD.gap;
      const height = Math.max(0, y - BOARD.gap - y0);
      boxes.push({ formatId, ids: posts.map((p) => p.id), x: left, y: y0, width, height, column, next });
      bottom = Math.max(bottom, y0 + height);
      left += width + BOARD.gridGap;
    }
    sections.push({ platform, x: origin.x, y: top, width: left - BOARD.gridGap - origin.x, height: bottom - top, grids: boxes });
    top = bottom + BOARD.sectionGap;
  }
  return { sections, places };
}

/** Posts as read on the board: by row (their middles, a row being as tall as its tallest post), then left to right. */
function readingOrder(posts: readonly BoardItem[]): BoardItem[] {
  const pitch = Math.max(1, ...posts.map((p) => p.height)) + BOARD.gap;
  const top = Math.min(...posts.map((p) => p.y));
  const row = (p: BoardItem) => Math.floor((p.y + p.height / 2 - top) / pitch);
  return [...posts].sort((a, b) => row(a) - row(b) || a.x + a.width / 2 - (b.x + b.width / 2) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
