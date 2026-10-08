/**
 * Compare changes (help.figma.com 15023193382935): a top-level frame or component against a saved version — (A) the
 * file's version history (a click compares that version with now; a design marked ready opens on the version saved
 * when it was marked), (B) "Layers" tagged Edited / Added / Deleted, (C) "Side by side", (D) "Overlay" with the current
 * version's transparency, (E) "Compare code" and (F) "Compare properties" for the chosen layer.
 *
 * The version is loaded into an engine of its own (a hidden canvas: its exports draw offscreen); both sides are drawn
 * by the engine's exporter and read through the same engine API.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeBlock, EmptyState, FocusTrap, IconButton, Portal, ScrollArea, SegmentedControl, Spinner } from "@/ds";
import { Engine } from "@/engine/Engine";
import type { Guid, Message, NodeChange } from "@/engine/codec";
import { cssText } from "../../../../viewer/inspect/css";
import { ViewerDoc } from "../../../../viewer/viewerDoc";
import { useEditor, type EditorController } from "../controller";
import type { VersionInfo } from "../documentSource";
import { renderEngineExport } from "../exportCore";
import { useUI } from "../hooks";
import { codeDiff, diffDesign, versionAtOrBefore, type LayerChange } from "./compare";
import styles from "./DevMode.module.css";

export function CompareChanges() {
  const ref = useUI((s) => s.compare?.ref ?? null);
  if (!ref) return null;
  return <Compare key={ref} root={ref} />;
}

const KIND_ORDER: Record<string, number> = { Edited: 0, Added: 1, Deleted: 2 };

function versionTitle(v: VersionInfo): string {
  if (v.title) return v.title;
  return v.kind === "autosave" ? "Autosave" : v.kind === "publish" ? "Library published" : v.kind === "restore" ? "Restored version" : v.kind === "import" ? "Imported" : "Version";
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A design's PNG from an engine, scaled to fit 1200 px, as an object URL. */
async function snapshot(engine: Engine, images: ((h: string) => Promise<Uint8Array | null>) | null, ref: Guid): Promise<string | null> {
  const n = engine.readNode(ref, { fields: ["size"] });
  if (!n?.size) return null;
  const scale = Math.min(2, 1200 / Math.max(1, n.size.x, n.size.y));
  const out = await renderEngineExport(engine, images, [ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: scale } } as never);
  if (!("bytes" in out)) return null;
  return URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "image/png" }));
}

interface Side {
  nodes: NodeChange[];
  image: string | null;
  doc: ViewerDoc;
}

function Compare({ root }: { root: Guid }) {
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [before, setBefore] = useState<Side | null>(null);
  const [after, setAfter] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"side" | "overlay">("side");
  const [opacity, setOpacity] = useState(50);
  const [layer, setLayer] = useState<Guid | null>(null);
  const [detail, setDetail] = useState<"properties" | "code">("properties");
  const name = useMemo(() => ed.engine.readNode(root, { fields: ["name"] })?.name ?? "", [ed, root]);
  const images = ed.source.images ? (h: string) => ed.source.images!.get(h) : null;
  const close = () => ed.ui.set({ compare: null });

  // The version list, and the version the design is compared with first.
  useEffect(() => {
    let off = false;
    void (async () => {
      const list = (await ed.source.listVersions?.()) ?? [];
      if (off) return;
      setVersions(list);
      const info = ed.engine.readNode(root, { fields: ["sectionStatusInfo"] }) as { sectionStatusInfo?: { status?: string; lastUpdateUnixTimestamp?: number } } | null;
      const since = info?.sectionStatusInfo?.status && info.sectionStatusInfo.status !== "NONE" ? (info.sectionStatusInfo.lastUpdateUnixTimestamp ?? 0) * 1000 : null;
      setVersion(versionAtOrBefore(list, since)?.id ?? null);
    })();
    return () => {
      off = true;
    };
  }, [ed, root]);

  // Now: the editor's engine.
  useEffect(() => {
    let off = false;
    void (async () => {
      const nodes = ed.engine.readNodes([root], { subtree: true });
      const image = await snapshot(ed.engine, images, root);
      if (!off) setAfter({ nodes, image, doc: new ViewerDoc(ed.engine) });
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed, root]);

  // The chosen version: loaded into the compare engine.
  useEffect(() => {
    if (!version || !ed.source.openVersion || !canvas.current) return;
    let off = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const message = (await ed.source.openVersion!(version)) as Message;
        if (off) return;
        const engine = (engineRef.current ??= await Engine.create(canvas.current!, { sessionID: 1, theme: "DARK" }));
        if (images) engine.setImageSource(images);
        engine.load(message);
        engine.setViewerMode(true);
        const has = !!engine.readNode(root, { fields: ["type"] });
        const nodes = has ? engine.readNodes([root], { subtree: true }) : [];
        const image = has ? await snapshot(engine, images, root) : null;
        if (!off) setBefore({ nodes, image, doc: new ViewerDoc(engine) });
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!off) setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed, root, version]);

  useEffect(
    () => () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    },
    []
  );
  useEffect(() => () => void (before?.image && URL.revokeObjectURL(before.image)), [before]);
  useEffect(() => () => void (after?.image && URL.revokeObjectURL(after.image)), [after]);

  const changes = useMemo<LayerChange[]>(() => (before && after ? diffDesign(root, before.nodes, after.nodes) : []), [root, before, after]);
  const chosen = changes.find((c) => c.id === layer) ?? changes.find((c) => c.kind === "Edited") ?? null;
  const counts = changes.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const v = versions?.find((x) => x.id === version) ?? null;

  return (
    <Portal>
      <div className={styles.compareScrim} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <FocusTrap className={styles.compareTrap}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compare changes"
        className={styles.compareWindow}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      >
      <header className={styles.compareHeader}>
        <span className={styles.compareTitle}>Compare changes</span>
        <span className={styles.hint}>{name}</span>
        <span className={styles.grow} />
        <IconButton icon="24.close.small" label="Close" onClick={close} />
      </header>
      <canvas ref={canvas} id="compare-canvas" className={styles.hiddenCanvas} aria-hidden />
      <div className={styles.compare} data-compare="">
        <nav className={styles.compareNav}>
          <div className={styles.compareHeading}>Version history</div>
          <ScrollArea className={styles.compareVersions}>
            {versions === null ? (
              <Spinner size={16} />
            ) : versions.length === 0 ? (
              <div className={styles.hint}>No saved versions yet. Save one with Save to version history (⌥⌘S).</div>
            ) : (
              [...versions]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((x) => (
                  <button key={x.id} type="button" className={styles.compareVersion} aria-current={x.id === version || undefined} data-version={x.id} onClick={() => setVersion(x.id)}>
                    <span>{versionTitle(x)}</span>
                    <span className={styles.hint}>{when(x.createdAt)}</span>
                  </button>
                ))
            )}
          </ScrollArea>
          <div className={styles.compareHeading}>Layers</div>
          <ScrollArea className={styles.compareLayers}>
            {before && after && !changes.length && <div className={styles.hint}>No changes since this version.</div>}
            {[...changes]
              .sort((a, b) => (a.depth === 0 ? -1 : b.depth === 0 ? 1 : 0) || 0)
              .map((c) => (
                <button key={c.id} type="button" className={styles.compareLayer} style={{ paddingLeft: 8 + c.depth * 12 }} aria-current={c.id === chosen?.id || undefined} data-change={c.kind} onClick={() => setLayer(c.id)}>
                  <span className={styles.grow}>{c.name || c.type}</span>
                  <span className={styles.changeTag} data-kind={c.kind}>
                    {c.kind}
                  </span>
                </button>
              ))}
          </ScrollArea>
        </nav>
        <section className={styles.compareMain}>
          <div className={styles.compareToolbar}>
            <SegmentedControl
              label="View"
              value={view}
              options={[
                { value: "side", label: "Side by side" },
                { value: "overlay", label: "Overlay" },
              ]}
              onChange={(x) => setView(x as "side" | "overlay")}
            />
            {view === "overlay" && (
              <input type="range" min={0} max={100} value={opacity} aria-label="Current version opacity" onChange={(e) => setOpacity(Number(e.target.value))} className={styles.overlaySlider} />
            )}
            <span className={styles.grow} />
            <span className={styles.hint} data-change-counts="">
              {Object.keys(counts)
                .sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b])
                .map((k) => `${counts[k]} ${k.toLowerCase()}`)
                .join(" · ")}
            </span>
          </div>
          {error ? (
            <EmptyState icon="24.warning" title="This version can't be opened" body={error} />
          ) : !ed.source.openVersion ? (
            <EmptyState icon="24.info" title="Version history isn't available for this file" />
          ) : loading || !after ? (
            <div className={styles.compareLoading}>
              <Spinner size={24} />
            </div>
          ) : view === "side" ? (
            <div className={styles.sideBySide}>
              <figure className={styles.compareFigure}>
                <figcaption>{v ? `${versionTitle(v)} · ${when(v.createdAt)}` : "Previous version"}</figcaption>
                {before?.image ? <img src={before.image} alt="Previous version" data-before="" /> : <div className={styles.hint}>Not in this version</div>}
              </figure>
              <figure className={styles.compareFigure}>
                <figcaption>Current version</figcaption>
                {after.image && <img src={after.image} alt="Current version" data-after="" />}
              </figure>
            </div>
          ) : (
            <div className={styles.overlay} onClick={() => setOpacity((o) => (o > 0 ? 0 : 100))}>
              {before?.image && <img src={before.image} alt="Previous version" />}
              {after.image && <img src={after.image} alt="Current version" style={{ opacity: opacity / 100 }} />}
            </div>
          )}
        </section>
        <aside className={styles.compareDetail}>
          {chosen ? (
            <>
              <SegmentedControl
                label="Details"
                value={detail}
                options={[
                  { value: "properties", label: "Compare properties" },
                  { value: "code", label: "Compare code" },
                ]}
                onChange={(x) => setDetail(x as "properties" | "code")}
              />
              <div className={styles.compareLayerName}>{chosen.name}</div>
              {detail === "properties" ? (
                chosen.kind === "Edited" ? (
                  <div className={styles.propDiff} data-properties="">
                    {chosen.changes.map((p) => (
                      <div key={p.field} className={styles.propRow} data-field={p.field}>
                        <span className={styles.propLabel}>{p.label}</span>
                        <span className={styles.propBefore}>{p.before}</span>
                        <span className={styles.propAfter}>{p.after}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.hint}>{chosen.kind === "Added" ? "This layer was added." : "This layer was deleted."}</div>
                )
              ) : (
                <CodeCompare ed={ed} id={chosen.id} before={before} after={after} />
              )}
            </>
          ) : (
            <div className={styles.hint}>Select an edited layer to compare its properties and code.</div>
          )}
        </aside>
      </div>
      </div>
      </FocusTrap>
      </div>
    </Portal>
  );
}

function CodeCompare({ id, before, after }: { ed: EditorController; id: Guid; before: Side | null; after: Side | null }) {
  const code = (side: Side | null) => {
    const input = side?.doc.inspect(id);
    return input ? cssText(input) : "";
  };
  const diff = codeDiff(code(before), code(after));
  return (
    <div className={styles.codeDiff} data-code-diff="">
      <div className={styles.compareHeading}>Previous</div>
      <CodeBlock code={diff.before.map((l) => (l.changed ? `- ${l.text}` : `  ${l.text}`)).join("\n")} />
      <div className={styles.compareHeading}>Current</div>
      <CodeBlock code={diff.after.map((l) => (l.changed ? `+ ${l.text}` : `  ${l.text}`)).join("\n")} />
    </div>
  );
}
