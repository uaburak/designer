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
import type { PluginManifest } from "@shared/plugins/types";
import { allowedUrl, refusedMessage, uiCsp } from "@shared/plugins/network";
import type { EditorController } from "../controller";
import { refusalEnglish } from "../refusals";
import { ApiError, decodeValue, encodeValue, MIXED } from "./api/codec";
import { readNode, ref, refOf, type ApiContext } from "./api/context";
import * as doc from "./api/document";
import * as draw from "./api/draw";
import { motionOps } from "./api/motion";
import { childrenOf, descendants, getPluginData, getProp, getRelaunchData, insertChild, nodeCss, pluginDataKeys, removeNode, rescale, resize, setPluginData, setProp, setRelaunchData, topLevelFrame } from "./api/nodes";
import type { PluginDesktop } from "./desktop";
import bridgeSource from "./runtime/bridge.js?raw";
import figmaSource from "./runtime/figma.js?raw";
import type { PluginUiStore } from "./ui/store";
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
  /** A VM factory (tests); default: QuickJS, or the developer VM */
  createVm?(options: VmOptions, developer: boolean): Promise<PluginVm>;
  /** Called once when the run has ended */
  onEnd?(run: PluginRun): void;
  /** One synchronous slice's limit (the main thread can't take Stop while plugin code runs); default 20 s */
  sliceTimeoutMs?: number;
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
    if (!this.spec.awaitParameters && !this.headless()) this.env.ui.setRunning(this.runId, this.spec.name, true);
    await this.waitIdle();
    try {
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
        if (!this.listening.has("documentchange")) return;
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
      if (documentChanges.length) void this.enter("__dispatch", "documentchange", encodeValue({ documentChanges }));
    }, 0);
  }

  // ---- The UI ------------------------------------------------------------------------------------------------------

  private openUi(html: string, opts: Obj): void {
    if (this.uiOpen) throw new ApiError("showUI can only be called once per plugin run");
    this.uiOpen = true;
    const themed = opts.themeColors === true ? themeHtml(html) : html;
    const position = opts.position && typeof opts.position === "object" ? (opts.position as { x: number; y: number }) : null;
    this.env.ui.putWindow({
      runId: this.runId,
      pluginId: this.spec.pluginId,
      name: this.spec.name,
      title: typeof opts.title === "string" ? opts.title : this.spec.name,
      src: null,
      visible: opts.visible !== false,
      width: Math.max(70, Math.round(Number(opts.width) || 300)),
      height: Math.max(0, Math.round(Number(opts.height) || 200)),
      position: position ? canvasToView(this.env.ed, position) : null,
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

  private postToUi(message: unknown): void {
    if (!this.uiOpen) throw new ApiError("No UI to post to: call figma.showUI first");
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
    this.env.ui.setRunning(this.runId, this.spec.name, this.running && !this.spec.awaitParameters && !this.headless() && (!w || !w.visible));
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
    this.env.ui.setRunning(this.runId, this.spec.name, false);
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
      "node.clone": (id) => doc.cloneNode(ctx(), s(id)),
      "node.css": (id) => Promise.resolve(nodeCss(ctx(), s(id))),
      "node.topLevelFrame": (id) => topLevelFrame(ctx(), s(id)),
      "node.export": (id, settings) => doc.exportNode(ctx(), s(id), settings),
      "node.outlineStroke": (id) => {
        const [made] = [doc.flatten(ctx(), [s(id)], null, -1)];
        return made;
      },
      "node.gridPosition": () => {
        throw new ApiError("setGridChildPosition is not supported in Wecra yet");
      },
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
        this.env.ui.patchWindow(this.runId, { visible: true });
        this.updateRunning();
      },
      "ui.hide": () => {
        this.env.ui.patchWindow(this.runId, { visible: false });
        this.updateRunning();
      },
      "ui.resize": (w, h) => this.env.ui.patchWindow(this.runId, { width: Math.max(70, Math.round(n(w))), height: Math.max(0, Math.round(n(h))) }),
      "ui.reposition": (x, y) => this.env.ui.patchWindow(this.runId, { position: canvasToView(this.env.ed, { x: n(x), y: n(y) }) }),
      "ui.getPosition": () => {
        const w = this.env.ui.window(this.runId);
        if (!w) throw new ApiError("No UI is open");
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

  private async storage(op: "get" | "set" | "delete" | "keys", key: string | undefined, value: unknown): Promise<unknown> {
    const desktop = this.env.desktop;
    if (!desktop) return memoryStorage(this.spec.pluginId, op, key, value);
    return desktop.storage({ op, pluginId: this.spec.pluginId, ...(key !== undefined ? { key } : {}), ...(op === "set" ? { value } : {}) });
  }

  private notify(message: string, options: Obj): number {
    const id = ++this.noticeSeq;
    const timeout = typeof options.timeout === "number" ? options.timeout : options.timeout === Infinity ? Infinity : 4000;
    const button = typeof options.button === "string" ? options.button : null;
    const toast = showToast({
      message,
      kind: options.error ? "error" : "default",
      duration: Number.isFinite(timeout) ? timeout : 0,
      ...(button ? { action: { label: button, onAction: () => void this.enter("__notice", id, "action", "") } } : {}),
    });
    const timer = Number.isFinite(timeout) ? setTimeout(() => this.cancelNotice(id, "timeout"), timeout) : null;
    this.notices.set(id, { toast, timer });
    return id;
  }

  private cancelNotice(id: number, reason: string): void {
    const n = this.notices.get(id);
    if (!n) return;
    this.notices.delete(id);
    if (n.timer) clearTimeout(n.timer);
    if (reason !== "timeout") dismissToast(n.toast);
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
