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

/** Several new posts in one campaign, left to right (Studio's rows, make_posts): each placed after the one before. */
export function placePosts(posts: readonly PlacedPost[], campaignId: string | null, sizes: readonly { width: number; height: number }[]): { x: number; y: number }[] {
  const placed = [...posts];
  return sizes.map((s) => {
    const at = placePost(placed, campaignId);
    placed.push({ campaignId, ...at, ...s });
    return at;
  });
}
