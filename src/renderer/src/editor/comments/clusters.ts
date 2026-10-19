/**
 * Comment pins as Figma draws them (docs/research/atlas/16-comments-versions.md §2.3): a pin's width by its avatars
 * (32 for one, +23 for each more, 3 at most), the avatars a thread shows, clusters of pins that would overlap at this
 * zoom (one pin standing for several threads, its point their thread-weighted mean), the zoom a cluster's click goes
 * to, and the Tab walk through the pins. Pure: the layer feeds it canvas points.
 */
import type { CommentThread, CommentUser } from "@shared/comments";

/** `getPinSize(n)`: 32 high; 32 wide for one avatar, 55 for two, 78 for three */
export const PIN_HEIGHT = 32;
export const MAX_PIN_AVATARS = 3;
export const pinWidth = (avatars: number) => 23 * Math.min(Math.max(avatars, 1) - 1, MAX_PIN_AVATARS - 1) + 32;

/** The pin drag's threshold (`MIN_DRAG`, Chebyshev) and how far in from the canvas's right and top edges a drop stays */
export const MIN_DRAG = 5;
export const DRAG_INSET = 20;

/** Clustering's defaults (only Figma's internal debug tools change them) */
export const CLUSTER = {
  /** Below this zoom (76 %) the merge distance grows… */
  minZoom: 0.76,
  /** …by this much per unit of zoom below it */
  zoomScaleOverlap: 64,
  /** A cluster's click zooms so its farthest pin sits within 35 % of the viewport's larger side */
  clickViewportFraction: 0.35,
  /** Clusters are rebuilt this long after the zoom stops changing */
  rebuildDelayMs: 50,
  /** A cluster lists its first 5 people */
  listedAvatars: 5,
} as const;

/** The "new from others" animation: grown from 0.2 over 400 ms, its preview left open 3.5 s */
export const ANIMATE_NEW_MS = 400;
export const ANIMATE_NEW_DELAY_MS = 3500;

/** Screen px within which two pins merge at `zoom`: ceil(max(64, the three-avatar pin) + max(0.76 − zoom, 0) × 64) */
export function mergeDistance(zoom: number): number {
  const overlap = Math.max(CLUSTER.minZoom - zoom, 0) * CLUSTER.zoomScaleOverlap;
  return Math.ceil(Math.max(64, pinWidth(MAX_PIN_AVATARS), PIN_HEIGHT) + overlap);
}

/** The people a thread's pin shows: its author, then whoever replied, each once */
export function threadPeople(thread: CommentThread): CommentUser[] {
  const out: CommentUser[] = [];
  for (const c of thread.comments) if (!out.some((u) => u.id === c.user.id)) out.push(c.user);
  return out;
}

/** What a pin's avatar stack holds: up to 3 faces, or 2 and "+N" past that (the stack clamps at MAX_PIN_AVATARS − 1) */
export function pinAvatars(people: CommentUser[]): { shown: CommentUser[]; more: number } {
  if (people.length <= MAX_PIN_AVATARS) return { shown: people, more: 0 };
  return { shown: people.slice(0, MAX_PIN_AVATARS - 1), more: people.length - (MAX_PIN_AVATARS - 1) };
}

export interface PinPoint {
  thread: CommentThread;
  /** Canvas px */
  x: number;
  y: number;
}

export interface PinCluster {
  /** `${100·round(x/100)},${100·round(y/100)},${n}` (one thread: its id) */
  id: string;
  /** Canvas px: the thread-count-weighted mean of its members */
  x: number;
  y: number;
  threads: CommentThread[];
  /** Its members' own points */
  points: { x: number; y: number }[];
}

/**
 * Pins that would overlap at `zoom` (canvas points), merged: each pin joins the nearest cluster within the merge
 * distance (cells of that size, the neighbouring ones searched) or starts one; a cluster's point moves to the
 * weighted mean as it grows. The open thread stays on its own (its card is anchored to it).
 */
export function clusterPins(pins: PinPoint[], zoom: number, keepAlone: string | null = null): PinCluster[] {
  const d = mergeDistance(zoom);
  const clusters: PinCluster[] = [];
  const grid = new Map<string, PinCluster[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / d)},${Math.floor(y / d)}`;
  const place = (c: PinCluster) => {
    const k = cell(c.x, c.y);
    const list = grid.get(k);
    if (list) list.push(c);
    else grid.set(k, [c]);
  };
  const unplace = (c: PinCluster) => {
    const list = grid.get(cell(c.x, c.y));
    if (list) list.splice(list.indexOf(c), 1);
  };
  for (const p of [...pins].sort((a, b) => a.thread.number - b.thread.number)) {
    if (p.thread.id === keepAlone) {
      clusters.push({ id: p.thread.id, x: p.x, y: p.y, threads: [p.thread], points: [{ x: p.x, y: p.y }] });
      continue;
    }
    let best: PinCluster | null = null;
    let bestD = Infinity;
    const cx = Math.floor(p.x / d);
    const cy = Math.floor(p.y / d);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const c of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const dist = Math.hypot(c.x - p.x, c.y - p.y);
          if (dist <= d && dist < bestD) {
            best = c;
            bestD = dist;
          }
        }
    if (!best) {
      const c: PinCluster = { id: p.thread.id, x: p.x, y: p.y, threads: [p.thread], points: [{ x: p.x, y: p.y }] };
      clusters.push(c);
      place(c);
      continue;
    }
    unplace(best);
    const n = best.threads.length;
    const total = n + 1;
    best.x = (best.x * n) / total + p.x / total;
    best.y = (best.y * n) / total + p.y / total;
    best.threads.push(p.thread);
    best.points.push({ x: p.x, y: p.y });
    place(best);
  }
  for (const c of clusters) if (c.threads.length > 1) c.id = `${100 * Math.round(c.x / 100)},${100 * Math.round(c.y / 100)},${c.threads.length}`;
  return clusters;
}

/** A cluster's people: each thread's author once, their unread threads summed, the first five */
export function clusterPeople(threads: CommentThread[]): { user: CommentUser; unread: number }[] {
  const out: { user: CommentUser; unread: number }[] = [];
  for (const t of threads) {
    const u = t.comments[0]?.user;
    if (!u) continue;
    const at = out.find((x) => x.user.id === u.id);
    if (at) at.unread += Number(t.unread);
    else out.push({ user: u, unread: Number(t.unread) });
  }
  return out.slice(0, CLUSTER.listedAvatars);
}

/**
 * The zoom a cluster's click goes to: its farthest pin within 35 % of the viewport's larger side, at least 1.5 × the
 * zoom now, at most 1.26 (0.76 + 0.5). `spread`: the farthest member from the cluster's point, in page units.
 */
export function clusterClickZoom(spread: number, zoom: number, viewport: { width: number; height: number }): number {
  const fit = spread > 0 ? (CLUSTER.clickViewportFraction * Math.max(viewport.width, viewport.height)) / spread : Infinity;
  const to = Math.min(Math.max(fit, zoom * 1.5), CLUSTER.minZoom + 0.5);
  // Already past 1.26 (pins close enough to merge even there): never a zoom out — 1.5 × until they part. (What Figma
  // does in this case isn't read.)
  return to > zoom ? to : zoom * 1.5;
}

/** The Tab order of pins: a nearest-neighbour walk from the one with the smallest x + y (list order past 100 pins) */
export function pinTabOrder<T extends { x: number; y: number }>(pins: T[]): T[] {
  if (pins.length > 100 || pins.length < 2) return [...pins];
  const left = [...pins];
  let at = left.reduce((best, p, i) => (p.x + p.y < left[best].x + left[best].y ? i : best), 0);
  const out: T[] = [];
  while (left.length) {
    const p = left.splice(at, 1)[0];
    out.push(p);
    at = 0;
    let bestD = Infinity;
    left.forEach((q, i) => {
      const dist = Math.hypot(q.x - p.x, q.y - p.y);
      if (dist < bestD) {
        bestD = dist;
        at = i;
      }
    });
  }
  return out;
}
