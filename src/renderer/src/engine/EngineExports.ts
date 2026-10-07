/**
 * The engine's C ABI, typed, with its marshalling (docs/engine.md §10.1–10.2).
 * Interim: written by hand until apigen generates EngineExports.generated.ts
 * from engine/api/api.def.ts; engine/api/exports.txt lists the same functions
 * (a test checks the two agree).
 *
 * Memory rules: inputs are copied into a scratch region (borrowed for the
 * call); results are copied out of the result slot at once; heap views are
 * re-read after every call (memory growth replaces them); pointers and u32s
 * coming back are `>>> 0`'d.
 */
import type { EngineWasm } from "./wasm/engine.mjs";

const SCRATCH_INITIAL = 64 * 1024;
const TEMPORARY_ABOVE = 1024 * 1024;

type Fn = (...args: number[]) => number;

export class EngineExports {
  readonly module: EngineWasm;
  private readonly fns = new Map<string, Fn>();
  private scratch = 0;
  private scratchSize = 0;
  private flagPtr = 0;

  constructor(module: EngineWasm) {
    this.module = module;
    this.flagPtr = this.fn("events_flag_ptr")() >>> 0;
  }

  private fn(name: string): Fn {
    let f = this.fns.get(name);
    if (!f) {
      const exported = this.module[`_engine_${name}`];
      if (typeof exported !== "function") throw new Error(`engine: the module has no engine_${name} (rebuild with npm run engine:build)`);
      f = exported;
      this.fns.set(name, f);
    }
    return f;
  }

  /** Copies `inputs` into the module's memory and calls `run` with a (pointer, length) pair per input. */
  withBytes<T>(inputs: readonly Uint8Array[], run: (pairs: number[]) => T): T {
    const total = inputs.reduce((sum, b) => sum + ((b.length + 7) & ~7), 0);
    let base: number;
    let temporary = 0;
    if (total > TEMPORARY_ABOVE) {
      temporary = this.fn("alloc")(total) >>> 0;
      base = temporary;
    } else {
      if (total > this.scratchSize || !this.scratch) {
        if (this.scratch) this.fn("free")(this.scratch);
        let size = Math.max(this.scratchSize * 2, SCRATCH_INITIAL);
        while (size < total) size *= 2;
        this.scratch = this.fn("alloc")(size) >>> 0;
        this.scratchSize = size;
      }
      base = this.scratch;
    }
    if (!base) throw new Error("engine: out of memory");
    const heap = this.module.HEAPU8; // after the allocations: they may have grown the memory
    const pairs: number[] = [];
    let at = base;
    for (const bytes of inputs) {
      heap.set(bytes, at);
      pairs.push(at, bytes.length);
      at += (bytes.length + 7) & ~7;
    }
    try {
      return run(pairs);
    } finally {
      if (temporary) this.fn("free")(temporary);
    }
  }

  /** The result slot's bytes, copied (valid until the next call that writes a result). */
  result(): Uint8Array {
    const ptr = this.fn("result_ptr")() >>> 0;
    const len = this.fn("result_len")() >>> 0;
    return this.module.HEAPU8.slice(ptr, ptr + len);
  }

  /** Whether any engine has events queued — read from memory, no call. */
  eventsPending(): boolean {
    return this.module.HEAPU32[this.flagPtr >>> 2] !== 0;
  }

  // ---- Module ----
  abiVersion = (): number => this.fn("abi_version")() >>> 0;
  lastError = (): number => this.fn("last_error")();

  // ---- Lifecycle and document ----
  create(selector: string | null, options: Uint8Array): number {
    const cstr = selector === null ? null : new TextEncoder().encode(`${selector}\0`);
    return this.withBytes(cstr ? [cstr, options] : [options], (p) =>
      cstr ? this.fn("create")(p[0], p[2], p[3]) >>> 0 : this.fn("create")(0, p[0], p[1]) >>> 0
    );
  }
  destroy = (h: number): void => void this.fn("destroy")(h);
  load = (h: number, message: Uint8Array): number => this.withBytes([message], (p) => this.fn("load")(h, p[0], p[1]));
  applyChanges = (h: number, message: Uint8Array, flags: number): number =>
    this.withBytes([message], (p) => this.fn("apply_changes")(h, p[0], p[1], flags));
  encodeDocument = (h: number, flags: number): number => this.fn("encode_document")(h, flags);
  setCurrentPage = (h: number, sessionID: number, localID: number): number => this.fn("set_current_page")(h, sessionID, localID);
  pages = (h: number): number => this.fn("pages")(h);

  // ---- View, input, frames ----
  setViewport = (h: number, cssW: number, cssH: number, dpr: number, pxW: number, pxH: number): void =>
    void this.fn("set_viewport")(h, cssW, cssH, dpr, pxW, pxH);
  setCamera = (h: number, x: number, y: number, zoom: number): void => void this.fn("set_camera")(h, x, y, zoom);
  getCamera = (h: number): number => this.fn("get_camera")(h);
  setTheme = (h: number, theme: number): void => void this.fn("set_theme")(h, theme);
  pointer = (h: number, type: number, x: number, y: number, button: number, buttons: number, mods: number,
             pressure: number, clickCount: number, pointerType: number, timeMs: number): number =>
    this.fn("pointer")(h, type, x, y, button, buttons, mods, pressure, clickCount, pointerType, timeMs) >>> 0;
  wheel = (h: number, x: number, y: number, dx: number, dy: number, deltaMode: number, mods: number, flags: number): number =>
    this.fn("wheel")(h, x, y, dx, dy, deltaMode, mods, flags) >>> 0;
  key = (h: number, type: number, keyCode: number, codepoint: number, mods: number, repeat: number): number =>
    this.fn("key")(h, type, keyCode, codepoint, mods, repeat) >>> 0;
  modifiers = (h: number, mods: number): void => void this.fn("modifiers")(h, mods);
  blur = (h: number): void => void this.fn("blur")(h);
  setTool = (h: number, tool: number): number => this.fn("set_tool")(h, tool);
  setHover = (h: number, refs: Uint8Array): void => this.withBytes([refs], (p) => void this.fn("set_hover")(h, p[0], p[1]));
  tick = (h: number, timeMs: number): number => this.fn("tick")(h, timeMs) >>> 0;
  render = (h: number): void => void this.fn("render")(h);
  nextFrameDelay = (h: number): number => this.fn("next_frame_delay")(h);
  needsFrame = (h: number): boolean => (this.fn("needs_frame")(h) >>> 0) !== 0;
  glContextLost = (h: number): void => void this.fn("gl_context_lost")(h);
  glContextRestored = (h: number): void => void this.fn("gl_context_restored")(h);

  // ---- Selection and reads ----
  getSelection = (h: number): number => this.fn("get_selection")(h);
  setSelection = (h: number, refs: Uint8Array): number => this.withBytes([refs], (p) => this.fn("set_selection")(h, p[0], p[1]));
  layerTree = (h: number, sessionID: number, localID: number): number => this.fn("layer_tree")(h, sessionID, localID);
  layerChanges = (h: number, sessionID: number, localID: number, since: number): number => this.fn("layer_changes")(h, sessionID, localID, since);
  readNodes = (h: number, refs: Uint8Array, flags: number): number =>
    this.withBytes([refs], (p) => this.fn("read_nodes")(h, p[0], p[1], flags));
  hitTest = (h: number, x: number, y: number, flags: number): number => this.fn("hit_test")(h, x, y, flags);

  // ---- Writes and commands ----
  setProps = (h: number, refs: Uint8Array, change: Uint8Array, flags: number): number =>
    this.withBytes([refs, change], (p) => this.fn("set_props")(h, p[0], p[1], p[2], p[3], flags));
  txnBegin = (h: number, label: Uint8Array): number => this.withBytes([label], (p) => this.fn("txn_begin")(h, p[0], p[1]));
  txnCommit = (h: number): number => this.fn("txn_commit")(h);
  txnCancel = (h: number): void => void this.fn("txn_cancel")(h);
  command = (h: number, id: number, args: Uint8Array | null): number =>
    args ? this.withBytes([args], (p) => this.fn("command")(h, id, p[0], p[1])) : this.fn("command")(h, id, 0, 0);
  commandState = (h: number, id: number): number => this.fn("command_state")(h, id) >>> 0;
  moveNodes = (h: number, refs: Uint8Array, parentSessionID: number, parentLocalID: number, index: number): number =>
    this.withBytes([refs], (p) => this.fn("move_nodes")(h, p[0], p[1], parentSessionID, parentLocalID, index));
  encodeSelection = (h: number, flags: number): number => this.fn("encode_selection")(h, flags);
  paste = (h: number, message: Uint8Array, flags: number): number =>
    this.withBytes([message], (p) => this.fn("paste")(h, p[0], p[1], flags));
  renderThumbnail = (h: number, pageSessionID: number, pageLocalID: number, maxSize: number, flags: number): number =>
    this.fn("render_thumbnail")(h, pageSessionID, pageLocalID, maxSize, flags);
  renderNodeThumbnail = (h: number, ref: Uint8Array, maxSize: number, flags: number): number =>
    this.withBytes([ref], (p) => this.fn("render_node_thumbnail")(h, p[0], p[1], maxSize, flags));

  // ---- Components ----
  /** A derived ref ("I…;…") → its localID in the derived session (0xFFFFFFFE); 0 for anything else. */
  refId = (ref: Uint8Array): number => this.withBytes([ref], (p) => this.fn("ref_id")(p[0], p[1]) >>> 0);
  componentInfo = (h: number, ref: Uint8Array): number => this.withBytes([ref], (p) => this.fn("component_info")(h, p[0], p[1]));

  // ---- Variables, modes, styles ----
  /** `flags`: INCLUDE_REMOTE (1) adds library copies. */
  variableCollections = (h: number, flags: number): number => this.fn("variable_collections")(h, flags);
  /** `collection`: a ref, or empty for every collection's variables; `flags`: INCLUDE_REMOTE (1). */
  variables = (h: number, collection: Uint8Array, flags: number): number =>
    collection.length
      ? this.withBytes([collection], (p) => this.fn("variables")(h, p[0], p[1], flags))
      : this.fn("variables")(h, 0, 0, flags);
  variable = (h: number, id: Uint8Array): number => this.withBytes([id], (p) => this.fn("variable")(h, p[0], p[1]));
  /** `consumer` empty: the default modes. */
  resolveVariable = (h: number, id: Uint8Array, consumer: Uint8Array): number =>
    this.withBytes([id, consumer], (p) => this.fn("resolve_variable")(h, p[0], p[1], consumer.length ? p[2] : 0, p[3]));
  boundVariables = (h: number, ref: Uint8Array): number => this.withBytes([ref], (p) => this.fn("bound_variables")(h, p[0], p[1]));
  resolvedValue = (h: number, ref: Uint8Array, target: Uint8Array): number =>
    this.withBytes([ref, target], (p) => this.fn("resolved_value")(h, p[0], p[1], p[2], p[3]));
  variableModes = (h: number, ref: Uint8Array): number => this.withBytes([ref], (p) => this.fn("variable_modes")(h, p[0], p[1]));
  /** `type`: a StyleType value (FILL 1, TEXT 3, EFFECT 4, GRID 6), 0 for all. */
  styles = (h: number, type: number, flags: number): number => this.fn("styles")(h, type, flags);
  styleUsage = (h: number, id: Uint8Array): number => this.withBytes([id], (p) => this.fn("style_usage")(h, p[0], p[1]));

  // ---- Libraries (JSON in and out) ----
  setFileKey = (h: number, key: Uint8Array): number =>
    key.length ? this.withBytes([key], (p) => this.fn("set_file_key")(h, p[0], p[1])) : this.fn("set_file_key")(h, 0, 0);
  /** `refs`: a NodeRefList, or empty for every local asset. */
  ensureAssetKeys = (h: number, refs: Uint8Array): number =>
    refs.length ? this.withBytes([refs], (p) => this.fn("ensure_asset_keys")(h, p[0], p[1])) : this.fn("ensure_asset_keys")(h, 0, 0);
  localAssets = (h: number): number => this.fn("local_assets")(h);
  encodeAssets = (h: number, keys: Uint8Array): number => this.withBytes([keys], (p) => this.fn("encode_assets")(h, p[0], p[1]));
  markPublished = (h: number, entries: Uint8Array): number => this.withBytes([entries], (p) => this.fn("mark_published")(h, p[0], p[1]));
  importLibraryAssets = (h: number, messages: Uint8Array, options: Uint8Array): number =>
    this.withBytes([messages, options], (p) => this.fn("import_library_assets")(h, p[0], p[1], p[2], p[3]));
  applyLibraryUpdate = (h: number, messages: Uint8Array, options: Uint8Array): number =>
    this.withBytes([messages, options], (p) => this.fn("apply_library_update")(h, p[0], p[1], p[2], p[3]));
  libraryUsage = (h: number): number => this.fn("library_usage")(h);

  // ---- Fonts (module-wide) ----
  /** Copies a font file into the module's heap and hands it over (the engine frees it); the face id or a Status. */
  fontAddTake(bytes: Uint8Array, faceIndex: number): number {
    const ptr = this.fn("alloc")(Math.max(1, bytes.length)) >>> 0;
    if (!ptr) return -4;
    this.module.HEAPU8.set(bytes, ptr);
    return this.fn("font_add_take")(ptr, bytes.length, faceIndex);
  }
  fontBind = (family: Uint8Array, style: Uint8Array, faceId: number): number =>
    this.withBytes([family, style], (p) => this.fn("font_bind")(p[0], p[1], p[2], p[3], faceId));
  fontMissing = (family: Uint8Array, style: Uint8Array): void =>
    this.withBytes([family, style], (p) => void this.fn("font_missing")(p[0], p[1], p[2], p[3]));
  setFallbackFonts = (families: Uint8Array): number => this.withBytes([families], (p) => this.fn("set_fallback_fonts")(p[0], p[1]));

  // ---- Vector edit mode, gradient handles ----
  vectorEdit = (h: number, sessionID: number, localID: number): number => this.fn("vector_edit")(h, sessionID, localID);
  vectorEditEnd = (h: number): void => void this.fn("vector_edit_end")(h);
  vectorEditTool = (h: number, tool: number): number => this.fn("vector_edit_tool")(h, tool);
  endCaps = (h: number, sessionID: number, localID: number): number => this.fn("end_caps")(h, sessionID, localID);
  paintEdit = (h: number, sessionID: number, localID: number, paints: number, index: number): number =>
    this.fn("paint_edit")(h, sessionID, localID, paints, index);
  paintEditEnd = (h: number): void => void this.fn("paint_edit_end")(h);
  paintEditStop = (h: number, index: number): number => this.fn("paint_edit_stop")(h, index);

  // ---- Images (module-wide) ----
  /** `hash`: 40 hex digits. The bitmap is Module.engineBitmaps[bitmapId]. */
  imageAddBitmap = (hash: string, bitmapId: number, width: number, height: number): number =>
    this.withBytes([new TextEncoder().encode(hash)], (p) => this.fn("image_add_bitmap")(p[0], bitmapId, width, height));
  imageAddRgba = (hash: string, width: number, height: number, rgba: Uint8Array): number =>
    this.withBytes([new TextEncoder().encode(hash), rgba], (p) => this.fn("image_add_rgba")(p[0], width, height, p[2], p[3]));
  imageFailed = (hash: string): number => this.withBytes([new TextEncoder().encode(hash)], (p) => this.fn("image_failed")(p[0]));

  // ---- Text ----
  textEdit = (h: number, sessionID: number, localID: number, flags: number): number => this.fn("text_edit")(h, sessionID, localID, flags);
  textEditEnd = (h: number): void => void this.fn("text_edit_end")(h);
  textInput = (h: number, text: Uint8Array): number => this.withBytes([text], (p) => this.fn("text_input")(h, p[0], p[1]));
  textComposition = (h: number, text: Uint8Array, selStart: number, selEnd: number): number =>
    this.withBytes([text], (p) => this.fn("text_composition")(h, p[0], p[1], selStart, selEnd));
  textCompositionEnd = (h: number, text: Uint8Array): number =>
    this.withBytes([text], (p) => this.fn("text_composition_end")(h, p[0], p[1]));
  textSelection = (h: number): number => this.fn("text_selection")(h);
  textLayout = (h: number, sessionID: number, localID: number): number => this.fn("text_layout")(h, sessionID, localID);

  // ---- Events and diagnostics ----
  hasEvents = (h: number): boolean => (this.fn("has_events")(h) >>> 0) !== 0;
  takeEvents = (h: number): number => this.fn("take_events")(h);
  stats = (h: number): number => this.fn("stats")(h);
}

/** Every export this wrapper calls, as the module names them (checked against engine/api/exports.txt). */
export const USED_EXPORTS = [
  "abi_version", "alloc", "free", "result_ptr", "result_len", "events_flag_ptr", "last_error",
  "create", "destroy", "load", "apply_changes", "encode_document", "set_current_page", "pages",
  "set_viewport", "set_camera", "get_camera", "set_theme", "pointer", "wheel", "key", "modifiers", "blur",
  "set_tool", "set_hover", "tick", "render", "next_frame_delay", "needs_frame", "gl_context_lost", "gl_context_restored",
  "get_selection", "set_selection", "read_nodes", "layer_tree", "layer_changes", "hit_test",
  "set_props", "txn_begin", "txn_commit", "txn_cancel", "command", "command_state",
  "move_nodes", "encode_selection", "paste", "render_thumbnail", "render_node_thumbnail", "ref_id", "component_info",
  "variable_collections", "variables", "variable", "resolve_variable", "bound_variables", "resolved_value", "variable_modes",
  "styles", "style_usage",
  "set_file_key", "ensure_asset_keys", "local_assets", "encode_assets", "mark_published", "import_library_assets",
  "apply_library_update", "library_usage",
  "has_events", "take_events", "stats",
  "font_add_take", "font_bind", "font_missing", "set_fallback_fonts",
  "text_edit", "text_edit_end", "text_input", "text_composition", "text_composition_end", "text_selection", "text_layout",
  "image_add_bitmap", "image_add_rgba", "image_failed",
  "vector_edit", "vector_edit_end", "vector_edit_tool", "end_caps", "paint_edit", "paint_edit_end", "paint_edit_stop",
].map((name) => `engine_${name}`);
