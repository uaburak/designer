/**
 * The Code Connect UI (docs/editor.md D-1 "Code Connect UI"; developers.figma.com code-connect-ui-setup): the file's
 * components and component sets — name, thumbnail, how many mappings — and, for the chosen one, its mappings. "+"
 * adds a mapping: the label (React, SwiftUI, Compose, Vue, HTML … or typed), the path, the component's name and
 * "Instructions for MCP"; Inspect then shows the snippet "Generated from properties". A mapping published from the CLI
 * is listed read-only, with "Edit in code". Opened from Dev Mode's file name menu › Library ▸ Connect components to
 * code, or Inspect › Connect components (focused on that component). GitHub autocomplete isn't built.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, FocusTrap, Icon, IconButton, Portal, ScrollArea, SearchField, Select, TextArea, TextInput, showToast } from "@/ds";
import type { Guid } from "@/engine/codec";
import { t, tp, useT } from "@/i18n";
import type { CodeConnectMapping } from "@shared/devmode/types";
import { useEditor, type EditorController } from "../controller";
import { devRepo, fileKeyOf, round5, setRound5, useRound5, type Round5State } from "./round5";
import styles from "./DevMode.module.css";

export const LABELS = ["React", "SwiftUI", "Compose", "Vue", "HTML", "Angular", "Web Components", "Storybook"];

/** The snippet language a label implies (the server's `languageOf`). */
export function languageOfLabel(label: string): string {
  const l = label.toLowerCase();
  if (l === "react" || l === "storybook") return "tsx";
  if (l === "swiftui" || l === "uikit") return "swift";
  if (l === "compose" || l === "jetpack compose") return "kotlin";
  if (l === "vue") return "vue";
  if (l === "html" || l === "web components" || l === "angular") return "html";
  return "raw";
}

const selectConnect = (s: Round5State) => s.connect;

export function CodeConnectDialog() {
  const ed = useEditor();
  const connect = useRound5(ed, selectConnect);
  if (!connect) return null;
  return <ConnectWindow ed={ed} focus={connect.focus} onClose={() => setRound5(ed, { connect: null })} />;
}

function thumbOf(ed: EditorController, id: Guid): string | null {
  try {
    const px = ed.engine.renderNodeThumbnailPixels({ node: id, maxSize: 64 });
    if (!px) return null;
    const c = document.createElement("canvas");
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    return c.toDataURL();
  } catch {
    return null;
  }
}

interface Draft {
  label: string;
  custom: string;
  source: string;
  component: string;
  instructions: string;
}
const emptyDraft = (component: string): Draft => ({ label: "React", custom: "", source: "", component, instructions: "" });

function ConnectWindow({ ed, focus, onClose }: { ed: EditorController; focus: Guid[]; onClose: () => void }) {
  useT();
  const repo = devRepo();
  const fileKey = fileKeyOf(ed);
  const assets = useMemo(() => ed.components.assets(), [ed]);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<Guid | null>(() => focus.find((id) => assets.some((a) => a.id === id)) ?? assets[0]?.id ?? null);
  const [mappings, setMappings] = useState<CodeConnectMapping[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(0);
  const canEdit = round5(ed).canEdit;

  useEffect(() => (repo ? repo.watch((e) => e.what === "codeConnect" && setVersion((v) => v + 1)) : undefined), [repo]);
  useEffect(() => {
    if (!repo || !fileKey) return;
    let live = true;
    repo.codeConnect(fileKey).then(
      (m) => live && setMappings(m),
      () => live && setMappings([])
    );
    return () => {
      live = false;
    };
  }, [repo, fileKey, version]);

  const shown = assets.filter((a) => !query || a.name.toLowerCase().includes(query.toLowerCase()));
  const asset = assets.find((a) => a.id === current) ?? null;
  const own = mappings.filter((m) => m.nodeId === current);
  const save = async () => {
    if (!repo || !fileKey || !asset || !draft) return;
    const label = (draft.label === "Other" ? draft.custom : draft.label).trim();
    if (!label) return void showToast({ message: t("Choose a label"), kind: "error" });
    if (own.some((m) => m.label === label && m.origin === "cli")) return void showToast({ message: t("This component has a mapping for that label from the CLI. Edit it in code."), kind: "error" });
    try {
      await repo.setCodeConnect(fileKey, { nodeId: asset.id, label, language: languageOfLabel(label), source: draft.source.trim() || null, component: draft.component.trim() || null, imports: [], nestable: true, instructions: draft.instructions });
      setDraft(null);
      setVersion((v) => v + 1);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };
  const remove = async (m: CodeConnectMapping) => {
    if (!repo || !fileKey) return;
    try {
      await repo.removeCodeConnect(fileKey, m.nodeId, m.label);
      setVersion((v) => v + 1);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };
  const component = (asset?.name.split("/").pop() ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

  return (
    <Portal>
      <div className={styles.compareScrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <FocusTrap className={styles.compareTrap}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Connect components to code")}
            className={styles.compareWindow}
            data-code-connect-ui=""
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              }
            }}
          >
            <header className={styles.compareHeader}>
              <span className={styles.compareTitle}>{t("Connect components to code")}</span>
              <span className={styles.grow} />
              <IconButton icon="24.close.small" label={t("Close")} onClick={onClose} />
            </header>
            <div className={styles.connectBody}>
              <nav className={styles.connectList} aria-label={t("Components")}>
                <SearchField label={t("Search components")} value={query} onChange={setQuery} placeholder={t("Search")} />
                {shown.map((a) => {
                  const count = mappings.filter((m) => m.nodeId === a.id).length;
                  return (
                    <button key={a.id} type="button" className={styles.connectRow} aria-current={a.id === current} data-connect-component={a.id} onClick={() => { setCurrent(a.id); setDraft(null); }}>
                      <Thumb ed={ed} id={a.id} />
                      <span className={styles.grow}>{a.name}</span>
                      <span className={styles.hint}>{count ? tp(count, "{n} mapping", "{n} mappings") : t("Not connected")}</span>
                    </button>
                  );
                })}
                {!assets.length && <span className={styles.hint}>{t("This file has no components.")}</span>}
              </nav>
              <ScrollArea className={styles.connectDetail}>
                {asset && (
                  <>
                    <div className={styles.connectMappingHead}>
                      <Icon name={asset.kind === "set" ? "16.component.set" : "16.component"} />
                      <span className={styles.grow}>{asset.name}</span>
                      {canEdit && !draft && (
                        <Button variant="secondary" icon="24.plus.small" onClick={() => setDraft(emptyDraft(component))} data-add-mapping="">
                          {t("Add mapping")}
                        </Button>
                      )}
                    </div>
                    {own.length === 0 && !draft && <span className={styles.hint}>{t("Connect this component to its code: add the file path and the component's name. Inspect then shows a snippet for its instances.")}</span>}
                    {own.map((m) => (
                      <div key={m.label} className={styles.connectMapping} data-mapping={m.label} data-origin={m.origin}>
                        <div className={styles.connectMappingHead}>
                          <span className={styles.grow}>{m.label}</span>
                          {m.origin === "cli" ? (
                            <Button variant="secondary" disabled={!/^https?:\/\//.test(m.source ?? "")} onClick={() => m.source && window.open(m.source, "_blank", "noopener")}>
                              {t("Edit in code")}
                            </Button>
                          ) : (
                            canEdit && (
                              <>
                                <Button variant="secondary" onClick={() => setDraft({ label: LABELS.includes(m.label) ? m.label : "Other", custom: LABELS.includes(m.label) ? "" : m.label, source: m.source ?? "", component: m.component ?? "", instructions: m.instructions })}>
                                  {t("Edit")}
                                </Button>
                                <IconButton icon="24.minus.small" label={t("Remove mapping")} onClick={() => void remove(m)} />
                              </>
                            )
                          )}
                        </div>
                        {m.component && <span>{m.component}</span>}
                        {m.source && <span className={styles.hint}>{m.source}</span>}
                        {m.origin === "cli" && <span className={styles.hint}>{t("Published from the Code Connect CLI")}</span>}
                        {m.instructions && <span className={styles.hint}>{m.instructions}</span>}
                      </div>
                    ))}
                    {draft && (
                      <div className={styles.connectMapping} data-mapping-form="">
                        <div className={styles.connectForm}>
                          <span>{t("Label")}</span>
                          <Select label={t("Label")} value={draft.label} options={[...LABELS, "Other"].map((l) => ({ value: l, label: l === "Other" ? t("Other") : l }))} onChange={(v) => setDraft({ ...draft, label: v })} />
                          {draft.label === "Other" && (
                            <>
                              <span />
                              <TextInput label={t("Custom label")} value={draft.custom} placeholder={t("Label")} onChange={(v) => setDraft({ ...draft, custom: v })} />
                            </>
                          )}
                          <span>{t("Path")}</span>
                          <TextInput label={t("Path")} value={draft.source} placeholder={t("src/components/Button.tsx or a link")} onChange={(v) => setDraft({ ...draft, source: v })} autoFocus />
                          <span>{t("Component name")}</span>
                          <TextInput label={t("Component name")} value={draft.component} placeholder="Button" onChange={(v) => setDraft({ ...draft, component: v })} />
                          <span>{t("Instructions for MCP")}</span>
                          <TextArea label={t("Instructions for MCP")} value={draft.instructions} placeholder={t("Optional")} onChange={(v) => setDraft({ ...draft, instructions: v })} />
                        </div>
                        <div className={styles.noteActions}>
                          <span className={styles.grow} />
                          <Button variant="secondary" onClick={() => setDraft(null)}>
                            {t("Cancel")}
                          </Button>
                          <Button variant="primary" onClick={() => void save()} data-save-mapping="">
                            {t("Save")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </ScrollArea>
            </div>
          </div>
        </FocusTrap>
      </div>
    </Portal>
  );
}

function Thumb({ ed, id }: { ed: EditorController; id: Guid }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSrc(thumbOf(ed, id)), 0);
    return () => clearTimeout(timer);
  }, [ed, id]);
  return <span className={styles.connectThumb}>{src && <img src={src} alt="" />}</span>;
}
