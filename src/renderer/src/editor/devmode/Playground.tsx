/**
 * The component playground (docs/editor.md D-2; help.figma.com 15023124644247 "Explore component behavior"): the
 * component's preview on the left (the scratch engine's PNG at 2×, fit to its box) and on the right the instance
 * panel's controls — variants, booleans, text, instance swaps (their preferred values), slots read-only — the variable
 * modes of the collections it uses, and the code: its Code Connect snippet, else the generated CSS. "Reset" goes back
 * to the values it opened with. The scratch document never touches the file (scratch.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, FocusTrap, IconButton, Portal, Select, Spinner, Switch, TextInput } from "@/ds";
import type { ComponentProperty, Guid } from "@/engine/codec";
import { t, useT } from "@/i18n";
import { renderEngineExport } from "../exportCore";
import { useEditor, type EditorController } from "../controller";
import { ViewerDoc } from "../../../../viewer/viewerDoc";
import { cssLines, cssSnippet } from "../../../../viewer/inspect/css";
import { codeConnectSnippets, targetOf, type ViewSnippet } from "../../../../viewer/inspect/codeConnect";
import { buildScratch, setScratchMode, setScratchProperty, type Scratch } from "./scratch";
import { editorDevData, setRound5, useRound5, type Round5State } from "./round5";
import styles from "./DevMode.module.css";

const selectPlayground = (s: Round5State) => s.playground;

export function PlaygroundDialog() {
  const ed = useEditor();
  const id = useRound5(ed, selectPlayground);
  if (!id) return null;
  return <Playground key={id} ed={ed} id={id} onClose={() => setRound5(ed, { playground: null })} />;
}

async function previewOf(s: Scratch, images: ((h: string) => Promise<Uint8Array | null>) | null): Promise<string | null> {
  const out = await renderEngineExport(s.engine, images, [s.instance], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } } as never);
  if (!("bytes" in out)) return null;
  return URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "image/png" }));
}

function Playground({ ed, id, onClose }: { ed: EditorController; id: Guid; onClose: () => void }) {
  useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scratch, setScratch] = useState<Scratch | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [reset, setReset] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<{ snippets: ViewSnippet[]; css: string } | null>(null);
  const images = useMemo(() => (ed.source.images ? (h: string) => ed.source.images!.get(h) : null), [ed]);
  const name = useMemo(() => ed.engine.componentInfo(id)?.main?.name ?? ed.engine.readNode(id, { fields: ["name"] })?.name ?? "", [ed, id]);
  // The mappings are the component's in its file, whatever ids its scratch copy has.
  const target = useMemo(() => targetOf(ed.engine.componentInfo(id), editorDevData(ed)?.fileKey ?? null), [ed, id]);

  useEffect(() => {
    let off = false;
    let made: Scratch | null = null;
    void buildScratch(ed.engine, id, canvas.current, images).then((s) => {
      if (off) return s?.engine.destroy();
      made = s;
      setScratch(s);
      setFailed(!s);
      setVersion((v) => v + 1);
    });
    return () => {
      off = true;
      made?.engine.destroy();
      setScratch(null);
    };
  }, [ed, id, images, reset]);

  useEffect(() => {
    if (!scratch) return;
    let off = false;
    void previewOf(scratch, images).then((url) => {
      if (off) return url && URL.revokeObjectURL(url);
      setImage((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    });
    const dev = editorDevData(ed);
    const input = new ViewerDoc(scratch.engine).inspect(scratch.instance);
    const s = input ? cssSnippet(input) : null;
    const css = s ? [cssLines(s.layout), cssLines(s.style), s.typography.length ? cssLines(s.typography, s.textStyle) : ""].filter(Boolean).join("\n\n") : "";
    (dev ? codeConnectSnippets(scratch.engine, scratch.instance, dev.codeConnect, { target }) : Promise.resolve([])).then(
      (snippets) => !off && setSnippet({ snippets, css }),
      () => !off && setSnippet({ snippets: [], css })
    );
    return () => {
      off = true;
    };
  }, [ed, scratch, version, images, target]);

  const info = scratch ? scratch.engine.componentInfo(scratch.instance) : null;
  const collections = useMemo(() => {
    void version;
    try {
      return scratch ? scratch.engine.variableCollections({ includeRemote: true }).filter((c) => c.modes.length > 1) : [];
    } catch {
      return [];
    }
  }, [scratch, version]);
  const [modes, setModes] = useState<Record<string, string>>({});
  const change = (p: ComponentProperty, value: boolean | string) => {
    if (scratch && setScratchProperty(scratch, p, value)) setVersion((v) => v + 1);
  };
  const nameOf = (ref: Guid) => scratch?.engine.readNode(ref, { fields: ["name"] })?.name ?? ref;
  const code = snippet?.snippets[0];

  return (
    <Portal>
      <div className={styles.compareScrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <FocusTrap className={styles.compareTrap}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Explore component behavior")}
            className={styles.compareWindow}
            data-playground-window=""
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              }
            }}
          >
            <header className={styles.compareHeader}>
              <span className={styles.compareTitle}>{name}</span>
              <span className={styles.hint}>{t("Explore component behavior")}</span>
              <span className={styles.grow} />
              <Button
                variant="secondary"
                onClick={() => {
                  setModes({});
                  setReset((r) => r + 1);
                }}
              >
                {t("Reset")}
              </Button>
              <IconButton icon="24.close.small" label={t("Close")} onClick={onClose} />
            </header>
            <canvas ref={canvas} id="playground-canvas" className={styles.hiddenCanvas} aria-hidden />
            <div className={styles.playground}>
              <div className={styles.playgroundPreview} data-playground-preview="">
                {failed ? <span className={styles.hint}>{t("This component can't be previewed.")}</span> : image ? <img src={image} alt={name} /> : <Spinner size={16} />}
              </div>
              <div className={styles.playgroundControls}>
                {info?.properties.map((p) => (
                  <label key={p.id} className={styles.playgroundRow} data-playground-prop={p.name}>
                    <span>{p.name}</span>
                    {p.type === "BOOL" ? (
                      <Switch label={p.name} checked={p.value === true} onChange={(v) => change(p, v)} />
                    ) : p.type === "TEXT" ? (
                      <TextInput label={p.name} value={String(p.value ?? "")} onCommit={(v) => change(p, v)} />
                    ) : p.type === "VARIANT" ? (
                      <Select label={p.name} value={String(p.value ?? "")} options={p.variantOptions.map((o) => ({ value: o, label: o }))} onChange={(v) => change(p, v)} />
                    ) : p.type === "INSTANCE_SWAP" ? (
                      <Select label={p.name} value={String(p.value ?? "")} options={[...new Set([String(p.value ?? ""), ...p.preferredValues])].filter(Boolean).map((v) => ({ value: v, label: nameOf(v) }))} onChange={(v) => change(p, v)} />
                    ) : (
                      <span className={styles.hint}>{t("Slot")}</span>
                    )}
                  </label>
                ))}
                {collections.map((c) => (
                  <label key={c.id} className={styles.playgroundRow} data-playground-mode={c.name}>
                    <span>{c.name}</span>
                    <Select
                      label={c.name}
                      value={modes[c.id] ?? ""}
                      options={[{ value: "", label: t("Auto") }, ...c.modes.map((m) => ({ value: m.modeId, label: m.name }))]}
                      onChange={(v) => {
                        if (scratch && setScratchMode(scratch, c.id, v)) {
                          setModes((m) => ({ ...m, [c.id]: v }));
                          setVersion((x) => x + 1);
                        }
                      }}
                    />
                  </label>
                ))}
                <div className={styles.compareHeading}>{code ? code.label : "CSS"}</div>
                <pre className={styles.playgroundCode} data-playground-code="">
                  {code ? (code.error ? `${code.error.type}: ${code.error.message}` : code.code) : (snippet?.css ?? "")}
                </pre>
              </div>
            </div>
          </div>
        </FocusTrap>
      </div>
    </Portal>
  );
}
