/**
 * The image's secondary toolbar (docs/ai.md §4; Figma's help 24004542669463): with image layers selected it opens 8
 * over the bottom toolbar, as vector edit's does — "Edit with prompt", "Remove background", "Select area", More ▾
 * ("Expand", "Boost resolution", "Vectorize"). Each tool swaps the toolbar for its own controls:
 * - Edit with prompt / Make an image: the prompt card (prompt, the model dropdown, + reference — also paste or drop —
 *   "Send" or ⌘↵).
 * - Select area: draw a lasso on the image, then "Erase", "Isolate" or "Blur" (ours, docs/studio.md §6.2).
 * - Expand: drag the blue handles, an aspect ratio dropdown, the blue check.
 * - Vectorize: "Full color" / "Grayscale" / "Black and white" with its setting, a live preview, ✓ / ✕.
 * A run shows its sweep over the layers and "Cancel"; a model's first download asks first, with its size.
 * Several selected images: Remove background and Boost resolution work on all of them (one step).
 */
import { t, useT } from "@/i18n";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button, ContextMenu, Dialog, IconButton, SegmentedControl, Select, Spinner, TextArea, Toolbar, ToolbarDivider, ToolTextButton } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { AiRoute, AiSettings, ImageRouteInfo } from "../../../../shared/ai/types";
import { useEditor } from "../controller";
import { useTopics } from "../hooks";
import { useStoreSlice } from "../uiStore";
import type { EditorController } from "../controller";
import { editorAi, imageToolsOf, type ImageTools } from "./controller";
import { registerAiImageRow } from "../ai/actionRows";
import { findMoreLike } from "../search";
import { EXPAND_ASPECTS, ImageCanvasOverlays, padForAspect } from "./CanvasOverlays";
import type { Rgba } from "./pixels";
import { decodeImage, imageTargets } from "./tools";
import { VECTORIZE_MODES, type VectorizeMode } from "./vectorize";
import styles from "./ImageTools.module.css";

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

/** "Make an image" from Actions or the fill picker: the prompt card, filling `target` (else the selection, else a new layer). */
export function openMakeImage(ed: EditorController, target?: Guid | null): void {
  imageToolsOf(ed).open("make", target === undefined ? (ed.selection.length === 1 ? ed.selection[0] : null) : target);
}

const MORE: { id: string; label: string }[] = [
  { id: "expand", label: "Expand" },
  { id: "boost", label: "Boost resolution" },
  { id: "vectorize", label: "Vectorize" },
];

/** The image providers for the model dropdown: the routes that can run (`ai:image-routes`), else by Settings › AI's keys. */
function routeOptions(s: AiSettings | null, routes: ImageRouteInfo[] | null) {
  const out = [{ value: "antigravity", label: "Antigravity (Google AI)" }];
  if (routes) {
    for (const r of routes) if (r.available && r.providerId !== "antigravity") out.push({ value: r.providerId, label: r.label });
    return out;
  }
  if (s?.imageKeys.openai) out.push({ value: "openai-images", label: "OpenAI Images" });
  if (s?.imageKeys.gemini) out.push({ value: "gemini-images", label: "Gemini API" });
  return out;
}

function PromptCard({ tools, kind }: { tools: ImageTools; kind: "make" | "edit" }) {
  useT();
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<{ image: Rgba; url: string } | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [routes, setRoutes] = useState<ImageRouteInfo[] | null>(null);
  const [route, setRoute] = useState<string>("");
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const busy = useStoreSlice(tools.state, (s) => !!s.busy);
  useEffect(() => {
    void editorAi()
      ?.settings()
      .then((s) => {
        setSettings(s);
        setRoute((r) => r || (s.actions[kind === "make" ? "make-image" : "edit-image"] ?? s.image)?.providerId || "antigravity");
      })
      .catch(() => {});
    void editorAi()
      ?.imageRoutes?.()
      .then(setRoutes)
      .catch(() => {});
  }, [kind]);
  const takeFile = async (f: File | null | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    const image = await decodeImage(new Uint8Array(await f.arrayBuffer())).catch(() => null);
    if (image) setReference({ image, url: URL.createObjectURL(f) });
  };
  const send = (value = prompt) => {
    const text = value.trim();
    if (!text || busy) return;
    // Settings › AI's model rides along when its provider is the one picked
    const set = settings?.actions[kind === "make" ? "make-image" : "edit-image"] ?? settings?.image;
    const r: AiRoute | undefined = route ? { providerId: route, ...(set?.providerId === route && set.model ? { model: set.model } : {}) } : undefined;
    const o = { ...(reference ? { reference: reference.image } : {}), ...(r ? { route: r } : {}) };
    void (kind === "make" ? tools.makeImage(text, { ...o, target: tools.state.get().target }) : tools.editWithPrompt(text, o));
  };
  return (
    <div
      className={styles.card}
      role="dialog"
      aria-label={kind === "make" ? t("Make an image") : t("Edit with prompt")}
      data-image-prompt={kind}
      data-drop={over || undefined}
      onPaste={(e: ClipboardEvent) => void takeFile(Array.from(e.clipboardData.files)[0])}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        void takeFile(Array.from(e.dataTransfer.files)[0]);
      }}
    >
      <div className={styles.cardHead}>
        {kind === "make" ? t("Make an image") : t("Edit with prompt")}
        <IconButton icon="24.close.small" label={t("Close")} onClick={() => tools.close()} />
      </div>
      <TextArea label={t("Prompt")} value={prompt} placeholder={kind === "make" ? t("Describe the image you want") : t("Describe your edit")} minRows={2} maxRows={6} onChange={setPrompt} onExit={(r) => r === "enter" && send()} autoFocus />
      <div className={styles.cardFoot}>
        <IconButton icon="24.plus" label={t("Add a reference image")} onClick={() => file.current?.click()} />
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void takeFile(e.currentTarget.files?.[0])} />
        {reference && (
          <span className={styles.reference} title={t("Reference image")}>
            <img src={reference.url} alt={t("Reference image")} />
          </span>
        )}
        <span className={styles.spacer} />
        <Select label={t("Model")} variant="ghost" value={route} options={routeOptions(settings, routes)} onChange={setRoute} />
        <Button variant="primary" disabled={!prompt.trim() || busy} loading={busy} shortcut="⌘↵" onClick={() => send()}>
          {t("Send")}
        </Button>
      </div>
    </div>
  );
}

function VectorizeControls({ tools }: { tools: ImageTools }) {
  useT();
  const session = useStoreSlice(tools.state, (s) => s.vectorize);
  const [, setTick] = useState(0);
  useEffect(() => session?.subscribe(() => setTick((t) => t + 1)), [session]);
  if (!session)
    return (
      <span className={styles.busyLabel}>
        <Spinner size={16} />
        {t("Vectorizing…")}
      </span>
    );
  const s = session.settings;
  const mode = VECTORIZE_MODES.find((m) => m.id === s.mode)!;
  const range = session.range(s.mode);
  return (
    <>
      <SegmentedControl label={t("Mode")} tone="toolbar" value={s.mode} options={VECTORIZE_MODES.map((m) => ({ value: m.id, label: t(m.label) }))} onChange={(v) => session.set({ mode: v as VectorizeMode })} />
      <ToolbarDivider />
      <label className={styles.setting}>
        {t(mode.settingLabel)}
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={s[mode.setting]}
          aria-label={t(mode.settingLabel)}
          onChange={(e) => session.set({ [mode.setting]: Number(e.currentTarget.value) })}
          onKeyDown={(e) => {
            // Figma's big step with Shift (10 colours / grays, 0.1 of the threshold).
            if (!e.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            const sign = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
            session.set({ [mode.setting]: Math.min(range.max, Math.max(range.min, Math.round((s[mode.setting] + sign * range.bigStep) * 100) / 100)) });
          }}
        />
        <span className={styles.value}>{mode.setting === "threshold" ? s.threshold.toFixed(2) : s[mode.setting]}</span>
      </label>
      {session.stats?.exceeded && <span className={styles.stats}>{t("Too detailed to preview")}</span>}
      <ToolbarDivider />
      <IconButton icon="24.check" label={t("Apply")} onClick={() => tools.applyVectorize()} />
      <IconButton icon="24.close.small" label={t("Cancel")} onClick={() => tools.cancelVectorize()} />
    </>
  );
}

function DownloadDialog({ tools }: { tools: ImageTools }) {
  useT();
  const confirm = useStoreSlice(tools.state, (s) => s.confirm);
  if (!confirm) return null;
  const { info } = confirm;
  return (
    <Dialog
      title={t("Download AI model?")}
      open
      onClose={() => tools.answerDownload(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => tools.answerDownload(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={() => tools.answerDownload(true)}>
            Download ({formatSize(info.bytes)})
          </Button>
        </>
      }
    >
      <p data-model-download={info.id}>
        {t("{use} runs on this computer with {model} ({license}). It downloads once ({size}) and is kept for next time. You can remove it in Settings › AI.", { use: t(info.use), model: info.label, license: info.license, size: formatSize(info.bytes) })}
      </p>
    </Dialog>
  );
}

/** The image toolbar, its overlays and dialogs; nothing when no image is selected and no tool is open. */
export function ImageToolbar() {
  useT();
  const ed = useEditor();
  const tools = imageToolsOf(ed);
  useTopics(ed.store, ["selection", "undo"]);
  const mode = useStoreSlice(tools.state, (s) => s.mode);
  const busy = useStoreSlice(tools.state, (s) => s.busy);
  const download = useStoreSlice(tools.state, (s) => s.download);
  const lasso = useStoreSlice(tools.state, (s) => s.lasso.length >= 3);
  const aspect = useStoreSlice(tools.state, (s) => s.aspect);
  const pad = useStoreSlice(tools.state, (s) => s.pad);
  const more = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const targets = imageTargets(ed);
  const one = targets.length === 1 && ed.selection.length === 1;

  // Actions' Image editing rows (6a's actionRows.ts) run these tools.
  useEffect(() => {
    const some = (e: EditorController) => imageTargets(e).length > 0;
    const single = (e: EditorController) => e.selection.length === 1 && imageTargets(e).length === 1;
    const offs = [
      registerAiImageRow("make-image", { run: (e) => openMakeImage(e) }),
      registerAiImageRow("remove-background", { run: (e) => void imageToolsOf(e).removeBackground(), enabled: some }),
      registerAiImageRow("boost-resolution", { run: (e) => void imageToolsOf(e).boostResolution(), enabled: some }),
      registerAiImageRow("edit-image", { run: (e) => imageToolsOf(e).open("edit"), enabled: single }),
      registerAiImageRow("visual-search", { run: () => findMoreLike(), enabled: (e) => e.selection.length > 0 }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // A tool closes when its image is no longer selected (Vectorize keeps its own preview frame selected-free).
  useEffect(() => {
    const st = tools.state.get();
    if (!st.mode || st.mode === "make" || st.mode === "vectorize" || st.busy) return;
    if (!st.target || !ed.selection.includes(st.target)) tools.close();
  });

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter applies Vectorize's Recolor (Figma's ✓).
      if (e.key === "Enter" && mode === "vectorize" && tools.state.get().vectorize) {
        e.stopPropagation();
        e.preventDefault();
        tools.applyVectorize();
        return;
      }
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (tools.running) tools.cancel();
      else if (mode === "vectorize") tools.cancelVectorize();
      else tools.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, tools]);

  const overlays = (
    <>
      <ImageCanvasOverlays tools={tools} />
      <DownloadDialog tools={tools} />
      {(mode === "make" || mode === "edit") && <PromptCard key={mode} tools={tools} kind={mode} />}
    </>
  );
  if (!targets.length && !mode && !busy) return overlays;
  if (mode === "make" && !busy) return overlays;

  let body;
  if (busy || download) {
    body = (
      <>
        <span className={styles.busyLabel} data-image-busy="">
          <Spinner size={16} />
          {download && !busy?.progress ? t("Downloading {name}… {percent}%", { name: download.label, percent: Math.round(download.share * 100) }) : t(busy?.label ?? "Working…")}
        </span>
        <ToolbarDivider />
        <ToolTextButton label={t("Cancel")} onSelect={() => tools.cancel()} />
      </>
    );
  } else if (mode === "select-area") {
    body = (
      <>
        <span className={styles.busyLabel}>{lasso ? t("Area selected") : t("Draw around an area")}</span>
        <ToolbarDivider />
        <ToolTextButton label={t("Erase")} disabled={!lasso} onSelect={() => void tools.erase()} />
        <ToolTextButton label={t("Isolate")} disabled={!lasso} onSelect={() => void tools.isolate()} />
        <ToolTextButton label={t("Blur")} disabled={!lasso} onSelect={() => void tools.blur()} />
        <ToolbarDivider />
        <IconButton icon="24.close.small" label={t("Close")} onClick={() => tools.close()} />
      </>
    );
  } else if (mode === "expand") {
    const node = tools.targetImage()?.node;
    const grown = pad.left + pad.right + pad.top + pad.bottom > 0;
    body = (
      <>
        <Select
          label={t("Aspect ratio")}
          variant="ghost"
          value={aspect}
          options={EXPAND_ASPECTS.map((a) => ({ value: a.value, label: t(a.label) }))}
          onChange={(v) => tools.state.set({ aspect: v, pad: node?.size ? padForAspect(node.size, v) : pad })}
        />
        <ToolbarDivider />
        <IconButton icon="24.check" label={t("Expand")} disabled={!grown} onClick={() => void tools.expand()} />
        <IconButton icon="24.close.small" label={t("Cancel")} onClick={() => tools.close()} />
      </>
    );
  } else if (mode === "vectorize") {
    body = <VectorizeControls tools={tools} />;
  } else {
    body = (
      <>
        <ToolTextButton label={t("Edit with prompt")} active={mode === "edit"} disabled={!one} onSelect={() => tools.open(mode === "edit" ? null : "edit")} />
        <ToolTextButton label={t("Remove background")} onSelect={() => void tools.removeBackground()} />
        <ToolTextButton label={t("Select area")} disabled={!one} onSelect={() => tools.open("select-area")} />
        <ToolbarDivider />
        <div ref={more} className={styles.row}>
          <ToolTextButton
            label={t("More")}
            chevron
            aria-haspopup="menu"
            aria-expanded={!!menuAt}
            onSelect={(e) => {
              if (menuAt) return setMenuAt(null);
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: r.left - 11, y: r.top - 16 });
            }}
          />
        </div>
        {menuAt && (
          <ContextMenu
            at={menuAt}
            above
            flush
            label={t("More image tools")}
            width={189}
            // Then, past a line, Visual search (Figma's More menu, atlas 02 §2: the selection's images as the query).
            entries={[...MORE.map((m) => ({ ...m, label: t(m.label), disabled: m.id !== "boost" && !one })), "-", { id: "visual-search", label: t("Visual search") }]}
            ignore={more}
            onSelect={(id) => {
              setMenuAt(null);
              if (id === "expand") tools.open("expand");
              else if (id === "boost") void tools.boostResolution();
              else if (id === "vectorize") void tools.startVectorize();
              else if (id === "visual-search") findMoreLike();
            }}
            onClose={() => setMenuAt(null)}
          />
        )}
      </>
    );
  }
  return (
    <>
      <Toolbar floating secondary label={t("Image tools")} data-image-toolbar={mode ?? ""}>
        {body}
      </Toolbar>
      {overlays}
    </>
  );
}
