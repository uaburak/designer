/**
 * The library registry's rules (docs/data.md §9), free of storage: what a publish adds, changes and removes, what a
 * consumer's copies are missing, the record's counts, the shape checks. The store's `LocalLibraries` (files on
 * disk) and the browser dev store's `MemoryLibraries` (localStorage) both run these, so the editor sees the same
 * registry in either.
 */
import { StoreError } from "./protocol";
import { isAssetKey, type LibraryAsset, type LibraryDiff, type LibraryPublish, type LibraryRecord, type LibraryVersion, type PublishAsset, type PublishPreview, type Redirect } from "./types";

/** Listed in Assets and counted (dependency-only assets ship but are never listed). */
export const isListedAsset = (a: Pick<LibraryAsset, "dependencyOnly">) => !a.dependencyOnly;

export function libraryCounts(assets: readonly LibraryAsset[]): LibraryRecord["counts"] {
  const c = { components: 0, styles: 0, variables: 0 };
  for (const a of assets.filter(isListedAsset)) {
    if (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET") c.components++;
    else if (a.kind === "STYLE") c.styles++;
    else if (a.kind === "VARIABLE") c.variables++;
  }
  return c;
}

/** Keys are 40 lowercase hex, listed once, each with a versionHash. */
export function validatePublishAssets(assets: readonly PublishAsset[]): void {
  if (!Array.isArray(assets)) throw new StoreError("invalid", "assets must be a list");
  const seen = new Set<string>();
  for (const a of assets) {
    if (!isAssetKey(a?.key)) throw new StoreError("invalid", `an asset key is 40 lowercase hex characters: ${a?.key}`);
    if (seen.has(a.key)) throw new StoreError("invalid", `asset ${a.key} is listed twice`);
    seen.add(a.key);
    if (typeof a.versionHash !== "string" || !/^[0-9a-f]{40}$/.test(a.versionHash)) throw new StoreError("invalid", `asset ${a.key} has no versionHash`);
  }
}

/** The manifest entry of a published asset (its payload and PNG left out). */
export function toLibraryAsset(a: PublishAsset, thumbnail: LibraryAsset["thumbnail"]): LibraryAsset {
  const { payload: _payload, thumbnailPng: _png, ...rest } = a;
  return { ...rest, dependencies: [...(rest.dependencies ?? [])], thumbnail };
}

/** Redirects other libraries recorded for assets that moved out of `lib` (§9.5). */
export function movedOutOf(records: Iterable<LibraryRecord>, lib: string): Redirect[] {
  const out: Redirect[] = [];
  for (const r of records) for (const m of r.movedIn) if (m.fromLibraryFileKey === lib) out.push(m);
  return out;
}

/** What publishing `assets` would change against the latest version `prev` (§9.3). */
export function previewAgainst(prev: LibraryVersion | null, assets: readonly PublishAsset[], movedOut: readonly Redirect[]): PublishPreview {
  const prevByKey = new Map((prev?.assets ?? []).map((a) => [a.key, a]));
  const created: LibraryAsset[] = [];
  const modified: LibraryAsset[] = [];
  const unchanged: string[] = [];
  for (const a of assets.filter((x) => !x.dependencyOnly)) {
    const p = prevByKey.get(a.key);
    const asset = toLibraryAsset(a, p?.thumbnail ?? null);
    if (!p || p.dependencyOnly) created.push(asset);
    else if (p.versionHash !== a.versionHash) modified.push(asset);
    else unchanged.push(a.key);
  }
  const nextListed = new Set(assets.filter((x) => !x.dependencyOnly).map((x) => x.key));
  const movedKeys = new Set(movedOut.map((m) => m.fromKey));
  const gone = (prev?.assets ?? []).filter((p) => isListedAsset(p) && !nextListed.has(p.key));
  return {
    created,
    modified,
    removed: gone.filter((p) => !movedKeys.has(p.key)),
    moved: movedOut.filter((m) => gone.some((g) => g.key === m.fromKey)),
    unchanged,
  };
}

/**
 * Figma's userFacingVersion on a new version's manifest (atlas 12 §6.1, §9): an asset whose content the previous
 * version had keeps that version's (one written before the field: none, as unknown), a new or changed one gets this
 * version's. Which edits Figma's server lets through without a new user-facing version is open (§15): here every
 * content change is one.
 */
export function stampUserFacingVersions(assets: readonly LibraryAsset[], prev: LibraryVersion | null, version: number): LibraryAsset[] {
  const before = new Map((prev?.assets ?? []).map((a) => [a.key, a]));
  return assets.map((a) => {
    const p = before.get(a.key);
    if (p && p.versionHash === a.versionHash) {
      const { userFacingVersion: _drop, ...rest } = a;
      return p.userFacingVersion ? { ...rest, userFacingVersion: p.userFacingVersion } : rest;
    }
    return { ...a, userFacingVersion: String(version) };
  });
}

/** The key of a used version in `diffAgainst`'s `used` map. */
export const usedVersionKey = (key: string, versionHash: string): string => `${key}@${versionHash}`;

/**
 * A consumer's copies `have` against the latest version (§9.4; atlas 12 §6.1): each asset once, however many copies
 * of it the consumer holds. Figma's rule: an asset used at two or more versions is always outdated; at one, only when
 * both its content (versionHash) and its user-facing version differ from the latest (case-insensitive; `used` maps
 * `usedVersionKey` → that version's user-facing version, and one it doesn't know counts as different). A move another
 * library recorded wins over the old library's manifest: its consumers see "Moved" as soon as the new library
 * publishes (§9.5 step 2), not only after the old one publishes the removal.
 */
export function diffAgainst(latest: LibraryVersion | null, latestVersion: number, have: readonly { key: string; versionHash: string }[], movedOut: readonly Redirect[], used?: ReadonlyMap<string, string>): LibraryDiff {
  const byKey = new Map((latest?.assets ?? []).map((a) => [a.key, a]));
  const versions = new Map<string, Set<string>>();
  for (const h of have) versions.set(h.key, (versions.get(h.key) ?? new Set<string>()).add(h.versionHash));
  const updated: LibraryAsset[] = [];
  const removed: string[] = [];
  const moved: Redirect[] = [];
  for (const [key, hashes] of versions) {
    const m = movedOut.find((x) => x.fromKey === key);
    if (m) {
      moved.push(m);
      continue;
    }
    const a = byKey.get(key);
    if (!a) removed.push(key);
    else if (hashes.size > 1) updated.push(a);
    else {
      const [hash] = hashes;
      if (hash === a.versionHash) continue;
      const ufv = used?.get(usedVersionKey(key, hash));
      // Same user-facing version, other content: Figma doesn't offer it (and reports the inconsistency).
      if (ufv && a.userFacingVersion && ufv.toLowerCase() === a.userFacingVersion.toLowerCase()) continue;
      updated.push(a);
    }
  }
  return { latestVersion, updated, removed, moved };
}

/** What `diffWithHistory` reads of a library's past versions (sync or async: the stores differ). */
export interface LibraryHistory {
  /** (key, versionHash)'s manifest entry, in the newest version that holds it */
  entry(key: string, versionHash: string): LibraryAsset | null | Promise<LibraryAsset | null>;
  version(n: number): LibraryVersion | null | Promise<LibraryVersion | null>;
}

/**
 * `diffAgainst` with what it needs from the library's history: the user-facing versions of the versions in use (one
 * per asset used at a single older version), and the publishes the updates come from (`LibraryDiff.publishes`).
 */
export async function diffWithHistory(latest: LibraryVersion | null, latestVersion: number, have: readonly { key: string; versionHash: string }[], movedOut: readonly Redirect[], history: LibraryHistory): Promise<LibraryDiff> {
  const latestHash = new Map((latest?.assets ?? []).map((a) => [a.key, a.versionHash]));
  const used = new Map<string, string>();
  for (const h of have) {
    const k = usedVersionKey(h.key, h.versionHash);
    if (used.has(k) || !latestHash.has(h.key) || latestHash.get(h.key) === h.versionHash) continue;
    const ufv = (await history.entry(h.key, h.versionHash))?.userFacingVersion;
    if (ufv) used.set(k, ufv);
  }
  const diff = diffAgainst(latest, latestVersion, have, movedOut, used);
  diff.publishes = await publishesOf(diff.updated, latest, history);
  return diff;
}

/** The publishes `updated` come from (by user-facing version; without one, the latest), newest first. */
async function publishesOf(updated: readonly LibraryAsset[], latest: LibraryVersion | null, history: LibraryHistory): Promise<LibraryPublish[]> {
  const numbers = new Set<number>();
  for (const a of updated) numbers.add(publishOf(a, latest?.version ?? 0));
  const out: LibraryPublish[] = [];
  for (const n of numbers) {
    const v = n === latest?.version ? latest : await history.version(n);
    if (v) out.push({ version: v.version, publishedAt: v.publishedAt, description: v.description });
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt || b.version - a.version);
}

/** The library version an asset's content was published in (its user-facing version; else `latest`). */
export function publishOf(a: Pick<LibraryAsset, "userFacingVersion">, latest: number): number {
  const n = Number(a.userFacingVersion);
  return Number.isInteger(n) && n > 0 ? n : latest;
}

/**
 * The moves a publish records as redirects (mode "move"; "copy" records none) — a move `recorded` already holds
 * (the same asset to the same key) isn't recorded twice.
 */
export function movesOf(moves: PublishMoves, lib: string, version: number, at: number, recorded: readonly Redirect[] = []): Redirect[] {
  const known = (m: { fromLibraryFileKey: string; fromKey: string; key: string }) => recorded.some((r) => r.fromLibraryFileKey === m.fromLibraryFileKey && r.fromKey === m.fromKey && r.toKey === m.key);
  return (moves ?? []).filter((m) => m.mode === "move" && !known(m)).map((m) => ({ fromLibraryFileKey: m.fromLibraryFileKey, fromKey: m.fromKey, toLibraryFileKey: lib, toKey: m.key, version, at }));
}

export type PublishMoves = { key: string; fromLibraryFileKey: string; fromKey: string; mode: "move" | "copy" }[] | undefined;

/** The keys a manifest's `wants` pull in with their dependencies (each once, in breadth-first order). */
export function withDependencies(manifestOf: (key: string, versionHash: string) => { asset: LibraryAsset; manifest: LibraryVersion } | null, wants: readonly { key: string; versionHash: string }[]): { key: string; versionHash: string }[] {
  const out: { key: string; versionHash: string }[] = [];
  const done = new Set<string>();
  const queue = [...wants];
  while (queue.length) {
    const w = queue.shift()!;
    if (done.has(w.key)) continue;
    done.add(w.key);
    out.push(w);
    const entry = manifestOf(w.key, w.versionHash);
    for (const dep of entry?.asset.dependencies ?? []) {
      const da = entry!.manifest.assets.find((a) => a.key === dep);
      if (da && !done.has(dep)) queue.push({ key: dep, versionHash: da.versionHash });
    }
  }
  return out;
}
