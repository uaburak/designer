/**
 * The engine, as TypeScript sees it (docs/engine.md §10.5): typed methods over
 * the C ABI, the event pump, and the frame loop.
 *
 * - Events: after every call the facade checks the module's events flag; when
 *   it is set it drains the queue and dispatches each event to its
 *   subscribers, synchronously, after the engine has returned (never from
 *   inside an engine call). onDocumentChanged/onSelectionChanged/onCursor are
 *   these dispatches.
 * - Frames: render on demand. Anything that leaves the engine wanting a frame
 *   schedules one requestAnimationFrame; nothing runs while idle.
 */
import {
  APPLY_LOAD,
  APPLY_REMOTE,
  APPLY_USER,
  CommandId,
  INCLUDE_CHILD_IDS,
  KeyType,
  Status,
  TICK_NEEDS_RENDER,
  TOOLS,
  type CommandName,
  type ToolName,
} from "./abi";
import {
  decodeCamera,
  decodeEvents,
  decodeMessage,
  decodePages,
  decodeRefs,
  decodeSelection,
  decodeStats,
  decodeText,
  encodeArgs,
  encodeFields,
  encodeMessage,
  encodeOptions,
  encodeRefs,
  encodeText,
  type Camera,
  type CursorKind,
  type EngineEvent,
  type EngineEventType,
  type EventOf,
  type Guid,
  type Message,
  type NodeChange,
  type NodeFields,
  type PageInfo,
  type Selection,
} from "./codec";
import type { EngineExports } from "./EngineExports";
import { keyCodeOf } from "./keyCodes";
import { loadEngine } from "./loadEngine";

export interface EngineOptions {
  /** The session new nodes are created in (allocated by storage, docs/data.md §1). */
  sessionID?: number;
  theme?: "LIGHT" | "DARK";
}

export type ApplyKind = "user" | "remote" | "load";

type Handler = (event: EngineEvent) => void;

export class Engine {
  /** The engine drawing into `canvas` (which gets the id "engine-canvas" if it has none); `null` = headless. */
  static async create(canvas: HTMLCanvasElement | null, options: EngineOptions = {}): Promise<Engine> {
    const exports = await loadEngine();
    if (canvas && !canvas.id) canvas.id = "engine-canvas";
    const handle = exports.create(canvas ? `#${canvas.id}` : null, encodeOptions({ sessionID: options.sessionID ?? 1, theme: options.theme ?? "DARK" }));
    if (!handle) {
      exports.lastError();
      throw new Error(`engine: ${decodeText(exports.result()) || "could not start"}`);
    }
    return new Engine(exports, handle, canvas === null);
  }

  private readonly x: EngineExports;
  private h: number;
  private readonly handlers = new Map<EngineEventType | "*", Set<Handler>>();
  private queue: EngineEvent[] = [];
  private dispatching = false;
  private frameRequested = 0;
  private frameTimer = 0;
  /** No canvas: nothing to draw, no frames (tests, export later). */
  readonly headless: boolean;

  private constructor(exports: EngineExports, handle: number, headless: boolean) {
    this.x = exports;
    this.h = handle;
    this.headless = headless;
  }

  get destroyed(): boolean {
    return this.h === 0;
  }

  destroy(): void {
    if (!this.h) return;
    if (this.frameRequested) cancelAnimationFrame(this.frameRequested);
    clearTimeout(this.frameTimer);
    this.x.destroy(this.h);
    this.h = 0;
    this.handlers.clear();
  }

  // ---- Events ---------------------------------------------------------------

  /** Subscribes to one event type; returns the unsubscribe. */
  on<T extends EngineEventType>(type: T, handler: (event: EventOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = handler as Handler;
    set.add(h);
    return () => set.delete(h);
  }

  /** Every event, in order. */
  onAny(handler: (event: EngineEvent) => void): () => void {
    let set = this.handlers.get("*");
    if (!set) this.handlers.set("*", (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** A committed transaction's changes (one Message per commit) — what storage persists. */
  onDocumentChanged(handler: (changes: NodeChange[], event: EventOf<"DOCUMENT_CHANGED">) => void): () => void {
    return this.on("DOCUMENT_CHANGED", (e) => handler(e.message.nodeChanges, e));
  }

  onSelectionChanged(handler: (selection: Selection) => void): () => void {
    return this.on("SELECTION_CHANGED", (e) => handler({ pageId: e.pageId, refs: e.refs }));
  }

  onCursor(handler: (kind: CursorKind, angleDeg: number) => void): () => void {
    return this.on("CURSOR", (e) => handler(e.kind, e.angleDeg));
  }

  /** After every call: drain and dispatch events, and schedule a frame if one is wanted. */
  private after<T>(value: T): T {
    if (!this.h) return value;
    if (this.x.eventsPending() && this.x.hasEvents(this.h)) {
      this.x.takeEvents(this.h);
      this.queue.push(...decodeEvents(this.x.result()));
    }
    if (this.x.needsFrame(this.h)) this.schedule();
    if (!this.dispatching) {
      this.dispatching = true;
      try {
        // Handlers may call the engine again: their events join the queue and come after these.
        while (this.queue.length) {
          const event = this.queue.shift()!;
          this.handlers.get(event.type)?.forEach((handler) => handler(event));
          this.handlers.get("*")?.forEach((handler) => handler(event));
        }
      } finally {
        this.dispatching = false;
      }
    }
    return value;
  }

  // ---- Frames -----------------------------------------------------------------

  /** Asks for a frame (render on demand). */
  schedule(): void {
    if (this.frameRequested || !this.h || this.headless) return;
    this.frameRequested = requestAnimationFrame(this.frame);
  }

  private readonly frame = (time: number): void => {
    this.frameRequested = 0;
    if (!this.h) return;
    if (this.x.tick(this.h, time) & TICK_NEEDS_RENDER) this.x.render(this.h);
    const delay = this.x.nextFrameDelay(this.h);
    if (delay === 0) this.schedule();
    else if (delay > 0) this.frameTimer = window.setTimeout(() => this.schedule(), delay);
    this.after(undefined);
  };

  /** Draws now (tests, screenshots); normally frames come by themselves. */
  renderNow(): void {
    if (!this.h) return;
    this.x.render(this.h);
    this.after(undefined);
  }

  // ---- Document ---------------------------------------------------------------

  /** Replaces the document (a snapshot Message). Resets undo and the selection. */
  load(message: Message): number {
    return this.after(this.x.load(this.h, encodeMessage(message)));
  }

  /** The task's name for load(). */
  loadDocument(message: Message): number {
    return this.load(message);
  }

  /** Changes from outside: "user" = undoable and emitted; "remote" / "load" = neither. */
  applyChanges(message: Message, kind: ApplyKind = "user"): number {
    const flags = kind === "user" ? APPLY_USER : kind === "remote" ? APPLY_REMOTE : APPLY_LOAD;
    return this.after(this.x.applyChanges(this.h, encodeMessage(message), flags));
  }

  /** The whole document as a snapshot Message (DOCUMENT first, parents before children). */
  encodeDocument(): Message {
    this.x.encodeDocument(this.h, 0);
    return this.after(decodeMessage(this.x.result()));
  }

  pages(): PageInfo[] {
    this.x.pages(this.h);
    return this.after(decodePages(this.x.result()));
  }

  setCurrentPage(page: Guid): number {
    const [s, l] = page.split(":").map(Number);
    return this.after(this.x.setCurrentPage(this.h, s, l));
  }

  // ---- View -------------------------------------------------------------------

  /** The canvas's CSS size, device pixel ratio and backing-store size (the engine sizes the canvas). */
  setViewport(cssWidth: number, cssHeight: number, dpr: number, pixelWidth: number, pixelHeight: number): void {
    this.after(this.x.setViewport(this.h, cssWidth, cssHeight, dpr, pixelWidth, pixelHeight));
  }

  setCamera(camera: Camera): void {
    this.after(this.x.setCamera(this.h, camera.x, camera.y, camera.zoom));
  }

  getCamera(): Camera {
    this.x.getCamera(this.h);
    return this.after(decodeCamera(this.x.result()));
  }

  setTheme(theme: "LIGHT" | "DARK"): void {
    this.after(this.x.setTheme(this.h, theme === "LIGHT" ? 0 : 1));
  }

  // ---- Input (CSS px relative to the canvas) ------------------------------------

  /** Returns POINTER_HANDLED | POINTER_CAPTURE bits. */
  pointer(type: number, x: number, y: number, button: number, buttons: number, mods: number, pressure = 0, clickCount = 1, pointerType = 0, timeMs = 0): number {
    return this.after(this.x.pointer(this.h, type, x, y, button, buttons, mods, pressure, clickCount, pointerType, timeMs));
  }

  wheel(x: number, y: number, dx: number, dy: number, deltaMode: number, mods: number, flags: number): number {
    return this.after(this.x.wheel(this.h, x, y, dx, dy, deltaMode, mods, flags));
  }

  /** A key by KeyboardEvent.code; returns KEY_HANDLED when the engine used it. */
  key(type: "down" | "up", code: string, key: string, mods: number, repeat = false): number {
    const codepoint = key.length > 0 && [...key].length === 1 ? key.codePointAt(0)! : 0;
    return this.after(this.x.key(this.h, type === "down" ? KeyType.DOWN : KeyType.UP, keyCodeOf(code), codepoint, mods, repeat ? 1 : 0));
  }

  modifiers(mods: number): void {
    this.after(this.x.modifiers(this.h, mods));
  }

  /** The window or canvas lost focus: cancels a gesture. */
  blur(): void {
    this.after(this.x.blur(this.h));
  }

  setTool(tool: ToolName): number {
    return this.after(this.x.setTool(this.h, TOOLS.indexOf(tool)));
  }

  /** Outlines `refs` on the canvas (a Layers row under the pointer). */
  setHover(refs: readonly Guid[]): void {
    this.after(this.x.setHover(this.h, encodeRefs(refs)));
  }

  contextLost(): void {
    this.after(this.x.glContextLost(this.h));
  }

  contextRestored(): void {
    this.after(this.x.glContextRestored(this.h));
  }

  // ---- Selection and reads (panels) ------------------------------------------------

  getSelection(): Selection {
    this.x.getSelection(this.h);
    return this.after(decodeSelection(this.x.result()));
  }

  setSelection(refs: readonly Guid[]): number {
    return this.after(this.x.setSelection(this.h, encodeRefs(refs)));
  }

  /** The nodes with every field the engine keeps; `childIds` adds their children (back to front). */
  readNodes(refs: readonly Guid[], options: { childIds?: boolean } = {}): NodeChange[] {
    this.x.readNodes(this.h, encodeRefs(refs), options.childIds ? INCLUDE_CHILD_IDS : 0);
    return this.after(decodeMessage(this.x.result()).nodeChanges);
  }

  readNode(ref: Guid, options: { childIds?: boolean } = {}): NodeChange | null {
    return this.readNodes([ref], options)[0] ?? null;
  }

  /** What is under (x, y), innermost first (for "Select layer" in the context menu). */
  hitTest(x: number, y: number): Guid[] {
    this.x.hitTest(this.h, x, y, 0);
    return this.after(decodeRefs(this.x.result()));
  }

  // ---- Writes and commands ------------------------------------------------------------

  /** The generic setter: these fields on every ref, one undo step (or part of an open txn). */
  setProps(refs: readonly Guid[], fields: NodeFields, flags = 0): number {
    return this.after(this.x.setProps(this.h, encodeRefs(refs), encodeFields(fields), flags));
  }

  /** Panel scrubs: everything until txnCommit is one undo step and one DOCUMENT_CHANGED. */
  txnBegin(label: string): number {
    return this.after(this.x.txnBegin(this.h, encodeText(label)));
  }

  txnCommit(): number {
    return this.after(this.x.txnCommit(this.h));
  }

  txnCancel(): void {
    this.after(this.x.txnCancel(this.h));
  }

  command(name: CommandName, args?: Record<string, number>): number {
    return this.after(this.x.command(this.h, CommandId[name], args ? encodeArgs(args) : null));
  }

  /** CMD_ENABLED | CMD_CHECKED, for menus. */
  commandState(name: CommandName): number {
    return this.after(this.x.commandState(this.h, CommandId[name]));
  }

  undo(): boolean {
    return this.command("UNDO") === Status.OK;
  }

  redo(): boolean {
    return this.command("REDO") === Status.OK;
  }

  /** The last frame's numbers and the node count. */
  stats(): Record<string, number> {
    this.x.stats(this.h);
    return this.after(decodeStats(this.x.result()));
  }
}
