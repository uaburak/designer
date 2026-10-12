// The `figma` global (docs/plugins.md §5): Figma's Plugin API as the VM sees it, over the bridge (bridge.js). A node
// is a frozen handle {id} whose prototype — built per node type from Figma's mixins — reads and writes through the
// host (`get` / `set`), so `"children" in node`, `node.fills = …` and `===` between handles work as in Figma. The
// host (editor/plugins/api/*.ts) holds every rule; this file only shapes the calls.
(function () {
  "use strict";
  var g = globalThis;
  var B = g.__bridge;
  delete g.__bridge;
  var call = B.call;
  var MIXED = B.MIXED;
  var info = call("init");
  var dynamicPage = !!info.dynamicPage;

  function freeze(v) {
    if (v && typeof v === "object" && !(v instanceof Uint8Array) && !v.__nodeId && !Object.isFrozen(v)) {
      Object.keys(v).forEach(function (k) { freeze(v[k]); });
      Object.freeze(v);
    }
    return v;
  }
  function notSupported(name) {
    return function () { throw new Error(name + " is not supported in Designer yet"); };
  }

  // ---- Node handles ---------------------------------------------------------------------------------------------

  var cache = new Map();
  var protos = {};
  function wrap(id, type) {
    if (!id) return null;
    var n = cache.get(id);
    if (n && n.__type === type) return n;
    n = Object.create(protoFor(type));
    Object.defineProperty(n, "__nodeId", { value: id });
    Object.defineProperty(n, "__type", { value: type });
    Object.freeze(n);
    cache.set(id, n);
    return n;
  }
  B.setNodeReviver(wrap);

  function prop(proto, name, opts) {
    opts = opts || {};
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: true,
      get: function () { return freeze(call("get", this.__nodeId, name)); },
      set: opts.readonly
        ? function () { throw new Error("Cannot assign to read only property '" + name + "' of object '" + String(this) + "'"); }
        : function (v) { call("set", this.__nodeId, name, v); },
    });
  }
  function props(proto, names, opts) { names.forEach(function (n) { prop(proto, n, opts); }); }
  function method(proto, name, fn) { Object.defineProperty(proto, name, { value: fn, configurable: true, writable: false, enumerable: false }); }

  var BASE = {
    id: { get: function () { return this.__nodeId; } },
    type: { get: function () { return this.__type; } },
  };

  function baseMixin(p) {
    Object.defineProperty(p, "id", { enumerable: true, get: BASE.id.get });
    Object.defineProperty(p, "type", { enumerable: true, get: BASE.type.get });
    props(p, ["name"]);
    props(p, ["parent", "removed", "isAsset"], { readonly: true });
    method(p, "toString", function () { return "[object " + this.__type + " " + this.__nodeId + "]"; });
    method(p, "remove", function () { call("node.remove", this.__nodeId); cache.delete(this.__nodeId); });
    method(p, "getPluginData", function (key) { return call("pluginData.get", this.__nodeId, null, String(key)); });
    method(p, "setPluginData", function (key, value) { call("pluginData.set", this.__nodeId, null, String(key), String(value)); });
    method(p, "getPluginDataKeys", function () { return call("pluginData.keys", this.__nodeId, null); });
    method(p, "getSharedPluginData", function (ns, key) { return call("pluginData.get", this.__nodeId, String(ns), String(key)); });
    method(p, "setSharedPluginData", function (ns, key, value) { call("pluginData.set", this.__nodeId, String(ns), String(key), String(value)); });
    method(p, "getSharedPluginDataKeys", function (ns) { return call("pluginData.keys", this.__nodeId, String(ns)); });
    method(p, "setRelaunchData", function (data) { call("relaunch.set", this.__nodeId, data); });
    method(p, "getRelaunchData", function () { return call("relaunch.get", this.__nodeId); });
    method(p, "getCSSAsync", function () { return call("node.css", this.__nodeId); });
    method(p, "getTopLevelFrame", function () { return call("node.topLevelFrame", this.__nodeId); });
    method(p, "getDevResourcesAsync", notSupported("getDevResourcesAsync"));
    method(p, "addDevResourceAsync", notSupported("addDevResourceAsync"));
    method(p, "editDevResourceAsync", notSupported("editDevResourceAsync"));
    method(p, "deleteDevResourceAsync", notSupported("deleteDevResourceAsync"));
  }

  function sceneMixin(p) {
    props(p, ["visible", "locked", "componentPropertyReferences", "explicitVariableModes", "devStatus", "annotations"]);
    props(p, ["stuckNodes", "boundVariables", "resolvedVariableModes", "inferredVariables", "attachedConnectors"], { readonly: true });
    method(p, "setBoundVariable", function (field, variable) { call("variables.bind", this.__nodeId, field, variable ? variable.id || variable : null); });
    method(p, "setExplicitVariableModeForCollection", function (collection, modeId) { call("variables.setMode", this.__nodeId, collection && collection.id ? collection.id : collection, modeId); });
    method(p, "clearExplicitVariableModeForCollection", function (collection) { call("variables.setMode", this.__nodeId, collection && collection.id ? collection.id : collection, null); });
    // Prototyping
    props(p, ["reactions"], { readonly: true });
    method(p, "setReactionsAsync", function (reactions) { return Promise.resolve(call("set", this.__nodeId, "reactions", reactions)); });
    // Export
    props(p, ["exportSettings"]);
    method(p, "exportAsync", function (settings) { return call("node.export", this.__nodeId, settings || null); });
  }

  function childrenMixin(p) {
    props(p, ["children"], { readonly: true });
    method(p, "appendChild", function (child) { call("node.insert", this.__nodeId, child, -1); });
    method(p, "insertChild", function (index, child) { call("node.insert", this.__nodeId, child, index); });
    method(p, "findChildren", function (cb) { var c = this.children; return cb ? c.filter(cb) : c.slice(); });
    method(p, "findChild", function (cb) { var c = this.children; for (var i = 0; i < c.length; i++) if (cb(c[i])) return c[i]; return null; });
    method(p, "findAll", function (cb) { var all = call("node.descendants", this.__nodeId, null); return cb ? all.filter(cb) : all; });
    method(p, "findOne", function (cb) { var all = call("node.descendants", this.__nodeId, null); for (var i = 0; i < all.length; i++) if (cb(all[i])) return all[i]; return null; });
    method(p, "findAllWithCriteria", function (criteria) { return call("node.descendants", this.__nodeId, criteria || {}); });
    method(p, "findWidgetNodesByWidgetId", function () { return []; });
  }

  function layoutMixin(p) {
    props(p, ["x", "y", "relativeTransform", "rotation", "constraints", "layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight", "targetAspectRatio", "gridRowAnchorIndex", "gridColumnAnchorIndex", "gridRowSpan", "gridColumnSpan", "gridChildHorizontalAlign", "gridChildVerticalAlign"]);
    props(p, ["width", "height", "absoluteTransform", "absoluteBoundingBox", "absoluteRenderBounds"], { readonly: true });
    method(p, "resize", function (w, h) { call("node.resize", this.__nodeId, w, h, true); });
    method(p, "resizeWithoutConstraints", function (w, h) { call("node.resize", this.__nodeId, w, h, false); });
    method(p, "rescale", function (scale) { call("node.rescale", this.__nodeId, scale); });
    method(p, "lockAspectRatio", function () { call("set", this.__nodeId, "constrainProportions", true); });
    method(p, "unlockAspectRatio", function () { call("set", this.__nodeId, "constrainProportions", false); });
  }

  function blendMixin(p) {
    props(p, ["opacity", "blendMode", "isMask", "maskType", "effects", "effectStyleId"]);
    method(p, "setEffectStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "effectStyleId", id)); });
  }

  function geometryMixin(p) {
    props(p, ["fills", "strokes", "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern", "fillStyleId", "strokeStyleId"]);
    props(p, ["fillGeometry", "strokeGeometry"], { readonly: true });
    method(p, "outlineStroke", function () { return call("node.outlineStroke", this.__nodeId); });
    method(p, "setFillStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "fillStyleId", id)); });
    method(p, "setStrokeStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "strokeStyleId", id)); });
    // The only way to set pattern fills and strokes (Figma: the pattern's source is loaded first).
    method(p, "setFillsAsync", function (paints) { return Promise.resolve(call("set", this.__nodeId, "fills", paints)); });
    method(p, "setStrokesAsync", function (paints) { return Promise.resolve(call("set", this.__nodeId, "strokes", paints)); });
    // ComplexStrokesMixin (Draw, Update 123)
    props(p, ["complexStrokeProperties", "variableWidthStrokeProperties"]);
  }

  var CORNERS = ["cornerRadius", "cornerSmoothing"];
  var RECT_CORNERS = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
  var STROKE_SIDES = ["strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight"];
  var FRAME_PROPS = [
    "layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "counterAxisAlignContent",
    "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing", "itemReverseZIndex", "strokesIncludedInLayout",
    "gridRowCount", "gridColumnCount", "gridRowGap", "gridColumnGap", "gridRowSizes", "gridColumnSizes",
    "clipsContent", "layoutGrids", "gridStyleId", "guides", "expanded", "overflowDirection", "numberOfFixedChildren",
    "overlayPositionType", "overlayBackground", "overlayBackgroundInteraction",
  ];

  function frameMixin(p) {
    props(p, FRAME_PROPS);
    props(p, CORNERS.concat(RECT_CORNERS, STROKE_SIDES));
    method(p, "setGridStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "gridStyleId", id)); });
    method(p, "setGridChildPosition", function (child, row, column) { call("node.gridPosition", this.__nodeId, child, row, column); });
  }

  var TEXT_PROPS = [
    "characters", "fontName", "fontSize", "fontWeight", "textCase", "textDecoration", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent",
    "listSpacing", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "maxLines", "hyperlink", "textStyleId", "hangingPunctuation",
    "hangingList", "leadingTrim", "autoRename", "openTypeFeatures",
  ];
  var RANGE_FIELDS = ["FontName", "FontSize", "FontWeight", "Fills", "TextCase", "TextDecoration", "TextDecorationStyle", "TextDecorationOffset", "TextDecorationThickness", "TextDecorationColor", "TextDecorationSkipInk", "LetterSpacing", "LineHeight", "Hyperlink", "ListOptions", "ListSpacing", "Indentation", "ParagraphIndent", "ParagraphSpacing", "TextStyleId", "FillStyleId", "OpenTypeFeatures"];

  function textMixin(p) {
    props(p, TEXT_PROPS);
    props(p, ["hasMissingFont"], { readonly: true });
    method(p, "insertCharacters", function (start, characters, useStyle) { call("text.insert", this.__nodeId, start, String(characters), useStyle || "BEFORE"); });
    method(p, "deleteCharacters", function (start, end) { call("text.delete", this.__nodeId, start, end); });
    RANGE_FIELDS.forEach(function (f) {
      var field = f.charAt(0).toLowerCase() + f.slice(1);
      method(p, "getRange" + f, function (start, end) { return freeze(call("text.getRange", this.__nodeId, field, start, end)); });
      method(p, "setRange" + f, function (start, end, value) { call("text.setRange", this.__nodeId, field, start, end, value); });
    });
    method(p, "getRangeAllFontNames", function (start, end) { return call("text.allFontNames", this.__nodeId, start, end); });
    method(p, "getRangeBoundVariable", function (start, end, field) { return call("text.getRange", this.__nodeId, "boundVariable:" + field, start, end); });
    method(p, "setRangeBoundVariable", function (start, end, field, variable) { call("text.setRange", this.__nodeId, "boundVariable:" + field, start, end, variable ? variable.id || variable : null); });
    method(p, "setRangeTextStyleIdAsync", function (start, end, id) { return Promise.resolve(call("text.setRange", this.__nodeId, "textStyleId", start, end, id)); });
    method(p, "setRangeFillStyleIdAsync", function (start, end, id) { return Promise.resolve(call("text.setRange", this.__nodeId, "fillStyleId", start, end, id)); });
    method(p, "setTextStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "textStyleId", id)); });
    method(p, "getStyledTextSegments", function (fields, start, end) { return freeze(call("text.segments", this.__nodeId, fields, start === undefined ? 0 : start, end === undefined ? -1 : end)); });
  }

  // TextPathNode's text (Figma's BaseNonResizableTextMixin: no auto resize, line height or paragraph properties).
  var TEXT_PATH_PROPS = ["characters", "fontName", "fontSize", "textCase", "letterSpacing", "hyperlink", "textStyleId", "textAlignHorizontal", "textAlignVertical", "autoRename", "textPathStartData"];
  var TEXT_PATH_RANGES = ["FontName", "FontSize", "FontWeight", "Fills", "TextCase", "LetterSpacing", "Hyperlink", "TextStyleId", "FillStyleId", "OpenTypeFeatures"];

  function textPathMixin(p) {
    props(p, TEXT_PATH_PROPS);
    props(p, ["hasMissingFont", "fontWeight", "openTypeFeatures", "vectorPaths", "vectorNetwork", "handleMirroring"], { readonly: true });
    method(p, "insertCharacters", function (start, characters, useStyle) { call("text.insert", this.__nodeId, start, String(characters), useStyle || "BEFORE"); });
    method(p, "deleteCharacters", function (start, end) { call("text.delete", this.__nodeId, start, end); });
    TEXT_PATH_RANGES.forEach(function (f) {
      var field = f.charAt(0).toLowerCase() + f.slice(1);
      method(p, "getRange" + f, function (start, end) { return freeze(call("text.getRange", this.__nodeId, field, start, end)); });
      if (f !== "FontWeight" && f !== "OpenTypeFeatures") method(p, "setRange" + f, function (start, end, value) { call("text.setRange", this.__nodeId, field, start, end, value); });
    });
    method(p, "getRangeAllFontNames", function (start, end) { return call("text.allFontNames", this.__nodeId, start, end); });
    method(p, "getRangeBoundVariable", function (start, end, field) { return call("text.getRange", this.__nodeId, "boundVariable:" + field, start, end); });
    method(p, "setRangeBoundVariable", function (start, end, field, variable) { call("text.setRange", this.__nodeId, "boundVariable:" + field, start, end, variable ? variable.id || variable : null); });
    method(p, "setRangeTextStyleIdAsync", function (start, end, id) { return Promise.resolve(call("text.setRange", this.__nodeId, "textStyleId", start, end, id)); });
    method(p, "setRangeFillStyleIdAsync", function (start, end, id) { return Promise.resolve(call("text.setRange", this.__nodeId, "fillStyleId", start, end, id)); });
    method(p, "setTextStyleIdAsync", function (id) { return Promise.resolve(call("set", this.__nodeId, "textStyleId", id)); });
    method(p, "getStyledTextSegments", function (fields, start, end) { return freeze(call("text.segments", this.__nodeId, fields, start === undefined ? 0 : start, end === undefined ? -1 : end)); });
  }

  function componentMixin(p) {
    props(p, ["description", "descriptionMarkdown", "documentationLinks"]);
    props(p, ["key", "remote", "componentPropertyDefinitions"], { readonly: true });
    method(p, "addComponentProperty", function (name, type, defaultValue, options) { return call("component.addProperty", this.__nodeId, name, type, defaultValue, options || null); });
    method(p, "editComponentProperty", function (name, newValues) { return call("component.editProperty", this.__nodeId, name, newValues); });
    method(p, "deleteComponentProperty", function (name) { call("component.deleteProperty", this.__nodeId, name); });
    method(p, "getPublishStatusAsync", function () { return Promise.resolve("UNPUBLISHED"); });
  }

  // Which mixins each type has (Figma's typings, for the types we have).
  var TYPES = {
    DOCUMENT: ["children"],
    PAGE: ["children"],
    FRAME: ["scene", "children", "layout", "blend", "geometry", "frame"],
    GROUP: ["scene", "children", "layout", "blend"],
    SECTION: ["scene", "children", "layout", "geometry"],
    COMPONENT: ["scene", "children", "layout", "blend", "geometry", "frame", "component"],
    COMPONENT_SET: ["scene", "children", "layout", "blend", "geometry", "frame", "component"],
    INSTANCE: ["scene", "children", "layout", "blend", "geometry", "frame"],
    BOOLEAN_OPERATION: ["scene", "children", "layout", "blend", "geometry"],
    RECTANGLE: ["scene", "layout", "blend", "geometry", "rect"],
    LINE: ["scene", "layout", "blend", "geometry"],
    ELLIPSE: ["scene", "layout", "blend", "geometry", "corner"],
    POLYGON: ["scene", "layout", "blend", "geometry", "corner"],
    STAR: ["scene", "layout", "blend", "geometry", "corner"],
    VECTOR: ["scene", "layout", "blend", "geometry", "corner"],
    TEXT: ["scene", "layout", "blend", "geometry", "text"],
    SLICE: ["scene", "layout"],
    // Draw (Update 123)
    TEXT_PATH: ["scene", "layout", "blend", "geometry", "textPath"],
    TRANSFORM_GROUP: ["scene", "children", "layout", "blend"],
  };

  function protoFor(type) {
    if (protos[type]) return protos[type];
    var p = {};
    baseMixin(p);
    var mix = TYPES[type] || ["scene", "layout", "blend"];
    mix.forEach(function (m) {
      if (m === "scene") sceneMixin(p);
      else if (m === "children") childrenMixin(p);
      else if (m === "layout") layoutMixin(p);
      else if (m === "blend") blendMixin(p);
      else if (m === "geometry") geometryMixin(p);
      else if (m === "frame") frameMixin(p);
      else if (m === "rect") props(p, CORNERS.concat(RECT_CORNERS, STROKE_SIDES));
      else if (m === "corner") props(p, CORNERS);
      else if (m === "text") textMixin(p);
      else if (m === "textPath") textPathMixin(p);
      else if (m === "component") componentMixin(p);
    });
    if (type === "COMPONENT") {
      method(p, "createInstance", function () { return call("component.createInstance", this.__nodeId); });
      method(p, "getInstancesAsync", function () { return call("component.instances", this.__nodeId); });
      props(p, ["variantProperties"], { readonly: true });
      method(p, "setProperties", function () { throw new Error("setProperties is only on instances"); });
    }
    if (type === "COMPONENT_SET") props(p, ["defaultVariant", "variantGroupProperties"], { readonly: true });
    if (type === "INSTANCE") {
      props(p, ["componentProperties", "overrides", "exposedInstances", "variantProperties", "mainComponent"], { readonly: true });
      props(p, ["isExposedInstance", "scaleFactor"]);
      method(p, "getMainComponentAsync", function () { return Promise.resolve(call("instance.main", this.__nodeId)); });
      method(p, "swapComponent", function (c) { call("instance.swap", this.__nodeId, c); });
      method(p, "setProperties", function (values) { call("instance.setProperties", this.__nodeId, values); });
      method(p, "detachInstance", function () { return call("instance.detach", this.__nodeId); });
      method(p, "resetOverrides", function () { call("instance.reset", this.__nodeId); });
    }
    if (type === "POLYGON" || type === "STAR") props(p, ["pointCount"]);
    if (type === "STAR") props(p, ["innerRadius"]);
    if (type === "ELLIPSE") props(p, ["arcData"]);
    if (type === "VECTOR") {
      props(p, ["vectorPaths", "handleMirroring"]);
      props(p, ["vectorNetwork"], { readonly: true });
      method(p, "setVectorNetworkAsync", function (n) { return Promise.resolve(call("set", this.__nodeId, "vectorNetwork", n)); });
    }
    if (type === "BOOLEAN_OPERATION") props(p, ["booleanOperation"]);
    if (type === "TRANSFORM_GROUP") props(p, ["transformModifiers"]);
    if (type === "SECTION") props(p, ["sectionContentsHidden"]);
    if (type === "PAGE") {
      props(p, ["selection", "backgrounds", "prototypeBackgrounds", "flowStartingPoints", "selectedTextRange", "prototypeStartNode", "guides"]);
      method(p, "loadAsync", function () { return Promise.resolve(); });
      method(p, "clone", function () { return call("node.clone", this.__nodeId); });
      method(p, "setBackgroundsAsync", function (v) { return Promise.resolve(call("set", this.__nodeId, "backgrounds", v)); });
      props(p, ["isPageDivider"], { readonly: true });
    } else if (type !== "DOCUMENT") {
      method(p, "clone", function () { return call("node.clone", this.__nodeId); });
    }
    if (type === "DOCUMENT") props(p, ["documentColorProfile"], { readonly: true });
    protos[type] = p;
    return p;
  }

  // ---- Events -----------------------------------------------------------------------------------------------------

  var handlers = {};
  var EVENTS = ["run", "close", "selectionchange", "currentpagechange", "documentchange", "drop", "stylechange", "textreview", "slidesviewchange", "canvasviewchange", "timerstart", "timerstop", "timerpause", "timerresume", "timeradjust", "timerdone"];
  function on(type, cb, once) {
    if (EVENTS.indexOf(type) < 0) throw new Error("Invalid event type: " + type);
    if (typeof cb !== "function") throw new TypeError("The handler must be a function");
    (handlers[type] = handlers[type] || []).push({ cb: cb, once: !!once });
    call("events.listen", type, true);
  }
  function off(type, cb) {
    var list = handlers[type] || [];
    handlers[type] = list.filter(function (h) { return h.cb !== cb; });
    if (!handlers[type].length) call("events.listen", type, false);
  }
  function emit(type, ev) {
    var list = (handlers[type] || []).slice();
    var out = [];
    handlers[type] = (handlers[type] || []).filter(function (h) { return !h.once; });
    list.forEach(function (h) {
      try {
        out.push(h.cb(ev));
      } catch (e) {
        console.error(e && e.stack ? e.stack : String(e));
      }
    });
    return out;
  }
  g.__dispatch = function (type, json) {
    var ev = json ? B.decode(json) : undefined;
    if (type === "documentchange" && ev) {
      ev.documentChanges.forEach(function (c) { if (c.node === undefined && c.id) c.node = { id: c.id, removed: true }; });
    }
    if (type === "drop" && ev) {
      ev.files = (ev.files || []).map(function (f) {
        return { name: f.name, type: f.type, getBytesAsync: function () { return Promise.resolve(f.bytes); }, getTextAsync: function () { return Promise.resolve(utf8(f.bytes)); } };
      });
    }
    var results = emit(type, ev);
    if (type === "drop") return results.some(function (r) { return r === false; }) ? "false" : "true";
    return "";
  };

  // ---- UI ---------------------------------------------------------------------------------------------------------

  var uiHandlers = [];
  var ui = {
    onmessage: undefined,
    show: function () { call("ui.show"); },
    hide: function () { call("ui.hide"); },
    resize: function (w, h) { call("ui.resize", w, h); },
    reposition: function (x, y) { call("ui.reposition", x, y); },
    getPosition: function () { return call("ui.getPosition"); },
    close: function () { call("ui.close"); },
    postMessage: function (msg, options) { call("ui.post", msg, options && options.origin ? String(options.origin) : "*"); },
    on: function (type, cb) { if (type === "message") uiHandlers.push({ cb: cb, once: false }); },
    once: function (type, cb) { if (type === "message") uiHandlers.push({ cb: cb, once: true }); },
    off: function (type, cb) { uiHandlers = uiHandlers.filter(function (h) { return h.cb !== cb; }); },
  };
  g.__uiMessage = function (json) {
    var d = B.decode(json);
    if (typeof ui.onmessage === "function") ui.onmessage(d.message, d.props);
    var list = uiHandlers.slice();
    uiHandlers = uiHandlers.filter(function (h) { return !h.once; });
    list.forEach(function (h) { h.cb(d.message, d.props); });
  };

  // ---- Notifications, parameters, codegen ----------------------------------------------------------------------------

  var notices = new Map();
  g.__notice = function (id, what, reason) {
    var n = notices.get(id);
    if (!n) return;
    if (what === "action" && n.button && typeof n.button.action === "function") {
      if (n.button.action() !== false) notices.delete(id);
    } else if (what === "dequeue") {
      notices.delete(id);
      if (typeof n.onDequeue === "function") n.onDequeue(reason);
    }
  };

  var paramHandlers = [];
  g.__parameterInput = function (json) {
    var ev = B.decode(json);
    var result = {
      setSuggestions: function (list) { call("parameters.suggest", ev.request, list); },
      setError: function (message) { call("parameters.error", ev.request, String(message)); },
      setLoadingMessage: function (message) { call("parameters.loading", ev.request, String(message)); },
    };
    paramHandlers.forEach(function (h) { h({ query: ev.query, key: ev.key, parameters: ev.parameters, result: result }); });
  };

  var codegenHandlers = { generate: [], preferenceschange: [] };
  g.__codegen = function (request, json) {
    var ev = B.decode(json);
    var h = codegenHandlers.generate[0];
    if (!h) return void call("codegen.answer", request, null, "This plugin has no generate handler");
    var r;
    try {
      r = h(ev);
    } catch (e) {
      return void call("codegen.answer", request, null, String(e && e.message ? e.message : e));
    }
    Promise.resolve(r).then(
      function (v) { call("codegen.answer", request, v, null); },
      function (e) { call("codegen.answer", request, null, String(e && e.message ? e.message : e)); }
    );
  };
  g.__codegenPreferences = function (json) {
    var ev = B.decode(json);
    codegen.preferences = ev.preferences;
    codegenHandlers.preferenceschange.forEach(function (h) { h(ev.event); });
  };
  var codegen = {
    preferences: info.codegenPreferences || { unit: "PIXEL", scaleFactor: 1, customSettings: {} },
    on: function (type, cb) { if (codegenHandlers[type]) codegenHandlers[type].push(cb); },
    once: function (type, cb) { codegen.on(type, cb); },
    off: function (type, cb) { if (codegenHandlers[type]) codegenHandlers[type] = codegenHandlers[type].filter(function (h) { return h !== cb; }); },
    refresh: function () { call("codegen.refresh"); },
  };

  // ---- Values -------------------------------------------------------------------------------------------------------

  function utf8(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; ) {
      var c = bytes[i++];
      var cp;
      if (c < 0x80) cp = c;
      else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (c < 0xf0) cp = ((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      else cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
  function parseColor(c, alpha) {
    if (c && typeof c === "object") return { r: +c.r, g: +c.g, b: +c.b, a: c.a === undefined ? 1 : +c.a };
    var s = String(c).trim();
    var m = /^#?([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (x) { return x + x; }).join("");
      var n = function (i) { return parseInt(h.slice(i, i + 2), 16) / 255; };
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
    }
    m = /^(?:rgba?|hsla?)\(([^)]*)\)$/i.exec(s);
    if (m && /^rgb/i.test(s)) {
      var parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    if (m) {
      var q = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      var hh = (q[0] % 360) / 360, ss = q[1] / 100, ll = q[2] / 100;
      var k = function (n) { return (n + hh * 12) % 12; };
      var a = ss * Math.min(ll, 1 - ll);
      var f = function (n) { return ll - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
      return { r: f(0), g: f(8), b: f(4), a: q.length > 3 ? q[3] : 1 };
    }
    if (alpha) throw new Error("Invalid color: " + s);
    throw new Error("Invalid color: " + s);
  }

  function image(ref) {
    if (!ref) return null;
    var hash = ref.hash;
    return Object.freeze({
      hash: hash,
      getBytesAsync: function () { return call("image.bytes", hash); },
      getSizeAsync: function () { return call("image.size", hash); },
    });
  }

  // Variables and styles: handles whose fields the host reads and writes.
  function handle(kind, ref, fields, methods) {
    if (!ref) return null;
    var o = {};
    Object.defineProperty(o, "id", { enumerable: true, value: ref.id });
    fields.forEach(function (f) {
      Object.defineProperty(o, f, {
        enumerable: true,
        get: function () { return freeze(call(kind + ".get", ref.id, f)); },
        set: function (v) { call(kind + ".set", ref.id, f, v); },
      });
    });
    Object.keys(methods || {}).forEach(function (m) { Object.defineProperty(o, m, { value: methods[m] }); });
    return Object.freeze(o);
  }
  function variable(ref) {
    return handle("variable", ref, ["name", "description", "hiddenFromPublishing", "scopes", "codeSyntax", "key", "variableCollectionId", "resolvedType", "valuesByMode", "remote"], {
      setValueForMode: function (mode, value) { call("variable.setValue", ref.id, mode, value); },
      remove: function () { call("variable.remove", ref.id); },
      setVariableCodeSyntax: function (platform, value) { call("variable.codeSyntax", ref.id, platform, value); },
      removeVariableCodeSyntax: function (platform) { call("variable.codeSyntax", ref.id, platform, null); },
      resolveForConsumer: function (node) { return call("variable.resolve", ref.id, node); },
      getPublishStatusAsync: function () { return Promise.resolve("UNPUBLISHED"); },
    });
  }
  function collection(ref) {
    return handle("collection", ref, ["name", "hiddenFromPublishing", "modes", "defaultModeId", "variableIds", "key", "remote", "isExtension"], {
      addMode: function (name) { return call("collection.addMode", ref.id, name); },
      renameMode: function (mode, name) { call("collection.renameMode", ref.id, mode, name); },
      removeMode: function (mode) { call("collection.removeMode", ref.id, mode); },
      remove: function () { call("collection.remove", ref.id); },
      extend: notSupported("extend"),
      getPublishStatusAsync: function () { return Promise.resolve("UNPUBLISHED"); },
    });
  }
  function style(ref) {
    if (!ref) return null;
    var fields = ["name", "description", "type", "key", "remote", "documentationLinks"];
    if (ref.type === "PAINT") fields.push("paints");
    if (ref.type === "TEXT") fields.push("fontName", "fontSize", "letterSpacing", "lineHeight", "paragraphIndent", "paragraphSpacing", "textCase", "textDecoration", "listSpacing", "leadingTrim");
    if (ref.type === "EFFECT") fields.push("effects");
    if (ref.type === "GRID") fields.push("layoutGrids");
    return handle("style", ref, fields, {
      remove: function () { call("style.remove", ref.id); },
      getStyleConsumersAsync: function () { return Promise.resolve([]); },
      getPublishStatusAsync: function () { return Promise.resolve("UNPUBLISHED"); },
    });
  }
  var asyncOf = function (v) { return Promise.resolve(v); };

  // ---- figma ----------------------------------------------------------------------------------------------------------

  var figma = {};
  function value(name, v) { Object.defineProperty(figma, name, { value: v, enumerable: true }); }
  function getter(name, get, set) { Object.defineProperty(figma, name, { get: get, set: set, enumerable: true }); }

  value("apiVersion", info.apiVersion);
  value("command", info.command);
  value("pluginId", info.pluginId);
  value("editorType", info.editorType);
  value("mode", info.mode);
  value("mixed", MIXED);
  if (info.fileKey !== undefined) value("fileKey", info.fileKey);
  getter("root", function () { return call("root"); });
  getter("currentPage", function () { return call("page.current"); }, function (page) {
    if (dynamicPage) throw new Error("Cannot set figma.currentPage with documentAccess: dynamic-page. Use figma.setCurrentPageAsync instead.");
    call("page.set", page);
  });
  getter("skipInvisibleInstanceChildren", function () { return call("flags.get", "skipInvisibleInstanceChildren"); }, function (v) { call("flags.set", "skipInvisibleInstanceChildren", !!v); });
  getter("hasMissingFont", function () { return call("fonts.missing"); });
  getter("currentUser", function () { return freeze(call("users.current")); });
  getter("activeUsers", function () { return freeze(call("users.active")); });
  value("setCurrentPageAsync", function (page) { call("page.set", page); return Promise.resolve(); });
  value("loadAllPagesAsync", function () { return Promise.resolve(); });
  value("closePlugin", function (message) { call("close", message === undefined ? null : String(message)); });
  value("notify", function (message, options) {
    options = options || {};
    var id = call("notify", String(message), { timeout: options.timeout, error: !!options.error, button: options.button ? String(options.button.text) : null });
    notices.set(id, { button: options.button, onDequeue: options.onDequeue });
    return { cancel: function () { call("notify.cancel", id); } };
  });
  value("commitUndo", function () { call("undo.commit"); });
  value("triggerUndo", function () { call("undo.trigger"); });
  value("saveVersionHistoryAsync", function (title, description) { return call("version.save", String(title), description === undefined ? "" : String(description)); });
  value("openExternal", function (url) { call("openExternal", String(url)); });
  value("showUI", function (html, options) { call("ui.open", String(html), options || {}); });
  value("ui", ui);
  value("getNodeById", function (id) {
    if (dynamicPage) throw new Error("Cannot call figma.getNodeById with documentAccess: dynamic-page. Use figma.getNodeByIdAsync instead.");
    return call("node.byId", String(id));
  });
  value("getNodeByIdAsync", function (id) { return asyncOf(call("node.byId", String(id))); });
  value("getStyleById", function (id) {
    if (dynamicPage) throw new Error("Cannot call figma.getStyleById with documentAccess: dynamic-page. Use figma.getStyleByIdAsync instead.");
    return style(call("styles.byId", String(id)));
  });
  value("getStyleByIdAsync", function (id) { return asyncOf(style(call("styles.byId", String(id)))); });
  value("getFileThumbnailNode", function () {
    if (dynamicPage) throw new Error("Cannot call figma.getFileThumbnailNode with documentAccess: dynamic-page. Use figma.getFileThumbnailNodeAsync instead.");
    return call("file.thumbnail");
  });
  value("getFileThumbnailNodeAsync", function () { return asyncOf(call("file.thumbnail")); });
  value("setFileThumbnailNodeAsync", function (node) { return asyncOf(call("file.setThumbnail", node)); });
  value("getSelectionColors", function () { return freeze(call("selection.colors")); });
  value("base64Encode", function (bytes) { return B.b64enc(bytes); });
  value("base64Decode", function (s) { return B.b64dec(s); });
  value("fetch", function (url, init) {
    return call("fetch", String(url), init || null).then(function (r) {
      var body = r.body || new Uint8Array(0);
      return {
        headersObject: r.headers,
        ok: r.status >= 200 && r.status < 300,
        redirected: !!r.redirected,
        status: r.status,
        statusText: r.statusText,
        type: "basic",
        url: r.url || String(url),
        arrayBuffer: function () { return Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)); },
        text: function () { return Promise.resolve(utf8(body)); },
        json: function () { return Promise.resolve(JSON.parse(utf8(body))); },
      };
    });
  });
  g.fetch = figma.fetch;

  // Creating nodes
  var CREATE = { createRectangle: "RECTANGLE", createLine: "LINE", createEllipse: "ELLIPSE", createPolygon: "POLYGON", createStar: "STAR", createVector: "VECTOR", createText: "TEXT", createFrame: "FRAME", createComponent: "COMPONENT", createSection: "SECTION", createSlice: "SLICE", createBooleanOperation: "BOOLEAN_OPERATION" };
  Object.keys(CREATE).forEach(function (name) { value(name, function () { return call("create", CREATE[name]); }); });
  value("createPage", function () { return call("create", "PAGE"); });
  value("createComponentFromNode", function (node) { return call("createComponentFromNode", node); });
  value("createNodeFromSvg", function (svg) { return call("createNodeFromSvg", String(svg)); });
  value("createImage", function (bytes) { return image(call("image.create", bytes)); });
  value("createImageAsync", function (url) { return call("image.fromUrl", String(url)).then(image); });
  value("getImageByHash", function (hash) { return image(call("image.byHash", String(hash))); });
  value("combineAsVariants", function (nodes, parent, index) { return call("combineAsVariants", nodes, parent, index === undefined ? -1 : index); });
  value("group", function (nodes, parent, index) { return call("group", nodes, parent, index === undefined ? -1 : index); });
  value("ungroup", function (node) { return call("ungroup", node); });
  value("flatten", function (nodes, parent, index) { return call("flatten", nodes, parent || null, index === undefined ? -1 : index); });
  // Draw (docs/draw.md §7; Figma's Update 123)
  value("createTextPath", function (node, startSegment, startPosition) { return call("createTextPath", node, startSegment, startPosition); });
  value("transformGroup", function (nodes, parent, index, modifiers) { return call("transformGroup", nodes, parent, index === undefined ? -1 : index, modifiers || []); });
  value("loadBrushesAsync", function (brushType) { return call("brushes.load", brushType); });
  ["union", "subtract", "intersect", "exclude"].forEach(function (op) {
    value(op, function (nodes, parent, index) { return call("boolean", op.toUpperCase(), nodes, parent, index === undefined ? -1 : index); });
  });

  // Viewport
  var viewport = {};
  Object.defineProperty(viewport, "center", { enumerable: true, get: function () { return call("viewport.get").center; }, set: function (c) { call("viewport.set", { center: c }); } });
  Object.defineProperty(viewport, "zoom", { enumerable: true, get: function () { return call("viewport.get").zoom; }, set: function (z) { call("viewport.set", { zoom: z }); } });
  Object.defineProperty(viewport, "bounds", { enumerable: true, get: function () { return freeze(call("viewport.get").bounds); } });
  viewport.scrollAndZoomIntoView = function (nodes) { call("viewport.scrollTo", nodes); };
  value("viewport", Object.freeze(viewport));

  // Client storage
  value("clientStorage", Object.freeze({
    getAsync: function (key) { return call("storage", "get", String(key)); },
    setAsync: function (key, v) { return call("storage", "set", String(key), v); },
    deleteAsync: function (key) { return call("storage", "delete", String(key)); },
    keysAsync: function () { return call("storage", "keys"); },
  }));

  // Fonts
  value("loadFontAsync", function (font) { return call("fonts.load", font); });
  value("listAvailableFontsAsync", function () { return call("fonts.list"); });

  // Styles
  value("getLocalPaintStylesAsync", function () { return asyncOf(call("styles.local", "PAINT").map(style)); });
  value("getLocalTextStylesAsync", function () { return asyncOf(call("styles.local", "TEXT").map(style)); });
  value("getLocalEffectStylesAsync", function () { return asyncOf(call("styles.local", "EFFECT").map(style)); });
  value("getLocalGridStylesAsync", function () { return asyncOf(call("styles.local", "GRID").map(style)); });
  ["Paint", "Text", "Effect", "Grid"].forEach(function (k) {
    value("getLocal" + k + "Styles", function () {
      if (dynamicPage) throw new Error("Cannot call figma.getLocal" + k + "Styles with documentAccess: dynamic-page. Use figma.getLocal" + k + "StylesAsync instead.");
      return call("styles.local", k.toUpperCase()).map(style);
    });
    value("create" + k + "Style", function () { return style(call("styles.create", k.toUpperCase())); });
    value("moveLocal" + k + "StyleAfter", function (target, reference) { call("styles.moveAfter", target && target.id, reference ? reference.id : null); });
    value("moveLocal" + k + "Folder" + "After", notSupported("moveLocal" + k + "FolderAfter"));
  });
  value("importStyleByKeyAsync", function (key) { return call("library.importStyle", String(key)).then(style); });
  value("importComponentByKeyAsync", function (key) { return call("library.importComponent", String(key)); });
  value("importComponentSetByKeyAsync", function (key) { return call("library.importComponent", String(key)); });

  // Variables
  value("variables", Object.freeze({
    getVariableById: function (id) {
      if (dynamicPage) throw new Error("Cannot call figma.variables.getVariableById with documentAccess: dynamic-page. Use figma.variables.getVariableByIdAsync instead.");
      return variable(call("variables.byId", String(id)));
    },
    getVariableByIdAsync: function (id) { return asyncOf(variable(call("variables.byId", String(id)))); },
    getVariableCollectionById: function (id) {
      if (dynamicPage) throw new Error("Cannot call figma.variables.getVariableCollectionById with documentAccess: dynamic-page. Use figma.variables.getVariableCollectionByIdAsync instead.");
      return collection(call("collections.byId", String(id)));
    },
    getVariableCollectionByIdAsync: function (id) { return asyncOf(collection(call("collections.byId", String(id)))); },
    getLocalVariablesAsync: function (type) { return asyncOf(call("variables.local", type || null).map(variable)); },
    getLocalVariableCollectionsAsync: function () { return asyncOf(call("collections.local").map(collection)); },
    getLocalVariables: function (type) { return call("variables.local", type || null).map(variable); },
    getLocalVariableCollections: function () { return call("collections.local").map(collection); },
    createVariable: function (name, coll, type) { return variable(call("variables.create", String(name), coll && coll.id ? coll.id : coll, type)); },
    createVariableCollection: function (name) { return collection(call("collections.create", String(name))); },
    extendLibraryCollectionByKeyAsync: notSupported("extendLibraryCollectionByKeyAsync"),
    createVariableAlias: function (v) { return { type: "VARIABLE_ALIAS", id: v.id }; },
    createVariableAliasByIdAsync: function (id) { return Promise.resolve({ type: "VARIABLE_ALIAS", id: String(id) }); },
    setBoundVariableForPaint: function (paint, field, v) {
      var copy = JSON.parse(JSON.stringify(paint));
      copy.boundVariables = Object.assign({}, copy.boundVariables);
      if (v) copy.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id };
      else delete copy.boundVariables[field];
      return copy;
    },
    setBoundVariableForEffect: function (effect, field, v) {
      var copy = JSON.parse(JSON.stringify(effect));
      copy.boundVariables = Object.assign({}, copy.boundVariables);
      if (v) copy.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id };
      else delete copy.boundVariables[field];
      return copy;
    },
    setBoundVariableForLayoutGrid: function (grid, field, v) {
      var copy = JSON.parse(JSON.stringify(grid));
      copy.boundVariables = Object.assign({}, copy.boundVariables);
      if (v) copy.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id };
      else delete copy.boundVariables[field];
      return copy;
    },
    importVariableByKeyAsync: function (key) { return call("library.importVariable", String(key)).then(variable); },
  }));
  value("teamLibrary", Object.freeze({
    getAvailableLibraryVariableCollectionsAsync: function () { return call("library.collections"); },
    getVariablesInLibraryCollectionAsync: function (key) { return call("library.variables", String(key)); },
  }));
  value("annotations", Object.freeze({
    getAnnotationCategoriesAsync: function () { return call("annotations.categories"); },
    addAnnotationCategoryAsync: function (c) { return call("annotations.addCategory", c); },
    getAnnotationCategoryByIdAsync: function (id) { return call("annotations.categories").then(function (list) { return list.filter(function (x) { return x.id === id; })[0] || null; }); },
  }));

  // Utilities
  value("util", Object.freeze({
    rgb: function (c) { var x = parseColor(c); return { r: x.r, g: x.g, b: x.b }; },
    rgba: function (c) { return parseColor(c, true); },
    solidPaint: function (c, overrides) {
      var x = parseColor(c);
      return Object.assign({ type: "SOLID", color: { r: x.r, g: x.g, b: x.b }, opacity: x.a, visible: true, blendMode: "NORMAL" }, overrides || {});
    },
    normalizeMarkdown: function (md) { return String(md); },
  }));
  value("constants", Object.freeze({ colors: Object.freeze({ figJamBase: Object.freeze({}), figJamBaseLight: Object.freeze({}) }) }));
  value("parameters", Object.freeze({
    on: function (type, cb) { if (type === "input") paramHandlers.push(cb); },
    once: function (type, cb) { if (type === "input") paramHandlers.push(cb); },
    off: function (type, cb) { paramHandlers = paramHandlers.filter(function (h) { return h !== cb; }); },
  }));
  value("codegen", codegen);
  value("devResources", Object.freeze({
    on: notSupported("figma.devResources"),
    off: notSupported("figma.devResources"),
  }));
  value("on", function (type, cb) { on(type, cb, false); });
  value("once", function (type, cb) { on(type, cb, true); });
  value("off", off);

  // Later (docs/plugins.md §5): each throws Figma-style when used.
  ["payments", "timer", "buzz", "textreview", "vscode", "motion", "widget", "slides"].forEach(function (name) {
    Object.defineProperty(figma, name, { enumerable: false, get: function () { throw new Error("figma." + name + " is not supported in Designer yet"); } });
  });
  ["createNodeFromJSXAsync", "createVideoAsync", "createSticky", "createConnector", "createShapeWithText", "createTable", "createCodeBlock", "createGif", "createLinkPreviewAsync", "createSlide", "createSlideRow", "createPageDivider", "createTransformGroup"].forEach(function (name) {
    value(name, notSupported(name));
  });

  Object.freeze(figma);
  Object.defineProperty(g, "figma", { value: figma, enumerable: true });
  if (info.html !== undefined) Object.defineProperty(g, "__html__", { value: info.html, enumerable: false });
  if (info.uiFiles !== undefined) Object.defineProperty(g, "__uiFiles__", { value: Object.freeze(info.uiFiles), enumerable: false });
})();
