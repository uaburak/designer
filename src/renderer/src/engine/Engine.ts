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
  APPLY_EXACT,
  APPLY_LOAD,
  APPLY_REMOTE,
  APPLY_SYSTEM,
  APPLY_USER,
  CommandId,
  ENCODE_SELECTION_CUT,
  INCLUDE_CHILD_IDS,
  INCLUDE_REMOTE,
  KeyType,
  PASTE_IN_PLACE,
  Status,
  TEXT_EDIT_SELECT_ALL,
  TICK_NEEDS_RENDER,
  TOOLS,
  VECTOR_EDIT_TOOLS,
  type CommandName,
  type ToolName,
} from "./abi";
import {
  decodeCamera,
  decodeEvents,
  decodeMessage,
  decodePages,
  decodePixels,
  decodeRefs,
  decodeSelection,
  decodeStats,
  decodeText,
  decodeTextLayout,
  encodeArgs,
  encodeFields,
  encodeMessage,
  encodeOptions,
  encodeRefs,
  encodeText,
  type Camera,
  type BindingTarget,
  type BoundVariable,
  type CommandArgValue,
  type CommandResult,
  type ComponentInfo,
  type CursorKind,
  type EncodedAsset,
  type EngineEvent,
  type EngineEventType,
  type EventOf,
  type Guid,
  type LibraryAssetUsage,
  type LibraryImportOptions,
  type LibraryImportResult,
  type LibraryUpdateOptions,
  type LocalAssetInfo,
  type Message,
  type NodeChange,
  type NodeFieldsPatch,
  type PageInfo,
  type Pixels,
  type ResolvedVariableValue,
  type StyleInfo,
  type StyleType,
  type VariableCollectionInfo,
  type VariableInfo,
  type VariableModeInfo,
  type Selection,
  type StrokeCap,
  type TextLayoutInfo,
  type VectorEditTool,
} from "./codec";
import type { EngineExports } from "./EngineExports";
import { fonts } from "./fonts";
import { keyCodeOf } from "./keyCodes";
import { loadEngine } from "./loadEngine";

export interface EngineOptions {
  /** The session new nodes are created in (allocated by storage, docs/data.md §1). */
  sessionID?: number;
  theme?: "LIGHT" | "DARK";
}

/**
 * How applyChanges takes changes: "user" = undoable and emitted; "system" = emitted, not an undo step (library
 * bookkeeping: libraryMoveInfo, publishedVersion, publishing flags; E_BUSY inside an open batch); "restore" = a
 * store-computed state (Restore version's diff): undoable and emitted, written as it is — library copies included, no
 * detaching, no instance root overrides; "remote" / "load" = neither emitted nor undoable. "user" and "system" never
 * write into library copies (docs/schema.md §8.2).
 */
export type ApplyKind = "user" | "system" | "restore" | "remote" | "load";

/** Where image bytes come from (the file's image store): the image file for a SHA-1 hash, or null. */
export type ImageSource = (hash: string) => Promise<Uint8Array | null>;

let nextBitmapId = 1;

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
    fonts.attach(exports);
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

  /** The text editing state, as the last TEXT_EDIT event said. */
  textEdit: EventOf<"TEXT_EDIT"> | null = null;
  /** Vector edit mode, as the last VECTOR_EDIT event said (null when not editing). */
  vectorEdit: EventOf<"VECTOR_EDIT"> | null = null;
  /** Gradient handles, as the last PAINT_EDIT event said (null when none are shown). */
  paintEdit: EventOf<"PAINT_EDIT"> | null = null;
  /** "Return to instance": the instance the last GO_TO_MAIN_COMPONENT came from (null after returning). */
  returnToInstance: Guid | null = null;
  private imageSource: ImageSource | null = null;
  private readonly imageLoads = new Map<string, Promise<number>>();
  private readonly unsubscribeFonts: () => void;

  private constructor(exports: EngineExports, handle: number, headless: boolean) {
    this.x = exports;
    this.h = handle;
    this.headless = headless;
    // A font arrived or went missing: the engine relaid its text; drain what that changed and draw.
    this.unsubscribeFonts = fonts.onChange(() => this.pump());
  }

  get destroyed(): boolean {
    return this.h === 0;
  }

  destroy(): void {
    if (!this.h) return;
    if (this.frameRequested) cancelAnimationFrame(this.frameRequested);
    clearTimeout(this.frameTimer);
    this.unsubscribeFonts();
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
          if (event.type === "REQUEST_FONT") fonts.request(event.family, event.style);
          else if (event.type === "TEXT_EDIT") this.textEdit = event.active ? event : null;
          else if (event.type === "VECTOR_EDIT") this.vectorEdit = event.active ? event : null;
          else if (event.type === "PAINT_EDIT") this.paintEdit = event.active ? event : null;
          else if (event.type === "INSTANCE_NAVIGATION") this.returnToInstance = event.returnTo;
          else if (event.type === "REQUEST_IMAGE") this.answerImage(event.hash);
          this.handlers.get(event.type)?.forEach((handler) => handler(event));
          this.handlers.get("*")?.forEach((handler) => handler(event));
        }
      } finally {
        this.dispatching = false;
      }
    }
    return value;
  }

  /** Drains pending events and schedules a frame if one is wanted (after work the engine did on its own). */
  pump(): void {
    if (this.h) this.after(undefined);
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

  /** Changes from outside (see ApplyKind). */
  applyChanges(message: Message, kind: ApplyKind = "user"): number {
    const flags =
      kind === "user" ? APPLY_USER
      : kind === "system" ? APPLY_SYSTEM
      : kind === "restore" ? APPLY_USER | APPLY_EXACT
      : kind === "remote" ? APPLY_REMOTE
      : APPLY_LOAD;
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
  setProps(refs: readonly Guid[], fields: NodeFieldsPatch, flags = 0): number {
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

  /**
   * Runs a command; one undo step labelled with Figma's name. `args`: `{ dx, dy }` for NUDGE,
   * `{ page: "s:l" }` for DELETE_PAGE / DUPLICATE_PAGE (the current page when absent).
   */
  command(name: CommandName, args?: Readonly<Record<string, CommandArgValue>>): number {
    return this.after(this.x.command(this.h, CommandId[name], args ? encodeArgs(args) : null));
  }

  /** CMD_ENABLED | CMD_CHECKED, for menus. */
  commandState(name: CommandName): number {
    return this.after(this.x.commandState(this.h, CommandId[name]));
  }

  /**
   * The Layers panel's drag: `refs` to `parent` at `index` in its paint order (0 = bottom), counted
   * without them; they keep their relative order and their place on the page. Pages move under the
   * document ("0:0"). One undo step. Returns how many moved (0 = refused: a cycle, a page under a layer…).
   */
  moveNodes(refs: readonly Guid[], parent: Guid, index: number): number {
    const [s, l] = this.ids(parent);
    return this.after(this.x.moveNodes(this.h, encodeRefs(refs), s, l, index));
  }

  /**
   * The selection as a clipboard Message (docs/schema.md §4.1), or null when nothing is selected. It carries this
   * file's `pasteFileKey` (setFileKey) and `isCut` (`cut`: ⌘X), and, after the selection, every main, component set,
   * style, variable and collection it references (outside `clipboardSelectionRegions`) for a paste in another file.
   */
  encodeSelection(options: { cut?: boolean } = {}): Message | null {
    const status = this.x.encodeSelection(this.h, options.cut ? ENCODE_SELECTION_CUT : 0);
    return this.after(status === Status.OK ? decodeMessage(this.x.result()) : null);
  }

  /**
   * Pastes a clipboard Message with fresh ids: into the selected frame, beside the selected layer, or on the
   * page (where it was when that is in view, else in the middle of the view); `inPlace` (⇧⌘V) keeps the page
   * position. Selects what was pasted; returns how many top-level layers that was (negative: a Status).
   */
  paste(message: Message, options: { inPlace?: boolean } = {}): number {
    return this.after(this.x.paste(this.h, encodeMessage(message), options.inPlace ? PASTE_IN_PLACE : 0));
  }

  /**
   * A page's thumbnail as pixels: its content (the union of its visible layers) fitted into maxSize × maxSize
   * device px in the content's own aspect, the page colour behind it, no selection or other overlays. Drawn
   * offscreen (the canvas is untouched; headless engines return the page colour only). `page` defaults to the
   * current one. Null when the page is empty or missing, or the GPU can't make the target.
   */
  renderThumbnailPixels(options: { page?: Guid; maxSize: number }): Pixels | null {
    const [s, l] = options.page ? options.page.split(":").map(Number) : [0xffffffff, 0xffffffff];
    const status = this.x.renderThumbnail(this.h, s >>> 0, l >>> 0, Math.max(1, Math.round(options.maxSize)), 0);
    return this.after(status === Status.OK ? decodePixels(this.x.result()) : null);
  }

  /**
   * One node's thumbnail as pixels (its subtree alone, transparent around it), fitted into maxSize × maxSize device
   * px — the Assets grid. Null when it is missing, empty, or the GPU can't make the target.
   */
  renderNodeThumbnailPixels(options: { node: Guid; maxSize: number }): Pixels | null {
    const status = this.x.renderNodeThumbnail(this.h, encodeText(options.node), Math.max(1, Math.round(options.maxSize)), 0);
    return this.after(status === Status.OK ? decodePixels(this.x.result()) : null);
  }

  // ---- Components (docs/engine-build.md "E6") -------------------------------------------------

  /** What a node is on the component side, with its main, changes, properties and exposed instances; null if missing. */
  componentInfo(ref: Guid): ComponentInfo | null {
    const status = this.x.componentInfo(this.h, encodeText(ref));
    return this.after(status === Status.OK ? (JSON.parse(decodeText(this.x.result())) as ComponentInfo) : null);
  }

  // ---- Variables, modes, styles (docs/engine-build.md "E6 variables") ----

  /** The same as `command`, plus what it created (collections and their first mode, modes, variables, styles). */
  runCommand(name: CommandName, args?: Readonly<Record<string, CommandArgValue>>): CommandResult {
    const status = this.x.command(this.h, CommandId[name], args ? encodeArgs(args) : null);
    let created: Guid[] = [];
    try {
      created = (JSON.parse(decodeText(this.x.result())) as { created?: Guid[] }).created ?? [];
    } catch {
      created = [];
    }
    return this.after({ status, created });
  }

  /** The result slot as JSON when `status` is OK, else `fallback`. */
  private json<T>(status: number, fallback: T): T {
    return this.after(status === Status.OK ? (JSON.parse(decodeText(this.x.result())) as T) : fallback);
  }

  /** The file's live collections, in the panel's order (`includeRemote`: library copies too). */
  variableCollections(options: { includeRemote?: boolean } = {}): VariableCollectionInfo[] {
    return this.json(this.x.variableCollections(this.h, options.includeRemote ? INCLUDE_REMOTE : 0), []);
  }

  /** A collection's live variables in order (none given: every local collection's; `includeRemote`: copies' too). */
  variables(collection?: Guid, options: { includeRemote?: boolean } = {}): VariableInfo[] {
    return this.json(this.x.variables(this.h, encodeText(collection ?? ""), options.includeRemote ? INCLUDE_REMOTE : 0), []);
  }

  /** One variable (deleted-but-referenced ones too). */
  variable(id: Guid): VariableInfo | null {
    return this.json<VariableInfo | null>(this.x.variable(this.h, encodeText(id)), null);
  }

  /** Figma's resolveForConsumer: the value for `consumer`'s modes (none: every collection's default mode). */
  resolveVariable(id: Guid, consumer?: Guid): ResolvedVariableValue | null {
    return this.json<ResolvedVariableValue | null>(this.x.resolveVariable(this.h, encodeText(id), encodeText(consumer ?? "")), null);
  }

  /** A node's variable bindings (fields, paints, effects, layout guides). */
  boundVariables(ref: Guid): BoundVariable[] {
    return this.json(this.x.boundVariables(this.h, encodeText(ref)), []);
  }

  /** The resolved value of one binding of a node (null: unbound or unresolved). */
  resolvedValue(ref: Guid, target: BindingTarget): ResolvedVariableValue | null {
    return this.json<ResolvedVariableValue | null>(this.x.resolvedValue(this.h, encodeText(ref), encodeText(target)), null);
  }

  /** A layer's (or page's) mode for every collection: explicit (null = Auto) and resolved. */
  variableModes(ref: Guid): VariableModeInfo[] {
    return this.json(this.x.variableModes(this.h, encodeText(ref)), []);
  }

  /** Local styles of a type (none: all), in the panel's order, with their values and usage (`includeRemote`: copies too). */
  styles(type?: StyleType, options: { includeRemote?: boolean } = {}): StyleInfo[] {
    const id = type === "FILL" ? 1 : type === "TEXT" ? 3 : type === "EFFECT" ? 4 : type === "GRID" ? 6 : 0;
    return this.json(this.x.styles(this.h, id, options.includeRemote ? INCLUDE_REMOTE : 0), []);
  }

  /** How many layers use a style. */
  styleUsage(id: Guid): number {
    return Math.max(0, this.after(this.x.styleUsage(this.h, encodeText(id))));
  }

  // ---- Libraries (docs/data.md §9, docs/engine-build.md "E6 libraries") -------------------------

  /** This file's FileKey: clipboard Messages carry it as `pasteFileKey`; a paste from another file is cross-file. */
  setFileKey(fileKey: string): void {
    this.after(this.x.setFileKey(this.h, encodeText(fileKey)));
  }

  /**
   * Gives local assets in `refs` (default: all) that lack one a fresh 40-hex key — a journaled SYSTEM change, not an
   * undo step. Keys never change afterwards. Returns every asset's key.
   */
  ensureAssetKeys(refs?: readonly Guid[]): { id: Guid; key: string }[] {
    return this.json(this.x.ensureAssetKeys(this.h, refs?.length ? encodeRefs(refs) : new Uint8Array()), []);
  }

  /** Every local asset (components, sets, styles, collections, variables), publishable or not, deleted-but-kept too. */
  localAssets(): LocalAssetInfo[] {
    return this.json(this.x.localAssets(this.h), []);
  }

  /** Publish payloads: the assets with these keys and their dependencies (`dependencyOnly`), each with its Message. */
  encodeAssets(keys: readonly string[]): { assets: EncodedAsset[]; images: string[] } {
    return this.json(this.x.encodeAssets(this.h, encodeText(JSON.stringify(keys))), { assets: [], images: [] });
  }

  /**
   * After a successful publish (SYSTEM, not undoable): `publishedVersion` = `versionHash` on the version's assets (pass
   * all of them, dependencies and kept versions too) and `libraryMoveInfo` cleared on its mains; `versionHash: null`
   * = the version removed that asset (hidden or deleted, then published): `publishedVersion` cleared.
   */
  markPublished(entries: readonly { key: string; versionHash: string | null }[]): number {
    return this.after(this.x.markPublished(this.h, encodeText(JSON.stringify(entries))));
  }

  /**
   * Read-only library copies on the internal canvas (SYSTEM, not undoable; inside an open batch: part of its step); a
   * copy already here (same library and key) is reused — unless `asNew`: a new, complete copy of the asked assets.
   */
  importLibraryAssets(messages: Message | readonly Message[], options: LibraryImportOptions): LibraryImportResult {
    return this.libraryCall(this.x.importLibraryAssets, messages, options);
  }

  /**
   * Replaces copies with new versions — every copy of each key (or only `copies`); instances keep overrides; users
   * re-resolve — and applies redirects: one undo step.
   */
  applyLibraryUpdate(messages: Message | readonly Message[], options: LibraryUpdateOptions): LibraryImportResult {
    return this.libraryCall(this.x.applyLibraryUpdate, messages, options);
  }

  /** Every library copy in this file, its version and how many layers use it. */
  libraryUsage(): LibraryAssetUsage[] {
    return this.json(this.x.libraryUsage(this.h), []);
  }

  private libraryCall(
    call: (h: number, messages: Uint8Array, options: Uint8Array) => number,
    messages: Message | readonly Message[],
    options: LibraryImportOptions | LibraryUpdateOptions,
  ): LibraryImportResult {
    const list = Array.isArray(messages) ? messages : [messages];
    const status = call(this.h, encodeText(JSON.stringify({ messages: list })), encodeText(JSON.stringify(options)));
    let result: LibraryImportResult = { status, assets: [], images: [] };
    if (status === Status.OK) {
      try {
        result = JSON.parse(decodeText(this.x.result())) as LibraryImportResult;
        result.images ??= [];
      } catch {
        result = { status, assets: [], images: [] };
      }
    }
    return this.after({ ...result, status });
  }

  /** (sessionID, localID) of a ref for the calls that take them; derived refs ("I…;…") resolve through the engine. */
  private ids(ref: Guid): [number, number] {
    if (ref.startsWith("I")) return [0xfffffffe, this.x.refId(encodeText(ref))];
    const [s, l] = ref.split(":").map(Number);
    return [s >>> 0, l >>> 0];
  }

  /** The same thumbnail encoded as an image (PNG by default) through an OffscreenCanvas, or null. */
  async renderThumbnail(options: { page?: Guid; maxSize: number; type?: string }): Promise<Blob | null> {
    const image = this.renderThumbnailPixels(options);
    if (!image) return null;
    const data = new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height);
    const type = options.type ?? "image/png";
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(image.width, image.height);
      canvas.getContext("2d")?.putImageData(data, 0, 0);
      return canvas.convertToBlob({ type });
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(data, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, type));
  }

  // ---- Text (docs/engine.md §7.6) ------------------------------------------------------

  /** Edits a TEXT node: all its text selected, or the caret at its end. Status.E_UNSUPPORTED: its font is missing. */
  startTextEdit(ref: Guid, options: { selectAll?: boolean } = {}): number {
    const [s, l] = this.ids(ref);
    return this.after(this.x.textEdit(this.h, s, l, options.selectAll ? TEXT_EDIT_SELECT_ALL : 0));
  }

  /** Leaves text editing (as Esc does); an empty text is deleted. */
  endTextEdit(): void {
    this.after(this.x.textEditEnd(this.h));
  }

  /** Typed (or pasted) text replacing the text selection. */
  textInput(text: string): number {
    return this.after(this.x.textInput(this.h, encodeText(text)));
  }

  /** IME: the composition so far, its selection in UTF-16 units of `text`. */
  textComposition(text: string, selStart: number, selEnd: number): number {
    return this.after(this.x.textComposition(this.h, encodeText(text), selStart, selEnd));
  }

  /** IME: the composition's final text. */
  textCompositionEnd(text: string): number {
    return this.after(this.x.textCompositionEnd(this.h, encodeText(text)));
  }

  /** The selected text of the text being edited ("" when none), for copy. */
  textSelection(): string {
    this.x.textSelection(this.h);
    return this.after(decodeText(this.x.result()));
  }

  /** A TEXT node's layout (baselines, glyphs, missing font…), or null for other nodes. */
  textLayout(ref: Guid): TextLayoutInfo | null {
    const [s, l] = this.ids(ref);
    const status = this.x.textLayout(this.h, s, l);
    return this.after(status === Status.OK ? decodeTextLayout(this.x.result()) : null);
  }

  // ---- Vector edit mode (docs/engine-build.md "E4 + E5 API") ---------------------------------

  /**
   * Edits a node's vector network: VECTOR, LINE, rectangles, ellipses, stars, polygons (a shape becomes a VECTOR
   * at its first edit, same GUID). Status.E_UNSUPPORTED for others. `vectorEdit` follows the VECTOR_EDIT events.
   */
  startVectorEdit(ref: Guid): number {
    const [s, l] = this.ids(ref);
    return this.after(this.x.vectorEdit(this.h, s, l));
  }

  /** Leaves vector edit mode (as Esc / Enter do). */
  endVectorEdit(): void {
    this.after(this.x.vectorEditEnd(this.h));
  }

  /** The vector edit toolbar: MOVE, PEN, BEND (also ⌘ held), LASSO, PAINT_BUCKET. */
  setVectorEditTool(tool: VectorEditTool): number {
    return this.after(this.x.vectorEditTool(this.h, VECTOR_EDIT_TOOLS.indexOf(tool)));
  }

  /** An open path's ends (Figma's Start point / End point), or null when the node has none. */
  endCaps(ref: Guid): { start: StrokeCap; end: StrokeCap } | null {
    const [s, l] = this.ids(ref);
    const status = this.x.endCaps(this.h, s, l);
    return this.after(status === Status.OK ? (JSON.parse(decodeText(this.x.result())) as { start: StrokeCap; end: StrokeCap }) : null);
  }

  // ---- Gradient handles ------------------------------------------------------------------------

  /** Shows a gradient paint's handles and stops on the canvas (fills or strokes, its index). */
  startPaintEdit(ref: Guid, options: { paints: "FILL" | "STROKE"; index: number }): number {
    const [s, l] = this.ids(ref);
    return this.after(this.x.paintEdit(this.h, s, l, options.paints === "STROKE" ? 1 : 0, options.index));
  }

  endPaintEdit(): void {
    this.after(this.x.paintEditEnd(this.h));
  }

  /** The panel selected a stop: the canvas shows it selected. */
  setPaintEditStop(index: number): number {
    return this.after(this.x.paintEditStop(this.h, index));
  }

  // ---- Images (docs/engine.md §6.6) ------------------------------------------------------

  /**
   * Where the engine's images come from: from now on every REQUEST_IMAGE is answered with the bytes `load`
   * gives for the hash (decoded with createImageBitmap, uploaded straight into a texture), or reported failed.
   */
  setImageSource(load: ImageSource | null): void {
    this.imageSource = load;
  }

  private answerImage(hash: string): void {
    if (!this.imageSource || this.imageLoads.has(hash)) return;
    const load = this.imageSource;
    const work = load(hash)
      .then((bytes) => (bytes ? this.addImageBytes(hash, bytes) : this.imageFailed(hash)))
      .catch(() => this.imageFailed(hash));
    this.imageLoads.set(hash, work);
  }

  /** An image's file bytes for `hash` (40 hex digits): decoded by the browser and handed to the engine. */
  async addImageBytes(hash: string, bytes: Uint8Array): Promise<number> {
    if (typeof createImageBitmap === "undefined") return this.imageFailed(hash);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: "premultiply", colorSpaceConversion: "default" });
    } catch {
      return this.imageFailed(hash);
    }
    if (!this.h) {
      bitmap.close();
      return Status.E_HANDLE;
    }
    return this.addImage(hash, bitmap);
  }

  /** A decoded image for `hash`; the engine keeps the bitmap (it uploads it again after a GPU eviction). */
  addImage(hash: string, bitmap: ImageBitmap): number {
    const module = this.x.module;
    module.engineBitmaps ??= {};
    const id = nextBitmapId++;
    module.engineBitmaps[id] = bitmap;
    return this.after(this.x.imageAddBitmap(hash.toLowerCase(), id, bitmap.width, bitmap.height));
  }

  /** Raw premultiplied RGBA8 pixels for `hash` (headless engines, tests). */
  addImageRgba(hash: string, width: number, height: number, rgba: Uint8Array): number {
    return this.after(this.x.imageAddRgba(hash.toLowerCase(), width, height, rgba));
  }

  /** Nobody has the image: its paints draw Figma's grey placeholder. */
  imageFailed(hash: string): number {
    return this.after(this.x.imageFailed(hash.toLowerCase()));
  }

  /** Every image the engine asked for so far has been answered (thumbnails, screenshots). */
  async imagesSettled(): Promise<void> {
    while (true) {
      const pending = [...this.imageLoads.values()];
      await Promise.allSettled(pending);
      if (this.imageLoads.size === pending.length) return;
    }
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
