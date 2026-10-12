/**
 * Visual search's view (docs/ai.md §6; Figma's help "Search for assets and designs using AI", 24037716110615): opened
 * from Actions' "Visual search (AI beta)" button, "Find more like" (the selection) and "Upload".
 *
 * - "Search by keywords": a description or keywords, searched as you type.
 * - "Search with image or selection": the selected layer, or "Upload" / a pasted picture, then "Search".
 * - Tabs "Figma" (this computer's files; the Community tab is left out) with a library filter; components first, then
 *   "Other designs" with "See more" — which adds "Filter by file owner", "Filter by space", "Sort by relevance" /
 *   "Sort by last modified".
 * - A result: "Preview" (larger, in this view), "Open the file" (its tab, at the node), "Insert" (into this file).
 *
 * The models download on first use after a confirmation with their size (docs/ai.md §10.2); without them the text
 * search matches names only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ContextMenu, Dialog, EmptyState, IconButton, SearchField, Select, Spinner, Tabs, showToast, type SelectEntry } from "@/ds";
import type { SearchHit } from "../../../../shared/ai/types";
import type { FileListItem } from "../../../../shared/store/types";
import { getStoreClient } from "@/store";
import type { EditorController } from "../controller";
import type { RgbaImage } from "./embedder";
import { downloadSearchModels, formatBytes, indexingOn, modelsApi, searchModels, type SearchModels } from "./models";
import { NoModelsError, runSearch, splitHits } from "./query";
import { decodeImage, fileKeyOf, indexNow, insertHit, openHitFile, pngUrl, readyEmbedder, searchRepo } from "./runtime";
import { THUMB_SIZE, editorSearchSource } from "./source";
import styles from "./VisualSearch.module.css";

export interface VisualSearchRequest {
  selection?: boolean;
  image?: Uint8Array;
  seq: number;
}

type Mode = "text" | "image";
type Owner = "anyone" | "you" | "others";
/** "Other designs" shown before "See more" */
const DESIGNS_FIRST = 6;

export function VisualSearch({ ed, request, onClose }: { ed: EditorController; request: VisualSearchRequest; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(request.selection || request.image ? "image" : "text");
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ pixels: RgbaImage; url: string; label: string } | null>(null);
  const [library, setLibrary] = useState("");
  const [sort, setSort] = useState<"relevance" | "modified">("relevance");
  const [owner, setOwner] = useState<Owner>("anyone");
  const [space, setSpace] = useState("");
  const [seeMore, setSeeMore] = useState(false);
  const [found, setHits] = useState<SearchHit[] | null>(null);
  const [semantic, setSemantic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<SearchModels | null>(null);
  const [indexing, setIndexing] = useState(true);
  const [preview, setPreview] = useState<SearchHit | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: SearchHit } | null>(null);
  const [files, setFiles] = useState<Map<string, FileListItem | null>>(new Map());
  const [folders, setFolders] = useState<Map<string, string>>(new Map());
  const searchSeq = useRef(0);
  const upload = useRef<HTMLInputElement>(null);

  // The models and the indexing switch
  useEffect(() => {
    let live = true;
    void searchModels().then((m) => live && setModels(m));
    void indexingOn().then((on) => live && setIndexing(on));
    void getStoreClient()
      .workspace.listFolders()
      .then((list) => live && setFolders(new Map(list.map((f) => [f.id as string, f.name]))), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const showImage = (pixels: RgbaImage, label: string) => {
    const c = document.createElement("canvas");
    c.width = pixels.width;
    c.height = pixels.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(pixels.pixels), pixels.width, pixels.height), 0, 0);
    setImage({ pixels, url: c.toDataURL(), label });
  };

  // What opened the view: the selection ("Find more like"), or an image handed in
  useEffect(() => {
    if (request.image) {
      void decodeImage(new Blob([request.image as BlobPart])).then(
        (px) => showImage(px, "Image"),
        () => setError("The image couldn't be read."),
      );
    } else if (request.selection) takeSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request
  }, [request.seq]);

  function takeSelection() {
    const id = ed.selection[0];
    const key = fileKeyOf(ed) ?? "";
    if (!id) return setError("Select a layer to find more like it.");
    const px = editorSearchSource(ed, key).pixels(id, THUMB_SIZE, true);
    if (!px || px === "busy") return setError("The selection couldn't be drawn.");
    const name = (ed.engine.readNode(id, { fields: ["name"] }) as { name?: string } | null)?.name ?? "Selection";
    setMode("image");
    showImage(px, name);
  }

  const search = async (input: { text?: string; image?: RgbaImage }) => {
    const seq = ++searchSeq.current;
    setBusy(true);
    setError(null);
    try {
      const embedder = await readyEmbedder();
      const out = await runSearch(searchRepo(), { ...input, sort, libraryKey: library || undefined, limit: 120 }, embedder);
      if (seq !== searchSeq.current) return;
      setHits(out.hits);
      setSemantic(out.semantic);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setHits(null);
      setError(err instanceof NoModelsError ? "Download the models to search with an image." : err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  };

  // Text: searched as you type
  useEffect(() => {
    if (mode !== "text" || !text.trim()) return;
    const t = setTimeout(() => void search({ text }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query's inputs
  }, [text, mode, sort, library, models?.state]);

  // An image from the selection or an opener: searched at once; an upload waits for "Search"
  useEffect(() => {
    if (mode !== "image" || !image || !(request.selection || request.image) || image.label === "Upload") return;
    const t = setTimeout(() => void search({ image: image.pixels }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the image arrives
  }, [image, sort, library]);

  // The files of the results: their names, owners and spaces for the filters
  useEffect(() => {
    if (!found) return;
    const missing = [...new Set(found.map((h) => h.doc.fileKey))].filter((k) => !files.has(k));
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map((k) => getStoreClient().workspace.getFile(k as never).then((f) => [k, f] as const, () => [k, null] as const))).then((rows) => {
      if (!live) return;
      setFiles((m) => new Map([...m, ...rows]));
    });
    return () => {
      live = false;
    };
  }, [found, files]);

  const onPaste = (e: React.ClipboardEvent) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    setMode("image");
    void decodeImage(file).then(
      (px) => {
        showImage(px, "Pasted image");
        void search({ image: px });
      },
      () => setError("The image couldn't be read."),
    );
  };

  const download = async () => {
    const api = modelsApi();
    if (!api || !models) return;
    setModels({ ...models, state: "downloading", received: 0 });
    try {
      await downloadSearchModels(api, setModels);
      setModels(await searchModels(api));
      indexNow();
    } catch (err) {
      setModels({ ...models, state: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const insert = async (hit: SearchHit) => {
    try {
      const made = await insertHit(ed, hit);
      if (!made) return showToast({ message: "It couldn't be inserted" });
      onClose();
    } catch {
      showToast({ message: "The file couldn't be read", kind: "error" });
    }
  };

  // ---- filters ----

  const spaces = useMemo(() => {
    const out = new Map<string, string>();
    for (const [k, f] of files) {
      if (!f) continue;
      const id = spaceOf(files, k);
      out.set(id, id === "drafts" ? "Drafts" : id.startsWith("org:") ? "Organization" : (folders.get(f.folderId ?? "") ?? "Folder"));
    }
    return out;
  }, [files, folders]);

  // An emptied search field shows the start again
  const hits = mode === "text" && !text.trim() ? null : found;
  const { components, designs } = splitHits(hits ?? []);
  const shownDesigns = designs.filter((h) => (owner === "anyone" || ownerOf(files, h.doc.fileKey) === owner) && (!space || spaceOf(files, h.doc.fileKey) === space));

  const libraries = ed.libraries.get();
  const libraryOptions: SelectEntry[] = [{ value: "", label: "All libraries" }, ...libraries.available.map((l) => ({ value: l.fileKey, label: l.name }))];
  const here = fileKeyOf(ed);
  if (here && !libraries.available.some((l) => l.fileKey === here)) libraryOptions.splice(1, 0, { value: here, label: "Created in this file" });

  // ---- the body ----

  const tile = (h: SearchHit) => (
    <div
      key={`${h.doc.fileKey}/${h.doc.nodeId}`}
      className={styles.tile}
      data-search-hit={h.doc.name}
      data-exact={h.exact || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, hit: h });
      }}
    >
      <button type="button" className={styles.thumbButton} aria-label={`Preview ${h.doc.name}`} onClick={() => setPreview(h)}>
        <Thumb hit={h} />
      </button>
      <div className={styles.meta}>
        <span className={styles.name} title={h.doc.name}>
          {h.doc.name}
        </span>
        <span className={styles.file} title={`${h.doc.fileName} · ${h.doc.pageName}`}>
          {h.doc.fileName}
        </span>
      </div>
      {/* On hover: Insert; a click previews (Open the file, Insert); right click: all three */}
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void insert(h)}>
          Insert
        </Button>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (preview) {
    body = (
      <div className={styles.preview} data-search-preview="">
        <div className={styles.previewBar}>
          <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={() => setPreview(null)} />
          <span className={styles.name}>{preview.doc.name}</span>
          <span className={styles.file}>{`${preview.doc.fileName} · ${preview.doc.pageName}`}</span>
        </div>
        <div className={styles.previewBox}>
          <Thumb hit={preview} large />
        </div>
        <div className={styles.previewActions}>
          <Button variant="secondary" size="large" onClick={() => void openHitFile(preview)}>
            Open the file
          </Button>
          <Button variant="primary" size="large" onClick={() => void insert(preview)}>
            Insert
          </Button>
        </div>
      </div>
    );
  } else if (error) {
    body = <div className={styles.note}>{error}</div>;
  } else if (busy && !hits) {
    body = (
      <div className={styles.note}>
        <Spinner size={24} />
      </div>
    );
  } else if (!hits) {
    body = <EmptyState icon="24.search" title="Find similar designs" body="Search with keywords, a description, a selected layer or an image." />;
  } else if (!hits.length) {
    body = <div className={styles.note}>{mode === "text" ? `No results for “${text.trim()}”` : "No similar designs found"}</div>;
  } else {
    body = (
      <div className={styles.results} data-search-results="">
        {components.length > 0 && (
          <section>
            <div className={styles.heading}>Components</div>
            <div className={styles.grid}>{components.map(tile)}</div>
          </section>
        )}
        {designs.length > 0 && !library && (
          <section>
            <div className={styles.heading}>
              <span>Other designs</span>
              {!seeMore && designs.length > DESIGNS_FIRST && (
                <Button variant="ghost" onClick={() => setSeeMore(true)}>
                  See more
                </Button>
              )}
            </div>
            {seeMore && (
              <div className={styles.filters} data-search-filters="">
                <Select
                  label="Filter by file owner"
                  value={owner}
                  width="hug"
                  variant="ghost"
                  options={[
                    { value: "anyone", label: "Anyone" },
                    { value: "you", label: "You" },
                    { value: "others", label: "Others" },
                  ]}
                  onChange={(v) => setOwner(v as Owner)}
                />
                <Select label="Filter by space" value={space} width="hug" variant="ghost" options={[{ value: "", label: "All spaces" }, ...[...spaces].map(([value, label]) => ({ value, label }))]} onChange={setSpace} />
                <Select
                  label="Sort"
                  value={sort}
                  width="hug"
                  variant="ghost"
                  options={[
                    { value: "relevance", label: "Sort by relevance" },
                    { value: "modified", label: "Sort by last modified" },
                  ]}
                  onChange={(v) => setSort(v as "relevance" | "modified")}
                />
              </div>
            )}
            <div className={styles.grid}>{(seeMore ? shownDesigns : shownDesigns.slice(0, DESIGNS_FIRST)).map(tile)}</div>
          </section>
        )}
      </div>
    );
  }

  const modelsBanner =
    models?.state === "absent" || models?.state === "error" ? (
      <Banner tone="brand" icon="24.image" action={{ label: models.state === "error" ? "Try again" : "Download", onClick: () => void download() }}>
        {models.state === "error" ? `The models didn't download: ${models.error}` : `Visual search needs two models on this computer (${formatBytes(models.bytes)}). They download once.`}
      </Banner>
    ) : models?.state === "downloading" ? (
      <Banner tone="brand" icon="24.image">
        {`Downloading the models… ${models.bytes ? Math.round(((models.received ?? 0) / models.bytes) * 100) : 0}%`}
      </Banner>
    ) : models?.state === "unavailable" ? (
      <Banner icon="24.image">Local models aren't available in this version yet. Search matches names only.</Banner>
    ) : !indexing ? (
      <Banner icon="24.image">Indexing is off in Settings › AI, so new designs aren't added.</Banner>
    ) : null;

  return (
    <Dialog title="Visual search" size="large" open onClose={onClose}>
      <div className={styles.view} onPaste={onPaste} data-visual-search="">
        <div className={styles.bar}>
          {mode === "text" ? (
            <SearchField className={styles.field} value={text} onChange={setText} autoFocus placeholder="Search by keywords" label="Search by keywords" />
          ) : (
            <div className={styles.imageQuery} data-image-query="">
              {image ? <img src={image.url} alt="" className={styles.queryImage} /> : <span className={styles.file}>Select a layer, upload an image or paste one</span>}
              {image && <span className={styles.name}>{image.label}</span>}
            </div>
          )}
          <IconButton
            icon={mode === "text" ? "24.image" : "24.search.small"}
            label={mode === "text" ? "Search with image or selection" : "Search by keywords"}
            onClick={() => {
              setHits(null);
              setError(null);
              if (mode === "text") {
                setMode("image");
                if (ed.selection.length) takeSelection();
              } else setMode("text");
            }}
          />
        </div>
        {mode === "image" && (
          <div className={styles.imageActions}>
            <Button variant="secondary" onClick={() => upload.current?.click()}>
              Upload
            </Button>
            {ed.selection.length > 0 && (
              <Button variant="secondary" onClick={takeSelection}>
                Find more like
              </Button>
            )}
            <Button variant="primary" disabled={!image || busy} onClick={() => image && void search({ image: image.pixels })}>
              Search
            </Button>
            <input
              ref={upload}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void decodeImage(f).then((px) => showImage(px, "Upload"), () => setError("The image couldn't be read."));
              }}
            />
          </div>
        )}
        {modelsBanner}
        <div className={styles.tabs}>
          <Tabs label="Results" value="figma" tabs={[{ value: "figma", label: "Figma" }]} onChange={() => undefined} />
          <Select label="Library" value={library} width="hug" variant="ghost" options={libraryOptions} onChange={setLibrary} />
        </div>
        {!semantic && hits && hits.length > 0 && <div className={styles.hint}>Matching names only.</div>}
        <div className={styles.body}>{body}</div>
        {menu && (
          <ContextMenu
            at={menu}
            label={menu.hit.doc.name}
            entries={[
              { id: "open", label: "Open the file" },
              { id: "preview", label: "Preview" },
              { id: "insert", label: "Insert" },
            ]}
            onSelect={(id) => {
              if (id === "open") void openHitFile(menu.hit);
              else if (id === "preview") setPreview(menu.hit);
              else if (id === "insert") void insert(menu.hit);
            }}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Where a result's file lives, for "Filter by space": Drafts, a folder, or an organization's space */
function spaceOf(files: ReadonlyMap<string, FileListItem | null>, k: string): string {
  const f = files.get(k);
  if (!f) return "";
  if (f.space) return `org:${f.space.orgId}`;
  return f.folderId ? `folder:${f.folderId}` : "drafts";
}

/** "Filter by file owner": this computer's own files are yours; an organization's shared files are others' [ours] */
const ownerOf = (files: ReadonlyMap<string, FileListItem | null>, k: string): Owner => (files.get(k)?.space ? "others" : "you");

/** A result's thumbnail, from the store */
function Thumb({ hit, large }: { hit: SearchHit; large?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void searchRepo()
      .thumb(hit.doc.fileKey, hit.doc.nodeId)
      .then((png) => {
        if (!live || !png) return;
        made = pngUrl(png);
        setUrl(made);
      }, () => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [hit.doc.fileKey, hit.doc.nodeId, hit.doc.version]);
  return <span className={large ? styles.thumbLarge : styles.thumb}>{url && <img src={url} alt="" draggable={false} />}</span>;
}
