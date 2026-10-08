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
  ENCODE_DERIVED,
  ENCODE_SELECTION_CUT,
  EXPORT_ALLOW_PENDING,
  INCLUDE_CHILD_IDS,
  INCLUDE_REMOTE,
  KeyType,
  PASTE_IN_PLACE,
  READ_SUBTREE,
  READ_VISIBLE_ONLY,
  Status,
  TEXT_EDIT_SELECT_ALL,
  TICK_NEEDS_RENDER,
  TOOLS,
  VECTOR_EDIT_TOOLS,
  WIRE_JSON,
  WIRE_KIWI,
  type CommandName,
  type ToolName,
} from "./abi";
import { decodeMessage as decodeKiwiMessage, encodeMessage as encodeKiwiMessage } from "../../../shared/schema/codec";
import { messageToKiwi } from "../store/engineMessage";
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
  encodeMessageList,
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
  type ExportInfo,
  type ExportListEntry,
  type ExportOutput,
  type Guid,
  type LayerChanges,
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
import { FACET_DECODERS, FACET_IDS, FACET_SLOTS, type FacetName } from "./facets.generated";
import type { ExportSettings } from "../../../shared/schema/document.generated";
import { fonts } from "./fonts";
import { keyCodeOf } from "./keyCodes";
import { prepareGfx, recordWebGPUFallback, type GfxBackend, type GfxPreference } from "./gfx";
import { loadEngine } from "./loadEngine";

/** The encoding of the engine's structured outputs (docs/engine-build.md "Figma parity round 3"). */
export type WireFormat = "json" | "kiwi";
/** DOCUMENT.documentColorProfile as the canvas uses it. */
export type ColorProfile = "SRGB" | "DISPLAY_P3";

export interface EngineOptions {
  /** The session new nodes are created in (allocated by storage, docs/data.md §1). */
  sessionID?: number;
  theme?: "LIGHT" | "DARK";
  /**
   * "kiwi": documents and changes cross as schema/document.kiwi Messages — `encodeDocumentKiwi`, `encodeSelectionKiwi`,
   * `encodeAssetsKiwi` return bytes and DOCUMENT_CHANGED carries `bytes` (its `message` is then the kiwi-shaped
   * Message, decoded lazily). "json" (the default during the transition): the interim JSON as before. Inputs
   * (`loadKiwi`, `applyChangesKiwi`, `pasteKiwi`, the library payloads) take either encoding whatever the setting.
   */
  wire?: WireFormat;
  /**
   * The canvas's GPU backend (gfx.ts): "auto" (the default) is Figma's rule — WebGPU when available and not
   * blocklisted, else WebGL2; the page's ?gfx=webgl|webgpu overrides "auto".
   */
  gfx?: GfxPreference;
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

/** The presentation view's scale options (Figma: Actual size, Fit width, Fit width and height, Fill screen). */
export type PresentScale = "ACTUAL" | "FIT_WIDTH" | "FIT" | "FILL";

/** engine_present_state. */
export interface PresentState {
  active: boolean;
  page?: Guid | null;
  /** The top-level frame shown */
  screen?: Guid | null;
  screenName?: string;
  /** The flow being presented (its starting frame), null without one */
  flow?: Guid | null;
  flowName?: string;
  flows?: { node: Guid; name: string; description: string }[];
  overlays?: Guid[];
  history?: number;
  canBack?: boolean;
  canNext?: boolean;
  canPrevious?: boolean;
  scale?: PresentScale;
  hints?: boolean;
  device?: boolean;
  /** The pointer is over something that reacts to it (the hand cursor) */
  hotspot?: boolean;
  /** The device's screen on the canvas (CSS px) */
  screenRect?: { x: number; y: number; w: number; h: number };
  events: ({ type: "CHANGED" } | { type: "OPEN_URL"; url: string; newTab: boolean })[];
}

let nextBitmapId = 1;

type Handler = (event: EngineEvent) => void;

export class Engine {
  /** The engine drawing into `canvas` (which gets the id "engine-canvas" if it has none); `null` = headless. */
  static async create(canvas: HTMLCanvasElement | null, options: EngineOptions = {}): Promise<Engine> {
    const exports = await loadEngine();
    if (canvas && !canvas.id) canvas.id = "engine-canvas";
    const wire = options.wire ?? "json";
    const gfx = canvas ? await prepareGfx(exports.module, options.gfx) : "webgl2";
    const handle = exports.create(canvas ? `#${canvas.id}` : null, encodeOptions({ sessionID: options.sessionID ?? 1, theme: options.theme ?? "DARK", wire, gfx }));
    if (!handle) {
      exports.lastError();
      throw new Error(`engine: ${decodeText(exports.result()) || "could not start"}`);
    }
    fonts.attach(exports);
    const engine = new Engine(exports, handle, canvas === null, wire);
    engine.canvas = canvas;
    if (canvas) {
      engine.gfxBackend = (engine.stats() as Record<string, unknown>).gfx === "webgpu" ? "webgpu" : "webgl2";
      Engine.drawing.add(engine);
      exports.module.onEngineGfxFailure ??= (selector, reason) => {
        for (const e of Engine.drawing) if (e.canvas && `#${e.canvas.id}` === selector) e.gfxFallback(reason);
      };
    }
    return engine;
  }

  /** Engines drawing into a canvas (a WebGPU failure names its canvas). */
  private static readonly drawing = new Set<Engine>();
  private gfxBackend: GfxBackend = "webgl2";
  /** A canvas the engine put in place of the one it was given (gfxFallback); removed with the engine. */
  private ownCanvas: HTMLCanvasElement | null = null;
  private readonly canvasListeners = new Set<(canvas: HTMLCanvasElement) => void>();

  /** The canvas's GPU backend. */
  get gfx(): GfxBackend {
    return this.gfxBackend;
  }

  /** The canvas the engine draws into (another one after a WebGPU fallback: onCanvasChange). */
  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Called when the engine moves to another canvas element; returns the unsubscribe. */
  onCanvasChange(listener: (canvas: HTMLCanvasElement) => void): () => void {
    this.canvasListeners.add(listener);
    return () => this.canvasListeners.delete(listener);
  }

  /**
   * Figma's dynamic fallback: the WebGPU device was lost or failed its self test, so the session continues on
   * WebGL2. A canvas keeps the context type it first got, so a copy of it takes its place (the original stays,
   * hidden, for whoever rendered it); every GPU resource is a cache the engine rebuilds.
   */
  gfxFallback(reason: string): void {
    const old = this.canvas;
    if (!this.h || !old || this.gfxBackend !== "webgpu") return;
    console.warn(`[engine] WebGPU failed (${reason}): continuing on WebGL2`);
    recordWebGPUFallback();
    const fresh = old.cloneNode(false) as HTMLCanvasElement;
    const focused = document.activeElement === old;
    old.removeAttribute("id");
    old.style.display = "none";
    old.after(fresh);
    this.ownCanvas?.remove();
    this.ownCanvas = fresh;
    this.canvas = fresh;
    const backend = this.x.gfxSwitch(this.h, `#${fresh.id}`, 0);
    this.gfxBackend = backend === 1 ? "webgpu" : "webgl2";
    for (const listener of [...this.canvasListeners]) listener(fresh);
    if (focused) fresh.focus({ preventScroll: true });
    this.schedule();
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
  private wireFormat: WireFormat;
  private canvas: HTMLCanvasElement | null = null;
  private profile: ColorProfile = "SRGB";

  private constructor(exports: EngineExports, handle: number, headless: boolean, wire: WireFormat) {
    this.x = exports;
    this.h = handle;
    this.headless = headless;
    this.wireFormat = wire;
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
    Engine.drawing.delete(this);
    this.ownCanvas?.remove();
    this.ownCanvas = null;
    this.canvasListeners.clear();
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
      const events = decodeEvents(this.x.result());
      for (const event of events) if (event.type === "DOCUMENT_CHANGED") this.attachPayload(event);
      this.queue.push(...events);
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

  /**
   * A kiwi-wire DOCUMENT_CHANGED names its Message by attachment index (`payload`): fetch the bytes now (the result
   * slot is per call) and give the event its `bytes`, with `message` decoded only if someone reads it.
   */
  private attachPayload(event: EventOf<"DOCUMENT_CHANGED">): void {
    const payload = (event as { payload?: number }).payload;
    if (typeof payload !== "number") return;
    if (this.x.attachment(this.h, payload) !== Status.OK) return;
    const bytes = this.x.result();
    event.bytes = bytes;
    if (event.message) return;  // the JSON wire: the message came as JSON too
    let decoded: Message | null = null;
    Object.defineProperty(event, "message", {
      enumerable: true,
      configurable: true,
      get: () => (decoded ??= decodeKiwiMessage(bytes) as unknown as Message),
    });
  }

  /** Drains pending events and schedules a frame if one is wanted (after work the engine did on its own). */
  pump(): void {
    if (this.h) this.after(undefined);
  }

  // ---- Wire format (docs/engine-build.md "Figma parity round 3") ------------------------------------------

  /** The encoding of the engine's structured outputs. */
  get wire(): WireFormat {
    return this.wireFormat;
  }

  setWireFormat(wire: WireFormat): number {
    const status = this.x.setWireFormat(this.h, wire === "kiwi" ? WIRE_KIWI : WIRE_JSON);
    if (status === Status.OK) this.wireFormat = wire;
    return this.after(status);
  }

  /** Runs `fn` with the engine's outputs in `wire` (the legacy JSON methods under a kiwi engine). */
  private withWire<T>(wire: WireFormat, fn: () => T): T {
    if (this.wireFormat === wire) return fn();
    const before = this.wireFormat;
    this.x.setWireFormat(this.h, wire === "kiwi" ? WIRE_KIWI : WIRE_JSON);
    try {
      return fn();
    } finally {
      this.x.setWireFormat(this.h, before === "kiwi" ? WIRE_KIWI : WIRE_JSON);
    }
  }

  /**
   * Replaces the document with a kiwi `Message` (the store's snapshot bytes, decompressed, as they are; the interim
   * JSON is accepted too), showing `page` first ("s:l"; default the first page) — only that page is derived. Resets
   * undo and the selection.
   */
  loadKiwi(bytes: Uint8Array, options: { page?: Guid } = {}): number {
    const [s, l] = options.page ? this.ids(options.page) : [0xffffffff, 0xffffffff];
    return this.loaded(this.after(this.x.loadAt(this.h, bytes, s, l)));
  }

  /**
   * The stamp of the derived data this engine writes (`encodeDocumentKiwi({derived: true})`) and trusts at load
   * (`Message.derivedDataVersion`): a snapshot carrying another stamp is derived again.
   */
  derivedDataVersion(): number {
    return this.x.derivedDataVersion();
  }

  /** `loadKiwi` under the name the editor's loader looks for (either encoding). */
  loadBytes(bytes: Uint8Array, options: { page?: Guid } = {}): number {
    return this.loadKiwi(bytes, options);
  }

  /** Changes from outside as a kiwi Message (a journal frame, a restore diff; either encoding). See ApplyKind. */
  applyChangesKiwi(bytes: Uint8Array, kind: ApplyKind = "user"): number {
    return this.after(this.x.applyChanges(this.h, bytes, Engine.applyFlags(kind)));
  }

  /**
   * The whole document as a kiwi snapshot Message (DOCUMENT first, parents before children). `derived`: with the
   * derived data (derivedSymbolData per instance, derivedTextData per text, Message.derivedDataVersion) for a
   * snapshot that loads without materializing or shaping.
   */
  encodeDocumentKiwi(options: { derived?: boolean } = {}): Uint8Array {
    return this.withWire("kiwi", () => {
      this.x.encodeDocument(this.h, options.derived ? ENCODE_DERIVED : 0);
      return this.after(this.x.result());
    });
  }

  /** The selection as a kiwi clipboard Message (pastePageId, pasteFileKey, isCut, clipboardSelectionRegions), or null. */
  encodeSelectionKiwi(options: { cut?: boolean } = {}): Uint8Array | null {
    return this.withWire("kiwi", () => {
      const status = this.x.encodeSelection(this.h, options.cut ? ENCODE_SELECTION_CUT : 0);
      return this.after(status === Status.OK ? this.x.result() : null);
    });
  }

  /** Pastes a clipboard Message given as bytes (either encoding); see `paste`. */
  pasteKiwi(bytes: Uint8Array, options: { inPlace?: boolean } = {}): number {
    return this.after(this.x.paste(this.h, bytes, options.inPlace ? PASTE_IN_PLACE : 0));
  }

  /** `encodeAssets` with each payload as kiwi Message bytes (`bytes`; sessionID 0, as a library payload is). */
  encodeAssetsKiwi(keys: readonly string[]): { assets: (Omit<EncodedAsset, "message"> & { bytes: Uint8Array })[]; images: string[] } {
    return this.withWire("kiwi", () => {
      const status = this.x.encodeAssets(this.h, encodeText(JSON.stringify(keys)));
      if (status !== Status.OK) return this.after({ assets: [], images: [] });
      const raw = JSON.parse(decodeText(this.x.result())) as { assets: (Omit<EncodedAsset, "message"> & { payload: number })[]; images: string[] };
      const assets = raw.assets.map(({ payload, ...info }) => {
        const bytes = this.x.attachment(this.h, payload) === Status.OK ? this.x.result() : new Uint8Array();
        return { ...info, bytes };
      });
      return this.after({ assets, images: raw.images ?? [] });
    });
  }

  /** `importLibraryAssets` with the payloads as kiwi Message bytes. */
  importLibraryAssetsKiwi(messages: readonly Uint8Array[], options: LibraryImportOptions): LibraryImportResult {
    return this.libraryCallBytes(this.x.importLibraryAssets, messages, options);
  }

  /** `applyLibraryUpdate` with the payloads as kiwi Message bytes. */
  applyLibraryUpdateKiwi(messages: readonly Uint8Array[], options: LibraryUpdateOptions): LibraryImportResult {
    return this.libraryCallBytes(this.x.applyLibraryUpdate, messages, options);
  }

  private libraryCallBytes(
    call: (h: number, messages: Uint8Array, options: Uint8Array) => number,
    messages: readonly Uint8Array[],
    options: LibraryImportOptions | LibraryUpdateOptions,
  ): LibraryImportResult {
    const status = call(this.h, encodeMessageList(messages), encodeText(JSON.stringify(options)));
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

  private static applyFlags(kind: ApplyKind): number {
    return kind === "user" ? APPLY_USER
      : kind === "system" ? APPLY_SYSTEM
      : kind === "restore" ? APPLY_USER | APPLY_EXACT
      : kind === "remote" ? APPLY_REMOTE
      : APPLY_LOAD;
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

  // ---- Prototyping (E8: docs/engine-build.md "E8") --------------------------------

  /** The Prototype tab: connections, "+" handles and flow labels on the canvas. */
  setPrototypeMode(on: boolean): void {
    this.after(this.x.setPrototypeMode(this.h, on));
  }

  /**
   * The presentation view: from now on frames draw the prototype (its scene), and input goes through the present*
   * calls. `page` (default: the current page) and `node` (a top-level frame or a layer in one; default: the first
   * flow's start, else the first frame). Status.OK, or E_NOT_FOUND when the page has nothing to show.
   */
  presentStart(options: { page?: Guid; node?: Guid } = {}): number {
    const [ps, pl] = options.page ? this.ids(options.page) : [0xffffffff, 0xffffffff];
    const [ns, nl] = options.node ? this.ids(options.node) : [0xffffffff, 0xffffffff];
    const status = this.x.presentStart(this.h, ps, pl, ns, nl);
    this.schedule();
    return this.after(status);
  }

  presentStop(): void {
    this.x.presentStop(this.h);
    this.schedule();
    this.after(undefined);
  }

  /** type: PointerType (DOWN 0, MOVE 1, UP 2, CANCEL 3, ENTER 4, LEAVE 5); CSS px in the canvas. */
  presentPointer(type: number, x: number, y: number, buttons: number, mods: number): boolean {
    const handled = this.x.presentPointer(this.h, type, x, y, buttons, mods) !== 0;
    this.schedule();
    this.after(undefined);
    return handled;
  }

  presentWheel(x: number, y: number, dx: number, dy: number, deltaMode: number): boolean {
    const handled = this.x.presentWheel(this.h, x, y, dx, dy, deltaMode) !== 0;
    this.schedule();
    this.after(undefined);
    return handled;
  }

  /** A key by its JS keyCode (Figma's Key / Gamepad codes); true when the prototype or a presentation shortcut took it. */
  presentKey(type: "down" | "up", keyCode: number, mods: number): boolean {
    const handled = this.x.presentKey(this.h, type === "down" ? 0 : 1, keyCode, mods) !== 0;
    this.schedule();
    this.after(undefined);
    return handled;
  }

  /** Restart (R), next / previous frame (→ ←), Back, cycle the scale option (Z). */
  presentCommand(command: "restart" | "next" | "previous" | "back" | "scale"): number {
    const code = { restart: 0, next: 1, previous: 2, back: 3, scale: 4 }[command];
    const status = this.x.presentCommand(this.h, code);
    this.schedule();
    return this.after(status);
  }

  presentSetOptions(options: { scale?: PresentScale; hints?: boolean }): void {
    this.x.presentSetOptions(this.h, encodeText(JSON.stringify(options)));
    this.schedule();
    this.after(undefined);
  }

  /** The presentation's state, and what happened since the last read (CHANGED, OPEN_URL). */
  presentState(): PresentState {
    this.x.presentState(this.h);
    return this.after(JSON.parse(decodeText(this.x.result())) as PresentState);
  }

  // ---- Document ---------------------------------------------------------------

  /** Replaces the document (a snapshot Message). Resets undo and the selection. */
  load(message: Message): number {
    // The engine reads documents as kiwi only (docs/engine-build.md "Figma parity round 4"): a Message in the engine's
    // JSON shape (memory sources, demos, tests) is encoded here, with the shared codec, the store's way.
    const page = (message as { currentPage?: unknown }).currentPage;
    return this.loadKiwi(encodeKiwiMessage(messageToKiwi(message)), typeof page === "string" ? { page } : {});
  }

  /**
   * The document's colour profile (DOCUMENT.documentColorProfile, docs/engine.md §6 "Colour"): its colours are
   * Display P3 values in a DISPLAY_P3 file, sRGB otherwise (absent / LEGACY / SRGB).
   */
  get colorProfile(): ColorProfile {
    return this.profile;
  }

  /** After a load: the canvas takes the document's colour space (Figma draws a Display P3 file in P3). */
  private loaded(status: number): number {
    if (status !== Status.OK) return status;
    const doc = this.readNode("0:0") as { documentColorProfile?: string } | null;
    this.profile = doc?.documentColorProfile === "DISPLAY_P3" ? "DISPLAY_P3" : "SRGB";
    if (this.gfxBackend === "webgpu") {
      // The WebGPU device reads it when it next draws the canvas and uploads images (library_engine_wgpu.js).
      const space = this.profile === "DISPLAY_P3" ? "display-p3" : "srgb";
      if (this.x.module.engineColorSpace !== space) {
        this.x.module.engineColorSpace = space;
        this.schedule();
      }
      return status;
    }
    const gl = this.canvas?.getContext("webgl2") as (WebGL2RenderingContext & { drawingBufferColorSpace?: string; unpackColorSpace?: string }) | null | undefined;
    if (gl) {
      const space = this.profile === "DISPLAY_P3" ? "display-p3" : "srgb";
      // Images (sRGB or tagged) are converted into the canvas's space as they upload.
      if ("unpackColorSpace" in gl && gl.unpackColorSpace !== space) gl.unpackColorSpace = space;
      if ("drawingBufferColorSpace" in gl && gl.drawingBufferColorSpace !== space) {
        gl.drawingBufferColorSpace = space;
        this.schedule();
      }
    }
    return status;
  }

  /** The task's name for load(). */
  loadDocument(message: Message): number {
    return this.load(message);
  }

  /** Changes from outside (see ApplyKind). */
  applyChanges(message: Message, kind: ApplyKind = "user"): number {
    return this.after(this.x.applyChanges(this.h, encodeMessage(message), Engine.applyFlags(kind)));
  }

  /** The whole document as a snapshot Message (DOCUMENT first, parents before children) in the interim JSON shape. */
  encodeDocument(): Message {
    return this.withWire("json", () => {
      this.x.encodeDocument(this.h, 0);
      return this.after(decodeMessage(this.x.result()));
    });
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

  /**
   * The nodes with every field the engine keeps, or only `fields` (schema keys: "fillPaints", "strokePaints",
   * "visible", "name", …; guid and type always); `childIds` adds their children (back to front); `subtree` follows
   * each ref with its descendants, pre-order, children back to front (paint order), each node once; `visibleOnly`
   * (with `subtree`) leaves hidden layers and what is under them out — the refs themselves are always written.
   * Selection colors: `readNodes(selection, {fields: ["fillPaints", "strokePaints", "visible"], subtree: true,
   * visibleOnly: true})` is one read of just the paints under the selection.
   */
  readNodes(refs: readonly Guid[], options: { childIds?: boolean; fields?: readonly string[]; subtree?: boolean; visibleOnly?: boolean } = {}): NodeChange[] {
    const flags = (options.childIds ? INCLUDE_CHILD_IDS : 0) | (options.subtree ? READ_SUBTREE : 0) | (options.visibleOnly ? READ_VISIBLE_ONLY : 0);
    const payload = options.fields ? encodeText(JSON.stringify({ refs, fields: options.fields })) : encodeRefs(refs);
    this.x.readNodes(this.h, payload, flags);
    return this.after(decodeMessage(this.x.result()).nodeChanges);
  }

  /**
   * Typed per-facet reads (engine_read_facets; the generated bindings of facets.generated.ts, Figma's
   * *FacetTsApiGenerated): each ref's fields of `facets` in engine_read_nodes' shapes (enum names, {x, y},
   * {m00 … m12}), or null for a ref that isn't there — no JSON. For hot reads (a gesture's frames) of nodes a panel
   * already shows.
   */
  readFacets(refs: readonly Guid[], facets: readonly FacetName[]): (Record<string, unknown> | null)[] {
    if (!refs.length || !facets.length) return refs.map(() => null);
    const ids = new Uint32Array(refs.length * 2);
    refs.forEach((ref, i) => {
      const [s, l] = this.ids(ref);
      ids[2 * i] = s;
      ids[2 * i + 1] = l;
    });
    let mask = 0;
    let per = 1;
    const order = [...facets].sort((a, b) => FACET_IDS[a] - FACET_IDS[b]);
    for (const f of order) {
      if (mask & (1 << FACET_IDS[f])) continue;
      mask |= 1 << FACET_IDS[f];
      per += FACET_SLOTS[f];
    }
    if (this.x.readFacets(this.h, ids, mask) !== Status.OK) return this.after(refs.map(() => null));
    const bytes = this.x.result();
    const a = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    const out: (Record<string, unknown> | null)[] = [];
    const seen = new Set<FacetName>();
    for (let i = 0; i < refs.length; i++) {
      const o = i * per;
      if (a[o] !== 1) {
        out.push(null);
        continue;
      }
      const into: Record<string, unknown> = {};
      let at = o + 1;
      seen.clear();
      for (const f of order) {
        if (seen.has(f)) continue;
        seen.add(f);
        FACET_DECODERS[f](a, at, into);
        at += FACET_SLOTS[f];
      }
      out.push(into);
    }
    return this.after(out);
  }

  readNode(ref: Guid, options: { childIds?: boolean; fields?: readonly string[] } = {}): NodeChange | null {
    return this.readNodes([ref], options)[0] ?? null;
  }

  /**
   * The Layers panel's tree of `page` in one read: the page and every layer under it (hidden ones and instance
   * sublayers included), parents before children, each with only what a row shows — guid, parentIndex.guid, type,
   * name, visible, locked, childIds, and resizeToFit / stackMode / stackWrap / booleanOperation / isStateGroup when
   * set. Empty when the page doesn't exist. Derives the page first (its instances' sublayers are rows).
   */
  layerTree(page: Guid): NodeChange[] {
    return this.layerTreeVersioned(page).nodes;
  }

  /** `layerTree` with the document version the read is of (what `layerChanges` takes); version 0 when the page doesn't exist. */
  layerTreeVersioned(page: Guid): { version: number; nodes: NodeChange[] } {
    const [s, l] = this.ids(page);
    const status = this.x.layerTree(this.h, s, l);
    if (status !== Status.OK) return this.after({ version: 0, nodes: [] });
    return this.after(JSON.parse(decodeText(this.x.result())) as { version: number; nodes: NodeChange[] });
  }

  /**
   * The Layers rows of `page` changed since document version `since` (from `layerTreeVersioned` or the previous call):
   * the row of every node whose row data or place changed, plus the rows — with their complete, current childIds — of
   * its current and previous parents; `removed`: ids no longer in the document. `full: true` with the whole tree when
   * a delta can't be given (`since` too old or ahead, or more than 4096 rows changed). A reparented layer's subtree
   * rows don't repeat; a created layer's whole subtree does.
   */
  layerChanges(page: Guid, since: number): LayerChanges {
    const [s, l] = this.ids(page);
    const status = this.x.layerChanges(this.h, s, l, since);
    if (status !== Status.OK) return this.after({ version: 0, full: true, nodes: [], removed: [] });
    return this.after(JSON.parse(decodeText(this.x.result())) as LayerChanges);
  }

  /**
   * Pass 1 of the two-pass Layers panel: the outline of `page` — rows in pre-order (each node followed by its children
   * bottom first), `parents[i]` the parent's row index (−1 for the page), `kinds[i] = typeCode | flags << 8` (flags 1
   * instance sublayer, 2 isStateGroup, 4 resizeToFit; `types[code]` the type's name), `version` for `layerChanges`.
   * Null for a missing page. Derives the page first.
   */
  layerOutline(page: Guid): { version: number; ids: Guid[]; parents: number[]; kinds: number[]; types: string[] } | null {
    const [s, l] = this.ids(page);
    const status = this.x.layerOutline(this.h, s, l);
    return this.json(status, null);
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
    return this.withWire("json", () => {
      const status = this.x.encodeSelection(this.h, options.cut ? ENCODE_SELECTION_CUT : 0);
      return this.after(status === Status.OK ? decodeMessage(this.x.result()) : null);
    });
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
   * A region of a page (world x, y, w, h) drawn into width × height device px with the page colour behind it and no
   * overlays: what a .fig's own thumbnail shows (meta.json render_coordinates at thumbnail_size). `page` defaults to
   * the current one. Null when the page is missing, the region empty or the target too large.
   */
  renderRegionPixels(options: { page?: Guid; x: number; y: number; w: number; h: number; width: number; height: number }): Pixels | null {
    const [s, l] = options.page ? options.page.split(":").map(Number) : [0xffffffff, 0xffffffff];
    const { x, y, w, h, width, height } = options;
    const status = this.x.renderRegion(this.h, s >>> 0, l >>> 0, x, y, w, h, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), 0);
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

  // ---- Export (docs/engine-build.md "E7 export") ----------------------------------------------

  /**
   * One export, drawn by the engine: `refs` one layer (PNG, JPEG, SVG) or, for PDF, every layer as a page of one
   * file; [] = the current page's canvas. PNG / JPEG come back as straight RGBA pixels (JPEG already on white) for
   * the caller to encode; SVG / PDF as the file. "busy": fonts or images it draws are still loading (they were
   * requested; try again when they arrive, or pass `allowPending` to draw what there is).
   */
  exportNodes(refs: readonly Guid[], settings: ExportSettings, options: { allowPending?: boolean } = {}): ExportOutput {
    const format = settings.imageType ?? "PNG";
    const status = this.x.exportNodes(this.h, encodeRefs(refs), encodeText(JSON.stringify(settings)), options.allowPending ? EXPORT_ALLOW_PENDING : 0);
    if (status === Status.E_BUSY) return this.after({ status: "busy" });
    if (status !== Status.OK) {
      this.x.lastError();
      return this.after({ status: "error", code: status, message: decodeText(this.x.result()) });
    }
    const bytes = this.x.result();
    if (format === "PNG" || format === "JPEG") return this.after({ status: "ok", format, pixels: decodePixels(bytes) });
    return this.after({ status: "ok", format, bytes });
  }

  /** What an export would make (its size per layer, the images an SVG / PDF needs handed in, whether it can draw now). */
  exportInfo(refs: readonly Guid[], settings: ExportSettings): ExportInfo | null {
    return this.json(this.x.exportInfo(this.h, encodeRefs(refs), encodeText(JSON.stringify(settings))), null);
  }

  /** An image for SVG / PDF exports: the file itself (`kind` "file"), a JPEG of its colour or raw RGB (PDF), with alpha. */
  exportImage(hash: string, image: { kind: "file" | "jpeg" | "rgb"; width: number; height: number; data: Uint8Array; alpha?: Uint8Array | null }): boolean {
    const kind = image.kind === "file" ? 0 : image.kind === "jpeg" ? 1 : 2;
    return this.after(this.x.exportImage(this.h, hash, kind, image.width, image.height, image.data, image.alpha ?? new Uint8Array(0)) === Status.OK);
  }

  /** Drops the images handed in for exports. */
  clearExportImages(): void {
    this.x.exportClearImages();
  }

  /** The layers of a page with export settings, in layer order (the Export dialog). `page` defaults to the current one. */
  exportList(page?: Guid): ExportListEntry[] {
    const [s, l] = page ? page.split(":").map(Number) : [0xffffffff, 0xffffffff];
    return this.json(this.x.exportList(this.h, s >>> 0, l >>> 0), [] as ExportListEntry[]);
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
    return this.withWire("json", () => this.json(this.x.encodeAssets(this.h, encodeText(JSON.stringify(keys))), { assets: [], images: [] }));
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
    // The pixels are in the document's space; an sRGB canvas converts them as they are put (an export is sRGB).
    const data = new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height, { colorSpace: this.profile === "DISPLAY_P3" ? "display-p3" : "srgb" });
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
