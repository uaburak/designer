// Visual search (docs/ai.md §6): the app's "Visual search" dialog (ds Dialog, drawn in place, with VisualSearch's own
// CSS) beside a strip of the open file's frames. Typing searches as you type — exact names first, then by look and
// words — the image button turns to "Search with image or selection" with "Find more like", and a result previews
// with "Open the file" and "Insert". The ranking is the store's (searchData.ts); the vectors are stood in for.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Dialog } from "@/ds/components/Dialog";
import { EmptyState } from "@/ds/components/Misc";
import { SearchField } from "@/ds/components/SearchField";
import { Select } from "@/ds/components/Select";
import { Spinner } from "@/ds/components/Spinner";
import { Tabs } from "@/ds/components/Tabs";
import { tooltipProps } from "@/ds/overlay/TooltipManager";
import vs from "@/editor/search/VisualSearch.module.css";
import { SceneCanvas, SceneWindow } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { HITS, searchLike, searchText, type Ranked } from "./searchData";
import { RunPill, reducedMotion } from "./shared";
import styles from "./search.module.css";

const ON_CANVAS = ["signin", "onboarding", "analytics"];
const DESIGNS_FIRST = 6;

export default function VisualSearchScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"text" | "image">("text");
  const [selected, setSelected] = useState<string | null>("signin");
  const [like, setLike] = useState<string | null>(null);
  const [library, setLibrary] = useState("");
  const [seeMore, setSeeMore] = useState(false);
  const [sort, setSort] = useState<"relevance" | "modified">("relevance");
  const [preview, setPreview] = useState<Ranked | null>(null);
  const [busy, setBusy] = useState(false);
  const [pill, setPill] = useState<string | null>(null);

  const hits = useMemo<Ranked[] | null>(() => {
    if (mode === "image") return like ? searchLike(like) : null;
    return text.trim() ? searchText(text, sort) : null;
  }, [mode, like, text, sort]);
  const inLibrary = (r: Ranked) => !library || r.hit.file === library;
  const components = (hits ?? []).filter((r) => r.hit.kind === "component" && inLibrary(r));
  const designs = (hits ?? []).filter((r) => r.hit.kind === "frame");

  // Results move to their new places (FLIP: transform only)
  const prev = useRef(new Map<string, DOMRect>());
  const order = (hits ?? []).map((r) => r.hit.id).join(",") + library + seeMore;
  useLayoutEffect(() => {
    const box = resultsRef.current;
    if (!box) {
      prev.current = new Map();
      return;
    }
    const next = new Map<string, DOMRect>();
    const motion = !reducedMotion();
    for (const el of box.querySelectorAll<HTMLElement>("[data-hit]")) {
      const r = el.getBoundingClientRect();
      next.set(el.dataset.hit!, r);
      const p = prev.current.get(el.dataset.hit!);
      if (!motion || typeof el.animate !== "function") continue;
      if (p) {
        const dx = p.left - r.left;
        const dy = p.top - r.top;
        if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" });
      } else el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
    }
    prev.current = next;
  }, [order]);

  const findMoreLike = (id = selected) => {
    if (!id) return;
    setMode("image");
    setPreview(null);
    setBusy(true);
    setLike(null);
    setTimeout(() => {
      setLike(id);
      setBusy(false);
    }, 700);
  };

  const tile = (r: Ranked) => (
    <div key={r.hit.id} className={vs.tile} data-hit={r.hit.id} data-exact={r.exact || undefined}>
      <button type="button" className={vs.thumbButton} aria-label={`Preview ${r.hit.name}`} onClick={() => setPreview(r)} {...tooltipProps(r.exact ? "Exact name match" : `Image ${r.image.toFixed(2)} · Text ${r.text.toFixed(2)}`)}>
        <span className={`${vs.thumb} ${styles.thumb}`}>{r.hit.thumb()}</span>
      </button>
      <div className={vs.meta}>
        <span className={vs.name}>{r.hit.name}</span>
        <span className={vs.file}>{r.hit.file}</span>
      </div>
      <div className={vs.actions}>
        <Button variant="primary" onClick={() => setPill(`Inserted “${r.hit.name}”`)}>
          Insert
        </Button>
      </div>
    </div>
  );

  let body;
  if (preview) {
    body = (
      <div className={vs.preview} data-preview="">
        <div className={vs.previewBar}>
          <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={() => setPreview(null)} />
          <span className={vs.name}>{preview.hit.name}</span>
          <span className={vs.file}>{preview.hit.file}</span>
        </div>
        <div className={vs.previewBox}>
          <span className={`${vs.thumbLarge} ${styles.thumbLarge}`}>{preview.hit.thumb()}</span>
        </div>
        <div className={vs.previewActions}>
          <Button variant="secondary" onClick={() => setPill(`Opened “${preview.hit.file}”`)}>
            Open the file
          </Button>
          <Button variant="primary" onClick={() => setPill(`Inserted “${preview.hit.name}”`)}>
            Insert
          </Button>
        </div>
      </div>
    );
  } else if (busy) {
    body = (
      <div className={vs.note}>
        <Spinner size={24} />
      </div>
    );
  } else if (!hits) {
    body = <EmptyState icon="24.search" title="Find similar designs" body="Search with keywords, a description, a selected layer or an image." />;
  } else if (!hits.length) {
    body = <div className={vs.note}>{mode === "text" ? `No results for “${text.trim()}”` : "No similar designs found"}</div>;
  } else {
    body = (
      <div ref={resultsRef} className={vs.results} data-search-results="">
        {components.length > 0 && (
          <section>
            <div className={vs.heading}>Components</div>
            <div className={`${vs.grid} ${styles.grid}`}>{components.slice(0, 4).map(tile)}</div>
          </section>
        )}
        {designs.length > 0 && !library && (
          <section>
            <div className={vs.heading}>
              <span>Other designs</span>
              {!seeMore && designs.length > DESIGNS_FIRST && (
                <Button variant="ghost" onClick={() => setSeeMore(true)}>
                  See more
                </Button>
              )}
            </div>
            {seeMore && (
              <div className={vs.filters}>
                <Select
                  label="Filter by file owner"
                  value="anyone"
                  width="hug"
                  variant="ghost"
                  options={[
                    { value: "anyone", label: "Anyone" },
                    { value: "you", label: "You" },
                    { value: "others", label: "Others" },
                  ]}
                  onChange={() => undefined}
                />
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
            <div className={`${vs.grid} ${styles.grid}`}>{(seeMore ? designs : designs.slice(0, DESIGNS_FIRST)).map(tile)}</div>
          </section>
        )}
      </div>
    );
  }

  const reset = () => {
    setText("");
    setMode("text");
    setSelected("signin");
    setLike(null);
    setLibrary("");
    setSeeMore(false);
    setSort("relevance");
    setPreview(null);
    setPill(null);
  };
  const api = { setText, setMode, setSelected, findMoreLike, setPreview, setPill };
  const apiRef = useRef(api);
  apiRef.current = api;
  const { cursor } = useDemo(rootRef, (r) => demo(r, apiRef), { onStart: reset });
  const sel = HITS.find((h) => h.id === selected);

  return (
    <SceneWindow ref={rootRef} title="Tempo — Onboarding">
      <SceneCanvas className={styles.canvas}>
        <div className={styles.layout}>
          <div className={styles.strip} aria-label="Frames on the canvas">
            {ON_CANVAS.map((id) => {
              const h = HITS.find((x) => x.id === id)!;
              return (
                <button key={id} type="button" className={styles.frame} data-selected={selected === id || undefined} onClick={() => setSelected(selected === id ? null : id)} data-canvas-frame={id}>
                  <span className={styles.frameName}>{h.name}</span>
                  <span className={styles.frameThumb}>{h.thumb()}</span>
                </button>
              );
            })}
          </div>
          <div className={styles.dialogSlot}>
            <Dialog title="Visual search" size="large" open static onClose={reset}>
              <div className={`${vs.view} ${styles.view}`} data-visual-search="">
                <div className={vs.bar}>
                  {mode === "text" ? (
                    <SearchField className={vs.field} value={text} onChange={(v) => (setText(v), setPreview(null))} placeholder="Search by keywords" label="Search by keywords" data-search-input="" />
                  ) : (
                    <div className={vs.imageQuery} data-image-query="">
                      {like || sel ? (
                        <>
                          <span className={`${vs.queryImage} ${styles.queryImage}`}>{(HITS.find((h) => h.id === (like ?? selected)) ?? sel)!.thumb()}</span>
                          <span className={vs.name}>{(HITS.find((h) => h.id === (like ?? selected)) ?? sel)!.name}</span>
                        </>
                      ) : (
                        <span className={vs.file}>Select a layer, upload an image or paste one</span>
                      )}
                    </div>
                  )}
                  <IconButton
                    icon={mode === "text" ? "24.image" : "24.search.small"}
                    label={mode === "text" ? "Search with image or selection" : "Search by keywords"}
                    onClick={() => {
                      setPreview(null);
                      setLike(null);
                      setMode(mode === "text" ? "image" : "text");
                    }}
                    data-mode-toggle=""
                  />
                </div>
                {mode === "image" && (
                  <div className={vs.imageActions}>
                    <Button variant="secondary" onClick={() => setPill("Upload picks a picture from your computer")}>
                      Upload
                    </Button>
                    {selected && (
                      <Button variant="secondary" onClick={() => findMoreLike()} data-find-more="">
                        Find more like
                      </Button>
                    )}
                    <Button variant="primary" disabled={!selected} onClick={() => findMoreLike()}>
                      Search
                    </Button>
                  </div>
                )}
                <div className={vs.tabs}>
                  <Tabs label="Results" value="figma" tabs={[{ value: "figma", label: "Figma" }]} onChange={() => undefined} />
                  <Select
                    label="Library"
                    value={library}
                    width="hug"
                    variant="ghost"
                    options={[
                      { value: "", label: "All libraries" },
                      { value: "Tempo — Design system", label: "Tempo — Design system" },
                      { value: "Ledger — Design system", label: "Ledger — Design system" },
                    ]}
                    onChange={setLibrary}
                  />
                </div>
                <div className={vs.body}>{body}</div>
              </div>
            </Dialog>
          </div>
        </div>
        {pill && (
          <RunPill>
            <span>{pill}</span>
            <IconButton icon="24.close.small" label="Dismiss" tone="secondary" onClick={() => setPill(null)} />
          </RunPill>
        )}
        <DemoCursor cursor={cursor} />
      </SceneCanvas>
    </SceneWindow>
  );
}

type Api = {
  setText: (t: string) => void;
  setMode: (m: "text" | "image") => void;
  setSelected: (id: string | null) => void;
  findMoreLike: (id?: string | null) => void;
  setPreview: (r: Ranked | null) => void;
};

async function demo(run: SceneRun, api: { current: Api }) {
  await run.wait(900);
  const type = async (t: string) => {
    for (let i = 1; i <= t.length; i++) {
      api.current.setText(t.slice(0, i));
      await run.wait(90);
    }
  };
  await run.click(run.$("[data-search-input]"));
  await type("dark chart");
  await run.wait(2200);
  api.current.setText("");
  await type("password");
  await run.wait(2000);
  // Find more like the selected frame
  await run.click(run.$('[data-canvas-frame="onboarding"]'));
  api.current.setSelected("onboarding");
  await run.wait(500);
  await run.click(run.$("[data-mode-toggle]"));
  api.current.setMode("image");
  await run.wait(500);
  await run.click(run.$("[data-find-more]"));
  api.current.findMoreLike("onboarding");
  await run.wait(2200);
  const first = run.$("[data-hit] button");
  await run.click(first);
  first?.click();
  await run.wait(2200);
  run.hide();
  await run.wait(800);
}
