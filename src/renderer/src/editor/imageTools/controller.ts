/**
 * One editor's image tools (docs/ai.md §4): the state the toolbar, the canvas overlays and the dialogs share — which
 * tool is open (the prompt card, Select area's lasso, Expand's handles, Vectorize's settings), a run in progress (the
 * placeholder sweep over its layers), the download confirmation — and the runs themselves, with errors as toasts in
 * readable form. The app's hooks: main's AI (`window.designer.ai`), Settings › AI and the ledger for the credits stop,
 * `store.ai.record` with the file's key.
 */
import type { Guid } from "@/engine/codec";
import { showToast } from "@/ds";
import { readableError } from "@shared/agents/errors";
import { AiRunError, type AiApi } from "../../../../shared/ai/api";
import { creditsFor, DEFAULT_AI_SETTINGS, type AiAction, type AiModelId, type AiModelInfo, type AiRoute } from "../../../../shared/ai/types";
import { getStoreClient } from "@/store";
import { loadAiBalance, openAiBalance, resetDate } from "@/settings/AiBalance";
import { aiMessage } from "../ai/messages";
import type { EditorController } from "../controller";
import { Store } from "../uiStore";
import type { Insets, Point, Rgba } from "./pixels";
import * as tools from "./tools";
import { VectorizeSession } from "./vectorize";

export type ImageToolMode = "edit" | "make" | "select-area" | "expand" | "vectorize";

export interface ImageToolsState {
  mode: ImageToolMode | null;
  /** The layer the open tool works on */
  target: Guid | null;
  /** A run in progress: its label and layers (the sweep), its share done */
  busy: { label: string; ids: Guid[]; progress?: number } | null;
  /** Asking before a model's first download */
  confirm: { info: AiModelInfo } | null;
  /** A model downloading (0…1) */
  download: { id: AiModelId; label: string; share: number } | null;
  /** Select area: the lasso in the layer's units */
  lasso: Point[];
  /** Expand: the growth in the layer's units, and the aspect ratio picked */
  pad: Insets;
  aspect: string;
  vectorize: VectorizeSession | null;
}

const NO_PAD: Insets = { left: 0, top: 0, right: 0, bottom: 0 };

const INITIAL: ImageToolsState = { mode: null, target: null, busy: null, confirm: null, download: null, lasso: [], pad: NO_PAD, aspect: "freeform", vectorize: null };

/** main's AI in the editor view (or a test's stand-in), null in a browser. */
export function editorAi(): AiApi | null {
  const w = globalThis as unknown as { designer?: { ai?: AiApi }; __designerAi?: AiApi };
  return w.designer?.ai ?? w.__designerAi ?? null;
}

/** The app's hooks: the credits stop as main applies it, the ledger, downloads after a confirmation. */
export function appHooks(ed: EditorController, state: Store<ImageToolsState>): tools.ToolHooks {
  const fileKey = (ed.source as { fileKey?: string }).fileKey ?? null;
  return {
    api: editorAi(),
    async checkCredits(action: AiAction) {
      const api = editorAi();
      const s = (await api?.settings().catch(() => null)) ?? DEFAULT_AI_SETTINGS;
      if (!s.enabled) throw new AiRunError("disabled", "AI is turned off in Settings › AI.");
      if (!s.stopAtLimit || creditsFor(action, { input: 1, output: 1, megapixels: 1, colors: 2 }) === 0) return;
      const view = await loadAiBalance(s.monthlyCredits).catch(() => null);
      if (view && view.balance.remaining <= 0) {
        const when = resetDate(view.balance.resetsAt);
        throw new AiRunError("over-limit", view.balance.allowance <= 0 ? `You don't have any AI credits this month. They reset on ${when}.` : `You've used all ${view.balance.allowance.toLocaleString("en-US")} AI credits for this month. They reset on ${when}.`);
      }
    },
    record(e) {
      try {
        void getStoreClient()
          .ai.record({ ...e, input: 0, output: 0, fileKey, orgId: null })
          .catch(() => {});
      } catch {
        /* no store here */
      }
    },
    confirmDownload(info) {
      return new Promise<boolean>((resolve) => {
        state.set({ confirm: { info } });
        pendingConfirm = (yes) => {
          pendingConfirm = null;
          state.set({ confirm: null, ...(yes ? { download: { id: info.id, label: info.label, share: 0 } } : {}) });
          resolve(yes);
        };
      });
    },
  };
}

/** Codes whose words come from a provider run: said in Figma's voice (messages.ts); the tools' own refusals keep theirs. */
const RUN_CODES = new Set(["signed-out", "rate-limited", "refused", "bad-output", "network", "timeout", "disabled", "over-limit", "too-large"]);

/** A failure as a toast (over-limit opens AI balance, as the actions do). */
export function showToolError(err: unknown): void {
  if (err instanceof AiRunError) {
    if (err.code === "cancelled") return;
    const message = RUN_CODES.has(err.code) ? aiMessage(err.code, err.message) : readableError(err.message);
    if (err.code === "over-limit") openAiBalance();
    showToast({ message, kind: "error", ...(err.code === "over-limit" ? { action: { label: "AI balance", onAction: openAiBalance } } : {}) });
    return;
  }
  showToast({ message: readableError(err instanceof Error ? err.message : String(err)), kind: "error" });
}

let pendingConfirm: ((yes: boolean) => void) | null = null;

export class ImageTools {
  readonly state = new Store<ImageToolsState>(INITIAL);
  hooks: tools.ToolHooks;
  io: tools.ImageIO;
  private abort: AbortController | null = null;
  private offModels: (() => void) | null = null;

  constructor(readonly ed: EditorController, o: { hooks?: tools.ToolHooks; io?: tools.ImageIO } = {}) {
    this.hooks = o.hooks ?? appHooks(ed, this.state);
    this.io = o.io ?? tools.browserImageIO(ed);
    this.offModels =
      this.hooks.api && "onModelState" in this.hooks.api
        ? (this.hooks.api as AiApi).onModelState((s) => {
            const d = this.state.get().download;
            if (!d || d.id !== s.id) return;
            if (s.state === "downloading") this.state.set({ download: { ...d, share: (s.received ?? 0) / Math.max(1, s.bytes) } });
            else this.state.set({ download: null });
          })
        : null;
  }

  get env(): tools.ToolEnv {
    return { ed: this.ed, io: this.io, hooks: this.hooks };
  }

  /** The download confirmation's answer (the dialog's buttons). */
  answerDownload(yes: boolean): void {
    pendingConfirm?.(yes);
  }

  /** Opens a tool on the selected image (closing any other; Vectorize's preview is cancelled). */
  open(mode: ImageToolMode | null, target: Guid | null = this.ed.selection[0] ?? null): void {
    const v = this.state.get().vectorize;
    if (v?.active && mode !== "vectorize") v.cancel();
    this.state.set({ mode, target, lasso: [], pad: NO_PAD, aspect: "freeform", ...(mode !== "vectorize" ? { vectorize: null } : {}) });
  }

  close(): void {
    this.open(null, null);
  }

  /** Stops the run in progress. */
  cancel(): void {
    this.abort?.abort();
  }

  get running(): boolean {
    return !!this.state.get().busy;
  }

  /** A run: the sweep over its layers while it works, errors as toasts. Resolves true when it finished. */
  async run(label: string, ids: Guid[], fn: (o: tools.RunOptions) => Promise<unknown>): Promise<boolean> {
    if (this.running) return false;
    const abort = new AbortController();
    this.abort = abort;
    this.state.set({ busy: { label, ids } });
    try {
      await fn({ signal: abort.signal, onProgress: (share) => this.state.set((s) => (s.busy ? { busy: { ...s.busy, progress: share } } : {})) });
      return true;
    } catch (err) {
      if (!abort.signal.aborted) showToolError(err);
      return false;
    } finally {
      this.abort = null;
      this.state.set({ busy: null, download: null });
    }
  }

  // ---- The toolbar's actions --------------------------------------------------------------------------------------

  removeBackground(): Promise<boolean> {
    const targets = tools.imageTargets(this.ed);
    return this.run("Removing background…", targets.map((t) => t.id), (o) => tools.removeBackground(this.env, targets, o));
  }

  boostResolution(): Promise<boolean> {
    const targets = tools.imageTargets(this.ed);
    return this.run("Boosting resolution…", targets.map((t) => t.id), (o) => tools.boostResolution(this.env, targets, o));
  }

  async editWithPrompt(prompt: string, o: { reference?: Rgba; route?: AiRoute } = {}): Promise<boolean> {
    const t = this.targetImage();
    if (!t) return false;
    const ok = await this.run("Editing image…", [t.id], (r) => tools.editWithPrompt(this.env, t, prompt, { ...r, ...o }));
    if (ok) this.close();
    return ok;
  }

  async makeImage(prompt: string, o: { reference?: Rgba; route?: AiRoute; target?: Guid | null } = {}): Promise<boolean> {
    const ids = o.target !== undefined ? (o.target ? [o.target] : []) : this.ed.selection.slice(0, 1);
    const ok = await this.run("Making an image…", ids, (r) => tools.makeImage(this.env, prompt, { ...r, ...o }));
    if (ok) this.close();
    return ok;
  }

  async erase(): Promise<boolean> {
    const t = this.targetImage();
    const lasso = this.state.get().lasso;
    if (!t || lasso.length < 3) return false;
    const ok = await this.run("Erasing…", [t.id], (o) => tools.eraseArea(this.env, t, lasso, o));
    if (ok) this.close();
    return ok;
  }

  async isolate(): Promise<boolean> {
    const t = this.targetImage();
    const lasso = this.state.get().lasso;
    if (!t || lasso.length < 3) return false;
    const ok = await this.run("Isolating…", [t.id], () => tools.isolateArea(this.env, t, lasso));
    if (ok) this.close();
    return ok;
  }

  async expand(prompt?: string): Promise<boolean> {
    const t = this.targetImage();
    const pad = this.state.get().pad;
    if (!t) return false;
    const ok = await this.run("Expanding…", [t.id], (o) => tools.expandImage(this.env, t, pad, { ...o, ...(prompt ? { prompt } : {}) }));
    if (ok) this.close();
    return ok;
  }

  async startVectorize(): Promise<boolean> {
    const t = this.targetImage();
    if (!t) return false;
    this.open("vectorize", t.id);
    try {
      const session = await VectorizeSession.begin(this.ed, this.hooks, t.id);
      this.state.set({ vectorize: session });
      return true;
    } catch (err) {
      this.close();
      showToolError(err);
      return false;
    }
  }

  applyVectorize(): Guid | null {
    const v = this.state.get().vectorize;
    const frame = v?.apply() ?? null;
    this.state.set({ vectorize: null, mode: null, target: null });
    return frame;
  }

  cancelVectorize(): void {
    this.state.get().vectorize?.cancel();
    this.state.set({ vectorize: null, mode: null, target: null });
  }

  /** The open tool's image layer (still an image). */
  targetImage(): tools.ImageTarget | null {
    const id = this.state.get().target ?? this.ed.selection[0] ?? null;
    return id ? tools.imageTargetOf(this.ed.engine.readNode(id)) : null;
  }

  dispose(): void {
    this.cancel();
    this.state.get().vectorize?.cancel();
    this.offModels?.();
  }
}

const byEditor = new WeakMap<EditorController, ImageTools>();

/** The editor's image tools (made on first use). */
export function imageToolsOf(ed: EditorController): ImageTools {
  let t = byEditor.get(ed);
  if (!t) {
    t = new ImageTools(ed);
    byEditor.set(ed, t);
  }
  return t;
}
