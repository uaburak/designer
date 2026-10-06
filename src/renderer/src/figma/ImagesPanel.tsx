import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import { ScrollArea } from "@/components/ScrollArea";
import { WEB_IMAGE, deleteFile, downloadUrl, isFresh, keptFiles, knownUrl, listKept, onKeptFilesChange, publicUrl, storagePathOf, uploadMedia } from "@/lib/storage";
import { referencedUrls } from "@/lib/firestore";
import type { FigmaDocument } from "./model";
import { CollapseHeader, IconButton, Tab } from "./ui";

/**
 * The bucket's images, in the left sidebar (Images): the ones this file
 * uses, or every file — seen, put to use (on the selected layers, or placed
 * on the canvas), uploaded (web-sized: see uploadMedia), deleted; and the
 * ones nothing on the site refers to any more (Find unused), to clean up.
 *
 * Gentle on the quota (Storage bills each request and each download):
 *  - it is mounted when first opened, and stays (without rendering again
 *    while hidden);
 *  - a folder is listed in one request, once a day at most — the list is kept
 *    (see storage.ts' listKept); Refresh asks again; uploads and deletes
 *    anywhere in the editor change the kept list itself;
 *  - pictures load only as they scroll into sight (not the browser's own lazy
 *    loading, which reaches thousands of pixels ahead), from the address the
 *    file's layers draw them with when they are in use (the browser has them
 *    already), else the one met, else their public address — no download URL
 *    asked for each; an upload is kept by the browser for a year (see
 *    uploadFile's cache control).
 */

export type ImagesScope = "used" | "all";

/** Newest first: the time in the file's name (uploads are named by it), then the name. */
const stamp = (path: string) => Number(path.match(/(\d{13})(?!.*\d{13})/)?.[1] ?? 0);
const byNewest = (a: string, b: string) => stamp(b) - stamp(a) || b.localeCompare(a);

const failure = (err: unknown) => (err instanceof Error ? err.message : "Couldn't list the images.");

/** The bucket's files a file's layers draw (their fills, overrides, embeds), with the address they draw each with. */
function usedIn(file: FigmaDocument): Map<string, string> {
  const used = new Map<string, string>();
  for (const m of JSON.stringify(file).matchAll(/https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^"\\\s)'<>]+/g)) {
    const path = storagePathOf(m[0]);
    if (path && !used.has(path)) used.set(path, m[0]);
  }
  return used;
}

/** The nearest ancestor that scrolls: what a picture loads within sight of. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** A picture asked for only once it scrolls near the panel's sight — then kept. */
function LazyImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setShown(true);
        io.disconnect();
      }
    }, { root: scroller(el), rootMargin: "120px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return (
    <span ref={ref} className="absolute inset-0 block">
      {shown && <img src={src} alt={alt} decoding="async" draggable={false} className="block w-full h-full object-cover" />}
    </span>
  );
}

export const ImagesPanel = memo(function ImagesPanel({ slug, file, active, canFill, onUse }: {
  slug: string;
  /** The file, while the panel is in sight: what its layers use is marked (null while hidden: nothing to read) */
  file: FigmaDocument | null;
  /** In sight (the panel stays mounted when it isn't) */
  active: boolean;
  /** Something selected takes an image fill: "Use" puts it there (else it places the image on the canvas) */
  canFill: boolean;
  /** Put an image to use: on the selected layers, or placed on the canvas */
  onUse: (url: string, name: string) => void;
}) {
  void slug;
  const [scope, setScope] = useState<ImagesScope>("used");
  // One list of the whole bucket (one request per 1000 files): the scopes are filters of it.
  const prefix = "";
  // The kept list (storage.ts): read again whenever it changes — here, in another tab, or as a list comes back.
  const [version, setVersion] = useState(0);
  useEffect(() => onKeptFilesChange(() => setVersion((v) => v + 1)), []);
  const kept = useMemo(() => (version >= 0 ? keptFiles(prefix) : null), [prefix, version]);
  const allPaths = useMemo(() => (kept ? kept.paths.filter((p) => WEB_IMAGE.test(p)).sort(byNewest) : null), [kept]);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState<{ prefix: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Asked for as the panel is first shown and when the scope changes — unless the kept list is fresh (an older one is shown meanwhile).
  useEffect(() => {
    const list = keptFiles(prefix);
    if (list && isFresh(list)) return;
    let live = true;
    listKept(prefix).catch((err) => live && setFailed({ prefix, message: failure(err) }));
    return () => {
      live = false;
    };
  }, [prefix]);
  const refresh = () => {
    setRefreshing(true);
    setFailed(null);
    listKept(prefix)
      .catch((err) => setFailed({ prefix, message: failure(err) }))
      .finally(() => setRefreshing(false));
  };
  const listFailed = failed?.prefix === prefix ? failed.message : null;

  // What the file's layers use: read while in sight, a moment after an edit (not in its way); no picture asked for before it is read.
  const [used, setUsed] = useState<Map<string, string> | null>(null);
  const read = useRef(false);
  useEffect(() => {
    if (!active || !file) return;
    const timer = window.setTimeout(() => setUsed(usedIn(file)), read.current ? 300 : 0);
    read.current = true;
    return () => window.clearTimeout(timer);
  }, [active, file]);

  // ── Unused: what nothing on the site refers to (read once asked for — it reads every project) ──
  const [unused, setUnused] = useState<Set<string> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const findUnused = async () => {
    setScanning(true);
    setError(null);
    try {
      const [listed, urls] = await Promise.all([listKept(prefix), referencedUrls()]);
      const referenced = new Set(urls.map((u) => storagePathOf(u)).filter((p): p is string => Boolean(p)));
      setUnused(new Set(listed.filter((p) => WEB_IMAGE.test(p) && !referenced.has(p))));
      setScope("all");
    } catch (err) {
      setError(err instanceof Error ? `Couldn't check: ${err.message}` : "Couldn't check what is used.");
    } finally {
      setScanning(false);
    }
  };
  const clearUnused = async () => {
    if (!unused?.size) return;
    if (!window.confirm(`Delete ${unused.size} image${unused.size === 1 ? "" : "s"} nothing on the site uses? This can't be undone (a project's older saved versions may still mention them).`)) return;
    setClearing(true);
    for (const path of [...unused]) {
      try {
        await deleteFile(path);
        setUnused((u) => (u ? new Set([...u].filter((p) => p !== path)) : u));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete an image.");
        break;
      }
    }
    setClearing(false);
  };
  const paths = useMemo(() => (allPaths && used && scope === "used" ? allPaths.filter((p) => used.has(p)) : allPaths), [allPaths, used, scope]);

  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      setError(null);
      setUploading(files.length);
      for (const f of files) {
        try {
          // Checked (a web picture, 25 MB at most) and made web-sized (2560px at most, WebP) before it goes up.
          await uploadMedia(f);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Upload failed.");
        }
        setUploading((n) => n - 1);
      }
      // What was uploaded is what is wanted next: all of the bucket, the newest first.
      setScope("all");
    };
    input.click();
  };

  const remove = async (path: string) => {
    setBusy(path);
    setError(null);
    try {
      await deleteFile(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the image.");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  /** The address to put to use or copy: the one the file draws it with, else its download URL (kept once asked). */
  const urlOf = (path: string) => used?.get(path) ?? downloadUrl(path);
  const use = async (path: string) => {
    setBusy(path);
    try {
      onUse(await urlOf(path), path.split("/").pop()?.replace(/\.[^.]+$/, "") || "Image");
    } finally {
      setBusy(null);
    }
  };
  const copyLink = async (path: string) => {
    setBusy(path);
    try {
      await navigator.clipboard.writeText(await urlOf(path));
    } finally {
      setBusy(null);
    }
  };

  const pick = (next: ImagesScope) => {
    setScope(next);
    setConfirming(null);
    setFailed(null);
  };

  const status = uploading > 0
    ? `Uploading ${uploading}…`
    : paths
      ? `${paths.length} image${paths.length === 1 ? "" : "s"}${unused ? ` · ${unused.size} unused` : ""}${kept ? ` · listed ${new Date(kept.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}${refreshing ? " · refreshing…" : ""}`
      : listFailed ? "" : "Listing…";
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <CollapseHeader
        label="Images"
        icons={
          <>
            <IconButton label="Refresh" icon={fi("24.rotate")} disabled={refreshing} onClick={refresh} />
            <IconButton label="Upload images" icon={fi("plus.small")} disabled={uploading > 0} onClick={upload} />
          </>
        }
      />
      <div role="tablist" className="shrink-0 flex items-center gap-1 px-3 pb-2">
        <Tab label="Used here" active={scope === "used"} onClick={() => pick("used")} />
        <Tab label="All files" active={scope === "all"} onClick={() => pick("all")} />
      </div>
      <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
        <button type="button" disabled={scanning} onClick={() => void findUnused()} className="h-6 px-2 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer disabled:opacity-50">
          {scanning ? "Checking every page…" : "Find unused"}
        </button>
        {unused && unused.size > 0 && (
          <button type="button" disabled={clearing} onClick={() => void clearUnused()} className="h-6 px-2 rounded-[5px] text-[11px] text-[#f24822] border border-[#f24822]/40 hover:bg-[#f24822]/10 cursor-pointer disabled:opacity-50">
            {clearing ? "Deleting…" : `Delete ${unused.size} unused`}
          </button>
        )}
      </div>
      <p className="shrink-0 px-4 pb-2 text-[11px] leading-4 text-[var(--f-text-secondary)]">{status}</p>
      {(error ?? listFailed) && <p role="alert" className="shrink-0 px-4 pb-2 text-[11px] leading-4 text-[#f24822]">{error ?? listFailed}</p>}
      <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full overflow-x-hidden pb-4" inset={8} edge={2}>
        {paths && paths.length === 0 && (
          <p className="px-4 py-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">{scope === "used" ? "This file uses no image of the bucket yet." : "No images yet. Upload with +."}</p>
        )}
        {used && (
          <div className="grid grid-cols-2 gap-2 px-3">
            {paths?.map((path) => {
              const name = path.split("/").pop() ?? path;
              const folder = path.slice(prefix.length, path.length - name.length - 1) || "/";
              const inUse = used.has(path);
              const asking = confirming === path;
              return (
                <div key={path} className="flex flex-col gap-1 min-w-0">
                  <div title={path} className={cn("group/tile relative aspect-square rounded-[5px] overflow-hidden bg-[var(--f-bg-secondary)]", busy === path && "opacity-50")}>
                    <LazyImage src={used.get(path) ?? knownUrl(path) ?? publicUrl(path)} alt={name} />
                    {inUse && <span className="absolute top-1 left-1 px-1 rounded-[3px] bg-[var(--f-bg)] text-[9px] leading-[14px] text-[var(--f-text-brand)] shadow-[0_0_0.5px_rgba(0,0,0,0.3)]">In use</span>}
                    {unused?.has(path) && <span className="absolute top-1 left-1 px-1 rounded-[3px] bg-[var(--f-bg)] text-[9px] leading-[14px] text-[#f24822] shadow-[0_0_0.5px_rgba(0,0,0,0.3)]">Unused</span>}
                    {!asking && (
                      <div className="absolute right-1 bottom-1 flex gap-0.5 p-0.5 rounded-[6px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)] opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 transition-opacity">
                        <IconButton label={canFill ? "Use on selection" : "Place on canvas"} icon={fi("24.fill.image.small")} disabled={busy === path} onClick={() => void use(path)} />
                        <IconButton label="Copy link" icon={fi("copy.small")} disabled={busy === path} onClick={() => void copyLink(path)} />
                        <IconButton label="Delete" icon={fi("trash")} disabled={busy === path} onClick={() => setConfirming(path)} />
                      </div>
                    )}
                    {asking && (
                      <div role="alertdialog" aria-label="Delete image" className="absolute inset-0 flex flex-col justify-end gap-1 p-1.5 bg-[var(--f-bg)]/95">
                        <p className="text-[10px] leading-3 text-[var(--f-text)]">
                          Delete for good?{inUse ? " It is used in this file." : unused?.has(path) ? " Nothing on the site uses it." : " Other projects may use it — Find unused tells."}
                        </p>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => void remove(path)} disabled={busy === path} className="flex-1 h-6 rounded-[5px] bg-[#f24822] text-[11px] font-[550] text-white cursor-pointer disabled:opacity-50">Delete</button>
                          <button type="button" onClick={() => setConfirming(null)} className="flex-1 h-6 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] text-[var(--f-text)] cursor-pointer">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="truncate text-[10px] leading-3 text-[var(--f-text-secondary)]" title={path}>{folder}</span>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
});
