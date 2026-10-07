/**
 * The library registry's rules (docs/data.md §9), free of storage: what a publish adds, changes and removes, what a
 * consumer's copies are missing, the record's counts, the shape checks. The store's `LocalLibraries` (files on
 * disk) and the browser dev store's `MemoryLibraries` (localStorage) both run these, so the editor sees the same
 * registry in either.
 */
import { StoreError } from "./protocol";
import { isAssetKey, type LibraryAsset, type LibraryDiff, type LibraryRecord, type LibraryVersion, type PublishAsset, type PublishPreview, type Redirect } from "./types";

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

/** A consumer's copies `have` against the latest version (§9.4): newer versions, removed assets, moved ones. */
export function diffAgainst(latest: LibraryVersion | null, latestVersion: number, have: readonly { key: string; versionHash: string }[], movedOut: readonly Redirect[]): LibraryDiff {
  const byKey = new Map((latest?.assets ?? []).map((a) => [a.key, a]));
  const updated: LibraryAsset[] = [];
  const removed: string[] = [];
  const moved: Redirect[] = [];
  for (const h of have) {
    const a = byKey.get(h.key);
    if (a) {
      if (a.versionHash !== h.versionHash) updated.push(a);
      continue;
    }
    const m = movedOut.find((x) => x.fromKey === h.key);
    if (m) moved.push(m);
    else removed.push(h.key);
  }
  return { latestVersion, updated, removed, moved };
}

/** The moves a publish records as redirects (mode "move"; "copy" records none). */
export function movesOf(moves: PublishMoves, lib: string, version: number, at: number): Redirect[] {
  return (moves ?? []).filter((m) => m.mode === "move").map((m) => ({ fromLibraryFileKey: m.fromLibraryFileKey, fromKey: m.fromKey, toLibraryFileKey: lib, toKey: m.key, version, at }));
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
