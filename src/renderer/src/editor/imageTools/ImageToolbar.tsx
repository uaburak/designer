/**
 * The image's secondary toolbar (docs/ai.md §4; Figma's help 24004542669463): with image layers selected it opens 8
 * over the bottom toolbar, as vector edit's does — "Edit with prompt", "Remove background", "Select area", More ▾
 * ("Expand", "Boost resolution", "Vectorize"). Each tool swaps the toolbar for its own controls:
 * - Edit with prompt / Make an image: the prompt card (prompt, the model dropdown, + reference — also paste or drop —
 *   "Send" or ⌘↵).
 * - Select area: draw a lasso on the image, then "Erase" or "Isolate".
 * - Expand: drag the blue handles, an aspect ratio dropdown, the blue check.
 * - Vectorize: "Full color" / "Grayscale" / "Black and white" with its setting, a live preview, ✓ / ✕.
 * A run shows its sweep over the layers and "Cancel"; a model's first download asks first, with its size.
 * Several selected images: Remove background and Boost resolution work on all of them (one step).
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button, ContextMenu, Dialog, IconButton, SegmentedControl, Select, Spinner, TextArea, Toolbar, ToolbarDivider, ToolTextButton } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { AiRoute, AiSettings } from "../../../../shared/ai/types";
import { useEditor } from "../controller";
import { useTopics } from "../hooks";
import { useStoreSlice } from "../uiStore";
import type { EditorController } from "../controller";
import { editorAi, imageToolsOf, type ImageTools } from "./controller";
import { registerAiImageRow } from "../ai/actionRows";
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

/** The image providers for the model dropdown (Settings › AI's keys decide which are offered). */
function routeOptions(s: AiSettings | null) {
  const out = [{ value: "antigravity", label: "Antigravity (Google AI)" }];
  if (s?.imageKeys.openai) out.push({ value: "openai-images", label: "OpenAI Images" });
  if (s?.imageKeys.gemini) out.push({ value: "gemini-images", label: "Gemini API" });
  return out;
}

function PromptCard({ tools, kind }: { tools: ImageTools; kind: "make" | "edit" }) {
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<{ image: Rgba; url: string } | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
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
  }, [kind]);
  const takeFile = async (f: File | null | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    const image = await decodeImage(new Uint8Array(await f.arrayBuffer())).catch(() => null);
    if (image) setReference({ image, url: URL.createObjectURL(f) });
  };
  const send = (value = prompt) => {
    const text = value.trim();
    if (!text || busy) return;
    const r: AiRoute | undefined = route ? { providerId: route } : undefined;
    const o = { ...(reference ? { reference: reference.image } : {}), ...(r ? { route: r } : {}) };
    void (kind === "make" ? tools.makeImage(text, { ...o, target: tools.state.get().target }) : tools.editWithPrompt(text, o));
  };
  return (
    <div
      className={styles.card}
      role="dialog"
      aria-label={kind === "make" ? "Make an image" : "Edit with prompt"}
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
        {kind === "make" ? "Make an image" : "Edit with prompt"}
        <IconButton icon="24.close.small" label="Close" onClick={() => tools.close()} />
      </div>
      <TextArea label="Prompt" value={prompt} placeholder={kind === "make" ? "Describe the image you want" : "Describe your edit"} minRows={2} maxRows={6} onChange={setPrompt} onCommit={(v) => send(v)} autoFocus />
      <div className={styles.cardFoot}>
        <IconButton icon="24.plus" label="Add a reference image" onClick={() => file.current?.click()} />
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void takeFile(e.currentTarget.files?.[0])} />
        {reference && (
          <span className={styles.reference} title="Reference image">
            <img src={reference.url} alt="Reference image" />
          </span>
        )}
        <span className={styles.spacer} />
        <Select label="Model" variant="ghost" value={route} options={routeOptions(settings)} onChange={setRoute} />
        <Button variant="primary" disabled={!prompt.trim() || busy} loading={busy} shortcut="⌘↵" onClick={() => send()}>
          Send
        </Button>
      </div>
    </div>
  );
}

function VectorizeControls({ tools }: { tools: ImageTools }) {
  const session = useStoreSlice(tools.state, (s) => s.vectorize);
  const [, setTick] = useState(0);
  useEffect(() => session?.subscribe(() => setTick((t) => t + 1)), [session]);
  if (!session)
    return (
      <span className={styles.busyLabel}>
        <Spinner size={16} />
        Vectorizing…
      </span>
    );
  const s = session.settings;
  const mode = VECTORIZE_MODES.find((m) => m.id === s.mode)!;
  return (
    <>
      <SegmentedControl label="Mode" tone="toolbar" value={s.mode} options={VECTORIZE_MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => session.set({ mode: v as VectorizeMode })} />
      <ToolbarDivider />
      <label className={styles.setting}>
        {mode.settingLabel}
        <input type="range" min={mode.min} max={mode.max} step={1} value={s[mode.setting]} aria-label={mode.settingLabel} onChange={(e) => session.set({ [mode.setting]: Number(e.currentTarget.value) })} />
        <span className={styles.value}>{s[mode.setting]}</span>
      </label>
      {session.stats?.exceeded && <span className={styles.stats}>Too detailed to preview</span>}
      <ToolbarDivider />
      <IconButton icon="24.check" label="Apply" onClick={() => tools.applyVectorize()} />
      <IconButton icon="24.close.small" label="Cancel" onClick={() => tools.cancelVectorize()} />
    </>
  );
}

function DownloadDialog({ tools }: { tools: ImageTools }) {
  const confirm = useStoreSlice(tools.state, (s) => s.confirm);
  if (!confirm) return null;
  const { info } = confirm;
  return (
    <Dialog
      title="Download AI model?"
      open
      onClose={() => tools.answerDownload(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => tools.answerDownload(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => tools.answerDownload(true)}>
            Download ({formatSize(info.bytes)})
          </Button>
        </>
      }
    >
      <p data-model-download={info.id}>
        {info.use} runs on this computer with {info.label} ({info.license}). It downloads once ({formatSize(info.bytes)}) and is kept for next time. You can remove it in Settings › AI.
      </p>
    </Dialog>
  );
}

/** The image toolbar, its overlays and dialogs; nothing when no image is selected and no tool is open. */
export function ImageToolbar() {
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
          {download && !busy?.progress ? `Downloading ${download.label}… ${Math.round(download.share * 100)}%` : (busy?.label ?? "Working…")}
        </span>
        <ToolbarDivider />
        <ToolTextButton label="Cancel" onSelect={() => tools.cancel()} />
      </>
    );
  } else if (mode === "select-area") {
    body = (
      <>
        <span className={styles.busyLabel}>{lasso ? "Area selected" : "Draw around an area"}</span>
        <ToolbarDivider />
        <ToolTextButton label="Erase" disabled={!lasso} onSelect={() => void tools.erase()} />
        <ToolTextButton label="Isolate" disabled={!lasso} onSelect={() => void tools.isolate()} />
        <ToolbarDivider />
        <IconButton icon="24.close.small" label="Close" onClick={() => tools.close()} />
      </>
    );
  } else if (mode === "expand") {
    const node = tools.targetImage()?.node;
    const grown = pad.left + pad.right + pad.top + pad.bottom > 0;
    body = (
      <>
        <Select
          label="Aspect ratio"
          variant="ghost"
          value={aspect}
          options={EXPAND_ASPECTS.map((a) => ({ value: a.value, label: a.label }))}
          onChange={(v) => tools.state.set({ aspect: v, pad: node?.size ? padForAspect(node.size, v) : pad })}
        />
        <ToolbarDivider />
        <IconButton icon="24.check" label="Expand" disabled={!grown} onClick={() => void tools.expand()} />
        <IconButton icon="24.close.small" label="Cancel" onClick={() => tools.close()} />
      </>
    );
  } else if (mode === "vectorize") {
    body = <VectorizeControls tools={tools} />;
  } else {
    body = (
      <>
        <ToolTextButton label="Edit with prompt" active={mode === "edit"} disabled={!one} onSelect={() => tools.open(mode === "edit" ? null : "edit")} />
        <ToolTextButton label="Remove background" onSelect={() => void tools.removeBackground()} />
        <ToolTextButton label="Select area" disabled={!one} onSelect={() => tools.open("select-area")} />
        <ToolbarDivider />
        <div ref={more} className={styles.row}>
          <ToolTextButton
            label="More"
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
            label="More image tools"
            width={189}
            entries={MORE.map((m) => ({ ...m, disabled: m.id !== "boost" && !one }))}
            ignore={more}
            onSelect={(id) => {
              setMenuAt(null);
              if (id === "expand") tools.open("expand");
              else if (id === "boost") void tools.boostResolution();
              else if (id === "vectorize") void tools.startVectorize();
            }}
            onClose={() => setMenuAt(null)}
          />
        )}
      </>
    );
  }
  return (
    <>
      <Toolbar floating secondary label="Image tools" data-image-toolbar={mode ?? ""}>
        {body}
      </Toolbar>
      {overlays}
    </>
  );
}
