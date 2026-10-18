/**
 * One plugin run (docs/plugins.md §3.1): its VM (QuickJS, or the developer VM), the `figma` API's host functions, its
 * UI window, its events and its end. A run's writes are the user's own and one undo step labelled with the plugin's
 * name: each synchronous slice opens a run transaction (Engine.txnBeginRun) that later slices join, `commitUndo()`
 * starts a new step, and a slice waits while the user drags (it starts only when the engine is idle).
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { dismissToast, showToast } from "@/ds";
import { t } from "@/i18n";
import { Status } from "@/engine/abi";
import type { DevResourceRecord } from "@shared/devmode/types";
import type { PluginManifest } from "@shared/plugins/types";
import { allowedUrl, refusedMessage, uiCsp } from "@shared/plugins/network";
import type { EditorController } from "../controller";
import { refusalEnglish } from "../refusals";
import { ApiError, decodeValue, encodeValue, MIXED } from "./api/codec";
import { mustNode, readNode, ref, refOf, type ApiContext } from "./api/context";
import * as doc from "./api/document";
import * as draw from "./api/draw";
import * as measurements from "./api/measurements";
import { motionOps } from "./api/motion";
import { appendChildAt, childrenOf, descendants, getPluginData, getProp, getRelaunchData, insertChild, nodeCss, pageOf, pluginDataKeys, removeNode, reorderGridTracks, rescale, resize, setGridChildPosition, setPluginData, setProp, setRelaunchData, topLevelFrame } from "./api/nodes";
import type { PluginDesktop } from "./desktop";
import bridgeSource from "./runtime/bridge.js?raw";
import figmaSource from "./runtime/figma.js?raw";
import { centred, clampPosition, clampSize, savedPosition, savePosition, type PluginUiStore } from "./ui/store";
import { DevWorkerVm } from "./vm/devWorker";
import { QuickJsVm } from "./vm/quickjs";
import { VmError, type PluginVm, type VmOptions } from "./vm/types";

export interface RunSpec {
  pluginId: string;
  name: string;
  manifest: PluginManifest;
  code: string;
  /** "" = the manifest's single ui file; else the `ui` map's keys */
  ui: Record<string, string>;
  development: boolean;
  command: string;
  parameters?: Record<string, unknown>;
  mode?: "default" | "inspect" | "codegen";
  editorType?: "figma" | "dev";
  developerVm?: boolean;
  /** The Actions panel collects the manifest's parameters first: `run` waits for submitParameters (Figma's order). */
  awaitParameters?: boolean;
}

/** What a run needs around it (the service gives the real ones; tests give fakes). */
export interface RunEnv {
  ed: EditorController;
  desktop: PluginDesktop | null;
  ui: PluginUiStore;
  /** The console of the person developing (development plugins); default: the view's console */
  console?(level: string, args: string[]): void;
  currentUser?(): { id: string | null; name: string; photoUrl: string | null } | null;
  saveVersion?(title: string, description: string): Promise<unknown>;
  openExternal?(url: string): void;
  /** Dev Mode's dev resources of this file (the store's repository, devmode/round5.ts); null: none (no file key) */
  devResources?: DevResourcesAccess | null;
  /** A VM factory (tests); default: QuickJS, or the developer VM */
  createVm?(options: VmOptions, developer: boolean): Promise<PluginVm>;
  /** Called once when the run has ended */
  onEnd?(run: PluginRun): void;
  /** One synchronous slice's limit (the main thread can't take Stop while plugin code runs); default 20 s */
  sliceTimeoutMs?: number;
}

/** What a run reads and writes of the file's dev resources (Figma's node.get / add / edit / deleteDevResourceAsync). */
export interface DevResourcesAccess {
  list(nodeIds: string[]): Promise<DevResourceRecord[]>;
  add?(nodeId: string, input: { name: string; url: string }): Promise<DevResourceRecord>;
  edit?(id: string, patch: { name?: string; url?: string }): Promise<DevResourceRecord>;
  remove?(id: string): Promise<void>;
}

type Op = (...args: unknown[]) => unknown;
type Obj = Record<string, unknown>;

let runSeq = 0;
const IDLE_POLL_MS = 30;
/**
 * QuickJS runs on the editor's main thread, so nothing — not Stop — can be clicked while a slice runs: a slice past
 * this is interrupted (the run then ends with "took too long"). Stop ends runs between slices (timers, the UI).
 */
const SLICE_TIMEOUT_MS = 20_000;
/** Figma's close handlers get a moment (ours: 500 ms) before the VM goes. */
const CLOSE_GRACE_MS = 500;
/** figma.notify's default time on screen, and the least it is given (Figma's ShowVisualBellOptions) */
const NOTIFY_TIMEOUT_MS = 3000;
const NOTIFY_MIN_TIMEOUT_MS = 100;
/** Figma's plugin api versions (`Unknown plugin api version "<v>"` otherwise) */
const API_VERSIONS = ["0.6.0", "1.0.0"];

export class PluginRun {
  readonly runId: string;
  readonly spec: RunSpec;
  private vm: PluginVm | null = null;
  private state: "starting" | "running" | "closing" | "closed" = "starting";
  private txnOpen = false;
  private joinNext = false;
  private asyncSeq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private timerSeq = 0;
  private readonly listening = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private pendingChanges: Obj[] = [];
  /** node → the page it was last seen on (nodechange's removed nodes) */
  private readonly seenOn = new Map<string, string>();
  private flushScheduled = false;
  private uiOpen = false;
  private uiQueue: unknown[] = [];
  private uiLoaded = false;
  private notices = new Map<number, { toast: number; timer: ReturnType<typeof setTimeout> | null }>();
  private noticeSeq = 0;
  private readonly flags = { skipInvisibleInstanceChildren: false };
  private codegenAnswers = new Map<number, (v: { result: unknown; error: string | null }) => void>();
  private parameterAnswers = new Map<number, (v: { suggestions?: unknown; error?: string; loading?: string }) => void>();
  readonly ended: Promise<void>;
  private resolveEnded!: () => void;
  /** The message closePlugin(message) gave (shown as a toast) */
  closeMessage: string | null = null;
  readonly ctx: ApiContext;

  constructor(
    spec: RunSpec,
    private readonly env: RunEnv
  ) {
    this.spec = spec;
    // The host of plugin://<runId>/: lower case, [a-z0-9][a-z0-9-]{0,62} (main's RUN_ID).
    this.runId = `run-${Date.now().toString(36)}-${++runSeq}`.toLowerCase();
    this.ended = new Promise((r) => (this.resolveEnded = r));
    const write = () => this.write();
    this.ctx = {
      ed: env.ed,
      pluginId: spec.pluginId,
      name: spec.name,
      manifest: spec.manifest,
      development: spec.development,
      mode: spec.mode ?? "default",
      editorType: spec.editorType ?? "figma",
      dynamicPage: spec.manifest.documentAccess === "dynamic-page",
      flags: this.flags,
      write,
    };
  }

  get running(): boolean {
    return this.state === "starting" || this.state === "running";
  }

  private ended_(): boolean {
    return this.state === "closed";
  }

  get hasUi(): boolean {
    return this.uiOpen;
  }

  // ---- The run's write slice and undo step ---------------------------------------------------------------------------

  private write(): void {
    if (this.state === "closed") throw new ApiError("The plugin has been closed");
    if (this.txnOpen) return;
    const engine = this.env.ed.engine;
    const status = engine.txnBeginRun(this.spec.name, this.joinNext);
    if (status === Status.E_BUSY) throw new ApiError("The document is busy (an edit is in progress); try again when it ends");
    if (status === Status.E_READONLY) throw new ApiError("This file is view-only");
    if (status !== Status.OK) throw new ApiError(`The document can't be written now (status ${status})`);
    this.txnOpen = true;
    this.joinNext = true;
    queueMicrotask(() => this.commit());
  }

  private commit(): void {
    if (!this.txnOpen) return;
    this.txnOpen = false;
    if (!this.env.ed.engine.destroyed) this.env.ed.engine.txnCommit();
  }

  /** Resolves when nothing is open in the engine (a drag, a scrub, an actor's write): a slice may start. */
  private waitIdle(): Promise<void> {
    const engine = this.env.ed.engine;
    if (engine.destroyed || this.txnOpen || engine.idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => (engine.destroyed || !this.running || engine.idle() ? resolve() : setTimeout(tick, IDLE_POLL_MS));
      setTimeout(tick, IDLE_POLL_MS);
    });
  }

  /** Enters the VM: waits for the engine, runs, commits the slice; errors go to the console (and end a starting run). */
  private async enter(fn: string, ...args: (string | number)[]): Promise<string> {
    if (!this.vm || this.state === "closed") return "";
    await this.waitIdle();
    if (!this.vm || this.ended_()) return "";
    try {
      return await this.vm.call(fn, ...args);
    } catch (e) {
      this.reportError(e);
      return "";
    } finally {
      this.commit();
    }
  }

  private reportError(e: unknown): void {
    if (e instanceof VmError && /took too long/.test(e.message) && this.state !== "closed") {
      showToast({ message: t("{name} took too long and was stopped", { name: this.spec.name }), kind: "error" });
      queueMicrotask(() => void this.end());
    }
    const msg = e instanceof VmError ? (e.vmStack ? `${e.message}\n${e.vmStack}` : e.message) : e instanceof Error ? e.message : String(e);
    if (e instanceof VmError && /was (stopped|closed)/.test(e.message)) return;
    this.log("error", [msg]);
    if (!this.spec.development) return;
    showToast({ message: `${this.spec.name}: ${firstLine(msg)}`, kind: "error" });
  }

  private log(level: string, args: string[]): void {
    if (this.env.console) return this.env.console(level, args);
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    out(`[${this.spec.name}]`, ...args);
  }

  // ---- Starting ------------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    const options: VmOptions = {
      host: (op, json) => this.hostCall(op, json),
      onError: (e) => this.reportError(e),
      memoryMb: 256,
      stackKb: 1024,
      sliceTimeoutMs: this.env.sliceTimeoutMs ?? SLICE_TIMEOUT_MS,
    };
    const developer = !!this.spec.developerVm && this.spec.development;
    try {
      this.vm = this.env.createVm ? await this.env.createVm(options, developer) : developer ? DevWorkerVm.create(options) : await QuickJsVm.create(options);
      await this.vm.evaluate(bridgeSource, "bridge.js");
      await this.vm.evaluate(figmaSource, "figma.js");
    } catch (e) {
      this.reportError(e);
      await this.end();
      throw e;
    }
    this.attachEvents();
    // Main checks this run's fetches against its manifest (plugins:begin-run, docs/plugins.md §3.4).
    const access = this.spec.manifest.networkAccess;
    await this.env.desktop?.beginRun({ runId: this.runId, allowedDomains: access?.allowedDomains ?? ["none"], ...(access?.devAllowedDomains ? { devAllowedDomains: access.devAllowedDomains } : {}), dev: this.spec.development }).catch((e: unknown) => this.log("warn", [`plugins:begin-run failed: ${e instanceof Error ? e.message : String(e)}`]));
    this.env.ui.stoppers.set(this.runId, () => this.stop());
    if (!this.spec.awaitParameters && !this.headless()) this.env.ui.setRunning(this.runId, this.runningName(), true);
    await this.waitIdle();
    try {
      const refused = codeRefusal(this.spec);
      if (refused) throw refused;
      await this.vm.evaluate(this.spec.code, this.spec.manifest.main || "code.js");
    } catch (e) {
      this.commit();
      this.reportError(e);
      showToast({ message: t("{name} failed: {error}", { name: this.spec.name, error: firstLine(e instanceof Error ? e.message : String(e)) }), kind: "error" });
      await this.close(null);
      return;
    }
    this.commit();
    if (this.state === "starting") this.state = "running";
    if (!this.spec.awaitParameters && this.listening.has("run")) await this.enter("__dispatch", "run", encodeValue({ command: this.spec.command, parameters: this.spec.parameters }));
    this.updateRunning();
  }

  /** The parameters the person gave (Enter in the Actions panel): figma.on("run") gets them. */
  async submitParameters(parameters: Record<string, unknown>): Promise<void> {
    Object.assign(this.spec, { parameters, awaitParameters: false });
    this.updateRunning();
    if (this.listening.has("run")) await this.enter("__dispatch", "run", encodeValue({ command: this.spec.command, parameters }));
  }

  // ---- Events ------------------------------------------------------------------------------------------------------

  private attachEvents(): void {
    const engine = this.env.ed.engine;
    this.offs.push(
      engine.on("SELECTION_CHANGED", () => this.listening.has("selectionchange") && this.later("selectionchange")),
      engine.on("CURRENT_PAGE_CHANGED", () => this.listening.has("currentpagechange") && this.later("currentpagechange")),
      engine.onDocumentChanged((changes, e) => {
        if (!this.listening.has("documentchange") && !this.listening.has("nodechange")) return;
        this.collect(changes, e.kind);
      })
    );
  }

  private later(type: string): void {
    setTimeout(() => void this.enter("__dispatch", type, ""), 0);
  }

  private collect(changes: readonly NodeChange[], kind: string): void {
    const origin = kind === "SYSTEM" ? "REMOTE" : "LOCAL";
    for (const c of changes) {
      const id = c.guid; // "s:l" on either wire (Engine.onDocumentChanged)
      if (c.phase === "CREATED") this.pendingChanges.push({ type: "CREATE", id, origin, node: refOf(this.ctx, id) });
      else if (c.phase === "REMOVED") this.pendingChanges.push({ type: "DELETE", id, origin, node: { id, removed: true } });
      else {
        const properties = Object.keys(c).filter((k) => k !== "guid" && k !== "phase").map(apiProperty);
        this.pendingChanges.push({ type: "PROPERTY_CHANGE", id, origin, node: refOf(this.ctx, id), properties: [...new Set(properties)] });
      }
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const documentChanges = this.pendingChanges;
      this.pendingChanges = [];
      if (!documentChanges.length) return;
      if (this.listening.has("documentchange")) void this.enter("__dispatch", "documentchange", encodeValue({ documentChanges }));
      if (this.listening.has("nodechange")) for (const [pageId, nodeChanges] of this.byPage(documentChanges)) void this.enter("__dispatch", "nodechange", encodeValue({ pageId, nodeChanges }));
    }, 0);
  }

  /**
   * PageNode.on("nodechange"): the changes grouped by page (Figma's). A removed node's page is the one it was last seen
   * on (its node is gone from the document), else the current page.
   */
  private byPage(changes: Obj[]): Map<string, Obj[]> {
    const out = new Map<string, Obj[]>();
    for (const c of changes) {
      const id = String(c.id);
      const page = c.type === "DELETE" ? (this.seenOn.get(id) ?? this.env.ed.store.page) : (pageOf(this.ctx, id) ?? this.env.ed.store.page);
      if (c.type === "DELETE") this.seenOn.delete(id);
      else this.seenOn.set(id, page);
      out.set(page, [...(out.get(page) ?? []), c]);
    }
    return out;
  }

  // ---- The UI ------------------------------------------------------------------------------------------------------

  /**
   * figma.showUI (docs/research/atlas/17-plugins.md §3.3): 300 × 200 by default, clamped to the window; placed where
   * `position` says (canvas coordinates, or `{windowSpace: true, x, y}`), else where this plugin's window was last left
   * (clamped), else centred.
   */
  private openUi(html: string, opts: Obj): void {
    if (this.uiOpen) throw new ApiError("showUI can only be called once per plugin run");
    const dimension = (name: "width" | "height", fallback: number) => {
      const v = opts[name];
      if (v === undefined || v === null) return fallback;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ApiError(`in showUI: Expected "${name}" to be an integer greater than or equal to 0`);
      return v;
    };
    const size = clampSize(dimension("width", 300), dimension("height", 200));
    const position = this.uiPosition(opts.position, size);
    this.uiOpen = true;
    const themed = opts.themeColors === true ? themeHtml(html) : html;
    this.env.ui.putWindow({
      runId: this.runId,
      pluginId: this.spec.pluginId,
      name: this.spec.name,
      title: typeof opts.title === "string" ? opts.title : this.spec.name,
      src: null,
      visible: opts.visible !== false,
      ...size,
      position,
      // Dev Mode's inspect plugins show their UI in the Plugins panel (docs/plugins.md §7)
      ...(this.spec.mode === "inspect" ? { docked: true } : {}),
    });
    this.env.ui.handlers.set(this.runId, {
      message: (data, origin) => void this.enter("__uiMessage", encodeValue({ message: data, props: { origin } })),
      drop: (data, at) => void this.drop(data, at),
      close: () => void this.close(null),
      stop: () => this.stop(),
      loaded: () => {
        this.uiLoaded = true;
        const queued = this.uiQueue;
        this.uiQueue = [];
        for (const m of queued) this.env.ui.frames.get(this.runId)?.post(m);
      },
    });
    const access = this.spec.manifest.networkAccess;
    const desktop = this.env.desktop;
    if (desktop) {
      desktop
        .openUi({ runId: this.runId, html: themed, allowedDomains: access?.allowedDomains ?? ["none"], ...(access?.devAllowedDomains ? { devAllowedDomains: access.devAllowedDomains } : {}), dev: this.spec.development })
        .then(({ url }) => this.uiOpen && this.env.ui.patchWindow(this.runId, { src: { url } }))
        .catch((e) => {
          // No plugin: scheme (main not built yet): the browser's way.
          this.log("warn", [`plugins:open-ui failed (${e instanceof Error ? e.message : String(e)}); using srcdoc`]);
          this.env.ui.patchWindow(this.runId, { src: { srcdoc: withCsp(themed, uiCsp(access, { development: this.spec.development })) } });
        });
    } else this.env.ui.patchWindow(this.runId, { src: { srcdoc: withCsp(themed, uiCsp(access, { development: this.spec.development })) } });
    this.updateRunning();
  }

  /** showUI's `position`: canvas coordinates, `{windowSpace: true, x, y}`, or none — this plugin's last place, else centred. */
  private uiPosition(v: unknown, size: { width: number; height: number }): { x: number; y: number } {
    const p = v as { x?: unknown; y?: unknown; windowSpace?: unknown } | null | undefined;
    if (p && typeof p === "object") {
      if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new ApiError('in showUI: Expected "position" to be {x, y} with finite numbers');
      return p.windowSpace === true ? { x: Math.round(p.x), y: Math.round(p.y) } : canvasToView(this.env.ed, { x: p.x, y: p.y });
    }
    const last = savedPosition(this.spec.pluginId);
    return last ? clampPosition(last, size) : centred(size);
  }

  /** Figma's text when a UI call comes before showUI. */
  private needUi(what: string): void {
    if (!this.uiOpen) throw new ApiError(`${what} Did you forget to create a UI by calling showUI?`);
  }

  private postToUi(message: unknown): void {
    this.needUi("No UI to send a message to.");
    const data = { pluginMessage: structuredClone(message), pluginId: this.spec.pluginId };
    if (this.uiLoaded && this.env.ui.frames.get(this.runId)) this.env.ui.frames.get(this.runId)!.post(data);
    else this.uiQueue.push(data);
  }

  private closeUi(): void {
    if (!this.uiOpen) return;
    this.uiOpen = false;
    this.uiLoaded = false;
    this.uiQueue = [];
    this.env.ui.removeWindow(this.runId);
    this.env.ui.handlers.delete(this.runId);
    void this.env.desktop?.closeUi(this.runId).catch(() => {});
    this.updateRunning();
  }

  private updateRunning(): void {
    const w = this.env.ui.window(this.runId);
    // Figma: the "Running ‹name›" toast while a run is open and its UI is hidden or absent.
    this.env.ui.setRunning(this.runId, this.runningName(), this.running && !this.spec.awaitParameters && !this.headless() && (!w || !w.visible));
  }

  /** The name in the "Running ‹name›" toast: Figma adds " (Developer VM)" for a run in the developer VM. */
  private runningName(): string {
    return this.spec.developerVm && this.spec.development ? `${this.spec.name} (Developer VM)` : this.spec.name;
  }

  /** Codegen runs headless and inspect runs live in Dev Mode's Plugins panel: no "Running" toast (docs/plugins.md §7). */
  private headless(): boolean {
    return this.spec.mode === "codegen" || this.spec.mode === "inspect";
  }

  private async drop(data: unknown, at: { x: number; y: number }): Promise<void> {
    const d = (data ?? {}) as Obj;
    const world = this.env.ed.engine.screenToWorld(at.x, at.y);
    const node = this.env.ed.engine.hitTest(at.x, at.y)[0] ?? null;
    await this.enter("__dispatch", "drop", encodeValue({ node: refOf(this.ctx, node) ?? refOf(this.ctx, this.env.ed.store.page), x: world.x, y: world.y, absoluteX: world.x, absoluteY: world.y, items: d.items ?? [], files: d.files ?? [], dropMetadata: d.dropMetadata }));
  }

  // ---- Ending ------------------------------------------------------------------------------------------------------

  /** figma.closePlugin, the window's ✕, or the file closing: `close` handlers, then the VM goes. */
  async close(message: string | null): Promise<void> {
    if (this.state === "closing" || this.state === "closed") return;
    this.state = "closing";
    // Called from inside the VM (closePlugin): the VM goes once the call that asked has returned.
    await Promise.resolve();
    this.closeMessage = message;
    if (message) showToast({ message });
    if (this.listening.has("close") && this.vm) {
      await Promise.race([this.enter("__dispatch", "close", ""), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
    }
    await this.end();
  }

  /** Stop plugin (the toast's ✕): ends a runaway loop at once. */
  stop(): void {
    if (this.state === "closed") return;
    this.vm?.interrupt();
    queueMicrotask(() => void this.end());
  }

  private async end(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.commit();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const n of this.notices.values()) if (n.timer) clearTimeout(n.timer);
    this.offs.splice(0).forEach((off) => off());
    this.closeUi();
    this.env.ui.setRunning(this.runId, this.runningName(), false, true);
    this.env.ui.stoppers.delete(this.runId);
    void this.env.desktop?.endRun(this.runId).catch(() => {});
    this.vm?.dispose();
    this.vm = null;
    for (const a of this.codegenAnswers.values()) a({ result: null, error: "The plugin was closed" });
    this.codegenAnswers.clear();
    this.env.onEnd?.(this);
    this.resolveEnded();
  }

  // ---- Codegen and parameters (Dev Mode, the Actions panel) ----------------------------------------------------------

  /** figma.codegen.on("generate"): the plugin's answer for a node, or its error (3 s, Figma's). */
  generate(node: Guid, language: string): Promise<{ result: unknown; error: string | null }> {
    const request = ++this.asyncSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.codegenAnswers.delete(request);
        resolve({ result: null, error: "Code generation timed out" });
      }, 3000);
      this.codegenAnswers.set(request, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      void this.enter("__codegen", request, encodeValue({ node: refOf(this.ctx, node), language }));
    });
  }

  /** figma.parameters.on("input"): the suggestions for one key as the person types. */
  parameterInput(key: string, query: string, parameters: Record<string, unknown>): Promise<{ suggestions?: unknown; error?: string; loading?: string }> {
    if (!this.running) return Promise.resolve({ error: "The plugin was closed" });
    const request = ++this.asyncSeq;
    return new Promise((resolve) => {
      this.parameterAnswers.set(request, (v) => {
        this.parameterAnswers.delete(request);
        resolve(v);
      });
      void this.enter("__parameterInput", encodeValue({ request, key, query, parameters }));
    });
  }

  // ---- The host functions ------------------------------------------------------------------------------------------

  private hostCall(op: string, json: string): string {
    const fn = this.ops[op];
    if (!fn) return JSON.stringify({ err: `Unknown host call ${op}` });
    let result: unknown;
    try {
      result = fn(...(decodeValue(json) as unknown[]));
    } catch (e) {
      return JSON.stringify({ err: e instanceof Error ? e.message : String(e) });
    }
    if (result instanceof Promise) {
      const id = ++this.asyncSeq;
      result.then(
        (v) => void this.enter("__settle", id, encodeValue({ ok: v === undefined ? null : v })),
        (e) => void this.enter("__settle", id, JSON.stringify({ err: e instanceof Error ? e.message : String(e) }))
      );
      return JSON.stringify({ async: id });
    }
    return encodeValue({ ok: result === undefined ? null : result });
  }

  private readonly ops: Record<string, Op> = this.makeOps();

  private makeOps(): Record<string, Op> {
    const ctx = () => this.ctx;
    const s = (v: unknown) => String(v ?? "");
    const n = (v: unknown) => Number(v);
    const node = (id: unknown) => refOf(ctx(), s(id));
    const permission = (p: string) => {
      if (!(this.spec.manifest.permissions ?? []).includes(p as never)) throw new ApiError(`"${p}" permission not specified in manifest.json`);
    };
    return {
      init: () => ({
        apiVersion: "1.0.0",
        command: this.spec.command,
        pluginId: this.spec.pluginId,
        editorType: this.spec.editorType ?? "figma",
        mode: this.spec.mode ?? "default",
        dynamicPage: this.ctx.dynamicPage,
        ...(this.spec.manifest.enablePrivatePluginApi ? { fileKey: (this.env.ed.source as { fileKey?: string }).fileKey ?? "" } : {}),
        ...(this.spec.ui[""] !== undefined ? { html: this.spec.ui[""] } : {}),
        ...(Object.keys(this.spec.ui).some((k) => k) ? { uiFiles: Object.fromEntries(Object.entries(this.spec.ui).filter(([k]) => k)) } : {}),
      }),
      // Nodes
      get: (id, name) => getProp(ctx(), s(id), s(name)),
      set: (id, name, value) => setProp(ctx(), s(id), s(name), value),
      "node.byId": (id) => node(id),
      "node.remove": (id) => removeNode(ctx(), s(id)),
      "node.insert": (parent, child, index) => insertChild(ctx(), s(parent), child, n(index)),
      "node.descendants": (id, criteria) => descendants(ctx(), s(id), (criteria as Obj | null) ?? null),
      "node.resize": (id, w, h, constraints) => resize(ctx(), s(id), w, h, !!constraints),
      "node.rescale": (id, k) => rescale(ctx(), s(id), k),
      "node.clone": (id) => {
        if (s(id) === "0:0") throw new ApiError("in clone: The document can't be cloned");
        return doc.cloneNode(ctx(), s(id));
      },
      "node.css": (id) => Promise.resolve(nodeCss(ctx(), s(id))),
      "node.topLevelFrame": (id) => topLevelFrame(ctx(), s(id)),
      "node.export": (id, settings) => doc.exportNode(ctx(), s(id), settings),
      "node.outlineStroke": (id) => {
        const [made] = [doc.flatten(ctx(), [s(id)], null, -1)];
        return made;
      },
      // Grids (docs/research/atlas/09-layout.md): an item's cell, a child appended at a cell, tracks reordered
      "node.gridPosition": (id, row, column) => setGridChildPosition(ctx(), s(id), row, column),
      "node.appendChildAt": (id, child, row, column) => appendChildAt(ctx(), s(id), child, row, column),
      "node.reorderTracks": (id, axis, from, to) => reorderGridTracks(ctx(), s(id), axis === "rows" ? "rows" : "columns", from, to),
      // Dev Mode's dev resources (the store's links per layer) and saved measurements (the page's)
      "devResources.get": (id, children) => this.devResources(s(id), !!children),
      "devResources.add": (id, url, name) => this.addDevResource(s(id), s(url), name === null ? null : s(name)),
      "devResources.edit": (id, url, value) => this.editDevResource(s(id), s(url), (value ?? {}) as Obj),
      "devResources.delete": (id, url) => this.deleteDevResource(s(id), s(url)),
      "measurements.list": (page, node) => measurements.list(ctx(), s(page), node === null ? null : s(node)),
      "measurements.add": (page, start, end, options) => measurements.add(ctx(), s(page), start, end, (options ?? {}) as Obj),
      "measurements.edit": (page, id, value) => measurements.edit(ctx(), s(page), s(id), (value ?? {}) as Obj),
      "measurements.delete": (page, id) => measurements.remove(ctx(), s(page), s(id)),
      "pluginData.get": (id, ns, key) => getPluginData(ctx(), s(id), ns === null ? null : s(ns), s(key)),
      "pluginData.set": (id, ns, key, value) => setPluginData(ctx(), s(id), ns === null ? null : s(ns), s(key), s(value)),
      "pluginData.keys": (id, ns) => pluginDataKeys(ctx(), s(id), ns === null ? null : s(ns)),
      "relaunch.set": (id, data) => setRelaunchData(ctx(), s(id), data),
      "relaunch.get": (id) => getRelaunchData(ctx(), s(id)),
      // Components and instances
      "component.createInstance": (id) => doc.createInstance(ctx(), s(id)),
      "component.instances": (id) => Promise.resolve(descendants(ctx(), "0:0", { types: ["INSTANCE"] }).filter((r) => (getProp(ctx(), (r as { $node: string }).$node, "mainComponent") as { $node?: string } | null)?.$node === s(id))),
      "component.addProperty": (id, name, type, value) => {
        ctx().write();
        // `plugin`: a Variant property on a loose component throws (Figma's API); the UI makes the component a set.
        const r = this.env.ed.engine.runCommand("ADD_COMPONENT_PROPERTY", { ref: s(id), name: s(name), type: s(type), defaultValue: value as never, plugin: true });
        if (r.status !== Status.OK) throw new ApiError(r.error ? refusalEnglish(r.error) : `addComponentProperty: refused (status ${r.status})`);
        const info = this.env.ed.engine.componentInfo(s(id));
        const p = info?.properties.find((x) => x.name === s(name));
        return p ? (p.type === "VARIANT" ? p.name : `${p.name}#${p.id}`) : s(name);
      },
      "component.editProperty": (id, name, values) => {
        ctx().write();
        const prop = s(name).split("#")[1] ?? s(name);
        const v = (values ?? {}) as Obj;
        const args: Record<string, never> = { ref: s(id), prop } as never;
        if (v.name !== undefined) (args as Obj).name = s(v.name);
        if (v.defaultValue !== undefined) (args as Obj).defaultValue = v.defaultValue;
        const r = this.env.ed.engine.runCommand("EDIT_COMPONENT_PROPERTY", args);
        if (r.status !== Status.OK) throw new ApiError(r.error ? refusalEnglish(r.error) : `editComponentProperty: refused (status ${r.status})`);
        return name;
      },
      "component.deleteProperty": (id, name) => {
        ctx().write();
        const prop = s(name).split("#")[1] ?? s(name);
        this.env.ed.engine.runCommand("DELETE_COMPONENT_PROPERTY", { ref: s(id), prop });
      },
      "instance.main": (id) => getProp(ctx(), s(id), "mainComponent"),
      "instance.swap": (id, main) => {
        ctx().write();
        const r = this.env.ed.engine.runCommand("SWAP_INSTANCE", { ref: s(id), main: s(main) });
        if (r.status !== Status.OK) throw new ApiError(r.error ? refusalEnglish(r.error) : `swapComponent: refused (status ${r.status})`);
      },
      "instance.setProperties": (id, values) => {
        const info = this.env.ed.engine.componentInfo(s(id));
        ctx().write();
        for (const [k, v] of Object.entries((values ?? {}) as Obj)) {
          const key = k.split("#");
          const def = info?.properties.find((p) => p.id === key[1] || p.name === key[0]);
          if (!def) throw new ApiError(`Could not find a component property with name: '${k}'`);
          const r = this.env.ed.engine.runCommand("SET_COMPONENT_PROPERTY", { ref: s(id), prop: def.id, value: v as never });
          if (r.status !== Status.OK) throw new ApiError(r.error ? refusalEnglish(r.error) : `setProperties: ${k} = ${JSON.stringify(v)} was refused`);
        }
      },
      "instance.detach": (id) => {
        ctx().write();
        const r = this.env.ed.engine.runCommand("DETACH_INSTANCE", { ref: s(id) });
        const made = r.created[0] ?? s(id);
        return node(readNode(ctx(), made, false) ? made : s(id));
      },
      "instance.reset": (id) => {
        // removeOverrides() and its deprecated alias resetOverrides(): Figma's resetOverrides(ALL) — every override goes,
        // the instance's property values stay (live-verified, docs/research/rea/components.md §2.13).
        ctx().write();
        this.env.ed.engine.runCommand("RESET_OVERRIDES", { ref: s(id), kind: "ALL", keepAssignments: true });
      },
      // Text
      "text.getRange": (id, field, a, b) => doc.getRange(ctx(), s(id), s(field), a, b),
      "text.setRange": (id, field, a, b, v) => doc.setRange(ctx(), s(id), s(field), a, b, v),
      "text.insert": (id, at, chars) => doc.insertCharacters(ctx(), s(id), n(at), s(chars)),
      "text.delete": (id, a, b) => doc.deleteCharacters(ctx(), s(id), n(a), n(b)),
      "text.segments": (id, fields, a, b) => doc.styledSegments(ctx(), s(id), fields, n(a), n(b)),
      "text.allFontNames": (id, a, b) => doc.allFontNames(ctx(), s(id), n(a), n(b)),
      "text.useNativeBidi": (id) => doc.useNativeBidi(ctx(), s(id)),
      // The document
      root: () => ({ $node: "0:0", $type: "DOCUMENT" }),
      "page.current": () => node(this.env.ed.store.page),
      "page.set": (page) => doc.setPage(ctx(), page),
      create: (type) => doc.create(ctx(), s(type)),
      createComponentFromNode: (id) => doc.createComponentFromNode(ctx(), id),
      createNodeFromSvg: (svg) => doc.createNodeFromSvg(ctx(), s(svg)),
      combineAsVariants: (nodes, parent, index) => doc.combineAsVariants(ctx(), nodes, parent, n(index)),
      group: (nodes, parent, index) => doc.group(ctx(), nodes, parent, n(index)),
      ungroup: (id) => doc.ungroup(ctx(), id),
      flatten: (nodes, parent, index) => doc.flatten(ctx(), nodes, parent, n(index)),
      boolean: (op, nodes, parent, index) => doc.booleanOp(ctx(), s(op), nodes, parent, n(index)),
      // Draw (docs/draw.md §7)
      createTextPath: (id, segment, position) => draw.createTextPath(ctx(), id, segment, position),
      transformGroup: (nodes, parent, index, modifiers) => draw.transformGroup(ctx(), nodes, parent, n(index), modifiers),
      "brushes.load": (type) => Promise.resolve().then(() => draw.loadBrushes(ctx(), type)),
      // Motion (docs/motion.md §9)
      ...motionOps(ctx),
      "selection.colors": () => doc.selectionColors(ctx()),
      "viewport.get": () => doc.viewport(ctx()),
      "viewport.set": (v) => doc.setViewport(ctx(), (v ?? {}) as Obj),
      "viewport.scrollTo": (nodes) => doc.scrollAndZoomIntoView(ctx(), nodes),
      "file.thumbnail": () => null,
      "file.setThumbnail": () => undefined,
      "flags.get": (k) => (this.flags as Obj)[s(k)],
      "flags.set": (k, v) => void ((this.flags as Obj)[s(k)] = v),
      "fonts.missing": () => false,
      "fonts.load": (font) => {
        const f = (font ?? {}) as Obj;
        if (typeof f.family !== "string" || typeof f.style !== "string") return Promise.reject(new ApiError("loadFontAsync: expected {family, style}"));
        return Promise.resolve(undefined);
      },
      "fonts.list": () => Promise.resolve(doc.availableFonts(ctx())),
      "users.current": () => {
        if (!(this.spec.manifest.permissions ?? []).includes("currentuser")) return null;
        const u = this.env.currentUser?.() ?? null;
        return u ? { id: u.id, name: u.name, photoUrl: u.photoUrl, color: "#0D99FF", sessionId: 0 } : null;
      },
      "users.active": () => {
        permission("activeusers");
        const u = this.env.currentUser?.() ?? null;
        return u ? [{ id: u.id, name: u.name, photoUrl: u.photoUrl, color: "#0D99FF", sessionId: 0, position: null, viewport: doc.viewport(ctx()).bounds, selection: this.env.ed.selection }] : [];
      },
      // Images
      "image.create": (bytes) => doc.createImage(ctx(), bytes),
      "image.byHash": (hash) => doc.imageByHash(ctx(), s(hash)),
      "image.bytes": (hash) => doc.imageBytes(ctx(), s(hash)),
      "image.size": (hash) => doc.imageSizeOf(ctx(), s(hash)),
      "image.fromUrl": (url) => this.fetch(s(url), null).then((r) => doc.createImage(ctx(), r.body)),
      // Styles and variables
      "styles.local": (type) => doc.localStyles(ctx(), s(type)),
      "styles.byId": (id) => doc.styleById(ctx(), s(id)),
      "styles.create": (type) => doc.createStyle(ctx(), s(type)),
      "styles.moveAfter": () => undefined,
      "style.get": (id, f) => doc.styleGet(ctx(), s(id), s(f)),
      "style.set": (id, f, v) => doc.styleSet(ctx(), s(id), s(f), v),
      "style.remove": (id) => {
        ctx().write();
        this.env.ed.engine.runCommand("DELETE_STYLE", { style: s(id) });
      },
      "variables.local": (type) => doc.localVariables(ctx(), type === null ? null : s(type)),
      "variables.subscribed": (type) => doc.subscribedVariables(ctx(), type === null ? null : s(type)),
      "variables.byId": (id) => (this.env.ed.engine.variable(s(id)) ? { id: s(id) } : null),
      "variables.create": (name, coll, type) => doc.createVariable(ctx(), s(name), coll, type),
      "variables.bind": (id, field, variable) => doc.bindVariable(ctx(), s(id), s(field), variable),
      "variables.setMode": (id, coll, mode) => doc.setVariableMode(ctx(), s(id), coll, mode),
      "variable.get": (id, f) => doc.variableGet(ctx(), s(id), s(f)),
      "variable.set": (id, f, v) => doc.variableSet(ctx(), s(id), s(f), v),
      "variable.setValue": (id, mode, v) => doc.variableSetValue(ctx(), s(id), s(mode), v),
      "variable.remove": (id) => {
        ctx().write();
        this.env.ed.engine.runCommand("DELETE_VARIABLES", { variables: [s(id)] });
      },
      "variable.codeSyntax": (id, platform, v) => {
        ctx().write();
        this.env.ed.engine.runCommand("SET_VARIABLE_CODE_SYNTAX", { variable: s(id), platform: s(platform), value: v === null ? "" : s(v) });
      },
      "variable.resolve": (id, consumer) => {
        const r = this.env.ed.engine.resolveVariable(s(id), s(consumer));
        return { value: r, resolvedType: this.env.ed.engine.variable(s(id))?.resolvedType ?? "FLOAT" };
      },
      "collections.local": () => doc.localCollections(ctx()),
      "collections.byId": (id) => (this.env.ed.engine.variableCollections().some((c) => c.id === s(id)) ? { id: s(id) } : null),
      "collections.create": (name) => doc.createCollection(ctx(), s(name)),
      "collection.get": (id, f) => doc.collectionGet(ctx(), s(id), s(f)),
      "collection.set": (id, f, v) => doc.collectionSet(ctx(), s(id), s(f), v),
      "collection.addMode": (id, name) => doc.collectionMode(ctx(), "add", s(id), name),
      "collection.renameMode": (id, mode, name) => doc.collectionMode(ctx(), "rename", s(id), mode, name),
      "collection.removeMode": (id, mode) => doc.collectionMode(ctx(), "remove", s(id), mode),
      "collection.remove": (id) => {
        ctx().write();
        this.env.ed.engine.runCommand("DELETE_VARIABLE_COLLECTION", { collection: s(id) });
      },
      "library.importStyle": () => Promise.reject(new ApiError("importStyleByKeyAsync is not supported in Wecra yet")),
      "library.importComponent": () => Promise.reject(new ApiError("importComponentByKeyAsync is not supported in Wecra yet")),
      "library.importVariable": () => Promise.reject(new ApiError("importVariableByKeyAsync is not supported in Wecra yet")),
      "library.collections": () => Promise.resolve([]),
      "library.variables": () => Promise.resolve([]),
      "annotations.categories": () => Promise.resolve([]),
      "annotations.addCategory": () => Promise.reject(new ApiError("addAnnotationCategoryAsync is not supported in Wecra yet")),
      // The run
      close: (message) => {
        this.commit();
        void this.close(message === null ? null : s(message));
      },
      notify: (message, options) => this.notify(s(message), (options ?? {}) as Obj),
      "notify.cancel": (id) => this.cancelNotice(n(id), "dismiss"),
      "undo.commit": () => {
        this.commit();
        this.joinNext = false;
      },
      "undo.trigger": () => {
        this.commit();
        this.joinNext = false;
        this.env.ed.engine.undo();
      },
      "version.save": (title, description) => (this.env.saveVersion ? this.env.saveVersion(s(title), s(description)).then(() => ({ id: String(Date.now()) })) : Promise.reject(new ApiError("Versions can't be saved for this file"))),
      openExternal: (url) => {
        const u = s(url);
        if (!/^https?:\/\//i.test(u)) throw new ApiError("openExternal: only http(s) links");
        if (this.env.openExternal) this.env.openExternal(u);
        else window.open(u, "_blank", "noopener");
      },
      console: (level, args) => this.log(s(level), Array.isArray(args) ? args.map(s) : []),
      "events.listen": (type, on) => void (on ? this.listening.add(s(type)) : this.listening.delete(s(type))),
      "timer.set": (ms, repeat) => {
        const id = ++this.timerSeq;
        const fire = () => {
          if (!repeat) this.timers.delete(id);
          else this.timers.set(id, setTimeout(fire, Math.max(4, n(ms))));
          void this.enter("__timer", id);
        };
        this.timers.set(id, setTimeout(fire, Math.max(0, n(ms))));
        return id;
      },
      "timer.clear": (id) => {
        clearTimeout(this.timers.get(n(id)));
        this.timers.delete(n(id));
      },
      // UI
      "ui.open": (html, opts) => this.openUi(s(html), (opts ?? {}) as Obj),
      "ui.show": () => {
        this.needUi("No UI to show.");
        this.env.ui.patchWindow(this.runId, { visible: true });
        this.updateRunning();
      },
      "ui.hide": () => {
        this.env.ui.patchWindow(this.runId, { visible: false });
        this.updateRunning();
      },
      "ui.resize": (w, h) => {
        this.needUi("No UI to resize.");
        if (![w, h].every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)) throw new ApiError("in resize: Expected width and height to be positive integers");
        this.env.ui.patchWindow(this.runId, clampSize(n(w), n(h)));
      },
      "ui.reposition": (x, y) => {
        this.needUi("No UI to reposition.");
        if (![x, y].every((v) => typeof v === "number" && Number.isFinite(v))) throw new ApiError("in reposition: Expected x and y to be finite numbers");
        const at = canvasToView(this.env.ed, { x: n(x), y: n(y) });
        this.env.ui.patchWindow(this.runId, { position: at });
        savePosition(this.spec.pluginId, at);
      },
      "ui.getPosition": () => {
        this.needUi("Cannot get the UI position.");
        const w = this.env.ui.window(this.runId);
        if (!w) throw new ApiError("Cannot get the UI position. Did you forget to create a UI by calling showUI?");
        const at = w.position ?? { x: 0, y: 0 };
        const world = this.env.ed.engine.screenToWorld(at.x, at.y);
        return { windowSpace: at, canvasSpace: world };
      },
      "ui.close": () => this.closeUi(),
      "ui.post": (message) => this.postToUi(message),
      // Network and storage (main)
      fetch: (url, init) => this.fetch(s(url), (init as Obj | null) ?? null),
      storage: (op, key, value) => this.storage(s(op) as "get" | "set" | "delete" | "keys", key === undefined ? undefined : s(key), value),
      // Codegen and parameters
      "codegen.answer": (request, result, error) => {
        const a = this.codegenAnswers.get(n(request));
        this.codegenAnswers.delete(n(request));
        a?.({ result, error: error === null ? null : s(error) });
      },
      "codegen.refresh": () => undefined,
      "parameters.suggest": (request, list) => this.parameterAnswers.get(n(request))?.({ suggestions: list }),
      "parameters.error": (request, message) => this.parameterAnswers.get(n(request))?.({ error: s(message) }),
      "parameters.loading": (request, message) => this.parameterAnswers.get(n(request))?.({ loading: s(message) }),
      // Kept for completeness: node handles for children read in bulk.
      "node.children": (id) => childrenOf(ctx(), readNode(ctx(), s(id))!).map(ref),
      mixed: () => MIXED,
    };
  }

  private async fetch(url: string, init: Obj | null): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: Uint8Array; url: string }> {
    const access = this.spec.manifest.networkAccess;
    if (!allowedUrl(access, url, { development: this.spec.development })) throw new ApiError(refusedMessage(url));
    const desktop = this.env.desktop;
    if (!desktop) throw new ApiError("Network access from plugin code needs the desktop app");
    const r = await desktop.fetch({ runId: this.runId, url, ...(init ? { init: { method: init.method ? String(init.method) : undefined, headers: (init.headers as Record<string, string>) ?? undefined, body: init.body as string | Uint8Array | undefined } } : {}) });
    return { ...r, url };
  }

  // ---- Dev resources ---------------------------------------------------------------------------------------------

  private devAccess(write: boolean): DevResourcesAccess {
    const access = this.env.devResources;
    if (!access) throw new ApiError("Dev resources need a saved file");
    if (write && (!access.add || !access.edit || !access.remove)) throw new ApiError("You can't edit this file's dev resources");
    return access;
  }

  /** `getDevResourcesAsync({includeChildren})`: Figma's `{name, url, nodeId}` list, the layer's own first. */
  private async devResources(id: string, includeChildren: boolean): Promise<{ name: string; url: string; nodeId: string }[]> {
    const access = this.devAccess(false);
    const ids = [id, ...(includeChildren ? descendants(this.ctx, id, null).map((r) => (r as { $node: string }).$node) : [])];
    const records = await access.list(ids);
    return ids.flatMap((nodeId) => records.filter((r) => r.nodeId === nodeId).map((r) => ({ name: r.name, url: r.url, nodeId: r.nodeId })));
  }

  private async findResource(id: string, url: string, what: string): Promise<DevResourceRecord> {
    const found = (await this.devAccess(true).list([id])).find((r) => r.url === url);
    if (!found) throw new ApiError(`in ${what}: No dev resource with url ${url} on node ${id}`);
    return found;
  }

  private async addDevResource(id: string, url: string, name: string | null): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new ApiError("in addDevResourceAsync: A dev resource's url must be a URL");
    mustNode(this.ctx, id);
    await this.devAccess(true).add!(id, { url, name: name ?? url });
  }

  private async editDevResource(id: string, url: string, value: Obj): Promise<void> {
    const found = await this.findResource(id, url, "editDevResourceAsync");
    const patch: { name?: string; url?: string } = {};
    if (value.name !== undefined) patch.name = String(value.name);
    if (value.url !== undefined) patch.url = String(value.url);
    await this.devAccess(true).edit!(found.id, patch);
  }

  private async deleteDevResource(id: string, url: string): Promise<void> {
    const found = await this.findResource(id, url, "deleteDevResourceAsync");
    await this.devAccess(true).remove!(found.id);
  }

  private async storage(op: "get" | "set" | "delete" | "keys", key: string | undefined, value: unknown): Promise<unknown> {
    const desktop = this.env.desktop;
    if (!desktop) return memoryStorage(this.spec.pluginId, op, key, value);
    return desktop.storage({ op, pluginId: this.spec.pluginId, ...(key !== undefined ? { key } : {}), ...(op === "set" ? { value } : {}) });
  }

  /**
   * figma.notify (docs/research/atlas/17-plugins.md §6.4): 3000 ms by default, until dismissed for an error, at least
   * 100 ms; a toast over 3000 ms (or lasting) gets ×; the button's action returning false keeps it. `onDequeue` hears
   * "timeout", "dismiss" (×, cancel()) or "action_button_click".
   */
  private notify(message: string, options: Obj): number {
    const id = ++this.noticeSeq;
    const asked = options.timeout === "Infinity" ? Infinity : typeof options.timeout === "number" && !Number.isNaN(options.timeout) ? options.timeout : null;
    const timeout = asked === null ? (options.error ? Infinity : NOTIFY_TIMEOUT_MS) : Math.max(NOTIFY_MIN_TIMEOUT_MS, asked);
    const button = typeof options.button === "string" ? options.button : null;
    const toast = showToast({
      message,
      kind: options.error ? "error" : "default",
      duration: Number.isFinite(timeout) ? timeout : 0,
      timeoutType: "exact",
      ...(timeout > NOTIFY_TIMEOUT_MS ? { onDismiss: () => this.cancelNotice(id, "dismiss", false) } : {}),
      ...(button ? { action: { label: button, onAction: () => void this.noticeAction(id) }, keepOnAction: true } : {}),
    });
    const timer = Number.isFinite(timeout) ? setTimeout(() => this.cancelNotice(id, "timeout", false), timeout) : null;
    this.notices.set(id, { toast, timer });
    return id;
  }

  private async noticeAction(id: number): Promise<void> {
    const keep = (await this.enter("__notice", id, "action", "")) === "keep";
    if (!keep) this.cancelNotice(id, "action_button_click");
  }

  /** The notice leaves (`takeDown`: this side takes its toast down; the toast's own time or × already did). */
  private cancelNotice(id: number, reason: string, takeDown = true): void {
    const n = this.notices.get(id);
    if (!n) return;
    this.notices.delete(id);
    if (n.timer) clearTimeout(n.timer);
    if (takeDown) dismissToast(n.toast);
    void this.enter("__notice", id, "dequeue", reason);
  }
}

/** The documentchange property names (the document's fields as the Plugin API names them). */
const PROPERTY_NAMES: Record<string, string> = {
  fillPaints: "fills",
  strokePaints: "strokes",
  transform: "relativeTransform",
  size: "width",
  textData: "characters",
  stackMode: "layoutMode",
  stackSpacing: "itemSpacing",
  frameMaskDisabled: "clipsContent",
  mask: "isMask",
  pluginData: "pluginData",
  pluginRelaunchData: "relaunchData",
  parentIndex: "parent",
  // Figma reports the top stroke weight as "stokeTopWeight" (its typo, kept: plugins test for it)
  borderTopWeight: "stokeTopWeight",
  borderBottomWeight: "strokeBottomWeight",
  borderLeftWeight: "strokeLeftWeight",
  borderRightWeight: "strokeRightWeight",
  // Draw (docs/draw.md §7)
  textPathStart: "textPathStartData",
  transformModifiers: "transformModifiers",
  strokeBrushGuid: "complexStrokeProperties",
  dynamicStrokeSettings: "complexStrokeProperties",
  scatterStrokeSettings: "complexStrokeProperties",
  stretchStrokeSettings: "complexStrokeProperties",
  variableWidthPoints: "variableWidthStrokeProperties",
};
const apiProperty = (k: string) => PROPERTY_NAMES[k] ?? k;

const firstLine = (s: string) => s.split("\n")[0].slice(0, 200);

/** `import` followed by `(`, `//` or `/*` (not a member `.import`): Figma's check before the code runs (SES's pattern). */
const IMPORT_EXPRESSION = /(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/m;

/** Why a run's code is refused before it runs (Figma's checks and texts, docs/research/atlas/17-plugins.md §2.1), or null. */
export function codeRefusal(spec: Pick<RunSpec, "code" | "manifest">): Error | null {
  if (!API_VERSIONS.includes(spec.manifest.api)) return new Error(`Unknown plugin api version "${spec.manifest.api}"`);
  if (!spec.code) return new Error("Code string cannot be empty");
  const m = IMPORT_EXPRESSION.exec(spec.code);
  if (m) return new SyntaxError(`possible import expression rejected around line ${spec.code.slice(0, m.index + m[1].length).split("\n").length}`);
  return null;
}

/** A point in canvas coordinates → the editor view's (for showUI's `position`). */
function canvasToView(ed: EditorController, p: { x: number; y: number }): { x: number; y: number } {
  const cam = ed.engine.getCamera();
  const rect = ed.canvas?.getBoundingClientRect();
  return { x: Math.round((rect?.left ?? 0) + (p.x - cam.x) * cam.zoom), y: Math.round((rect?.top ?? 0) + (p.y - cam.y) * cam.zoom) };
}

/** `themeColors: true`: Figma's --figma-color-* variables (this theme's values) and figma-light | figma-dark on <html>. */
function themeHtml(html: string): string {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const vars: string[] = [];
  for (let i = 0; i < computed.length; i++) {
    const name = computed[i];
    if (name.startsWith("--figma-color-")) vars.push(`${name}: ${computed.getPropertyValue(name).trim()};`);
  }
  const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia?.("(prefers-color-scheme: dark)").matches);
  const style = `<style id="figma-style">:root{${vars.join("")}}</style>`;
  const cls = dark ? "figma-dark" : "figma-light";
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (_m, attrs: string) => `<html${/class=/.test(attrs) ? attrs.replace(/class="([^"]*)"/, `class="$1 ${cls}"`) : `${attrs} class="${cls}"`}>${style}`);
  return `<html class="${cls}"><head>${style}</head><body>${html}</body></html>`;
}

/** The browser build's UI: the CSP as a meta tag first in the document (docs/plugins.md §3.2). */
export function withCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  return `${meta}${html}`;
}

/** clientStorage without main (the browser build): per plugin, in this view's memory. */
const memory = new Map<string, Map<string, unknown>>();
function memoryStorage(pluginId: string, op: string, key: string | undefined, value: unknown): unknown {
  let m = memory.get(pluginId);
  if (!m) memory.set(pluginId, (m = new Map()));
  if (op === "get") return key === undefined ? undefined : structuredClone(m.get(key));
  if (op === "set") return void m.set(key ?? "", structuredClone(value));
  if (op === "delete") return void m.delete(key ?? "");
  return [...m.keys()];
}
