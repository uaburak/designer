// Code Connect's template API inside the plugin VM (docs/editor.md D-1 "Snippets in Inspect"; Figma's template API,
// developers.figma.com/docs/code-connect/template-api/). Evaluated after the bridge in a `createSandbox({kind:
// "template"})`; the host then calls `__ccRun(payload)` once and disposes the VM. Plain ES2020, no imports.
//
// The payload is a snapshot of the selected instance read from the engine (codeConnect.ts `snapshotOf`), so the
// templates never call back into the host:
//   {root: Node, templates: {[key]: {template, batch, nestable, component, label}}, language}
//   Node = {id, name, type, visible, text?, children: Node[], props?: {[name]: {type, value, layer}}, mapping?: key,
//           mainName?}
// It answers {sections, imports, metadata, id} — sections are Figma's: {type: "CODE", code} | {type: "INSTANCE",
// guid, name} (a pill: a nested instance whose template says `nestable: false`) | {type: "ERROR", message} — or
// {error: {type, message}} with Figma's error names.
(function () {
  "use strict";
  var g = globalThis;

  function ccError(type, message) {
    var e = new Error(message);
    e.ccType = type;
    return e;
  }

  function sections(list) {
    // Adjacent code merges, so the host sees one CODE section per run of text.
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var last = out[out.length - 1];
      if (s.type === "CODE" && last && last.type === "CODE") out[out.length - 1] = { type: "CODE", code: last.code + s.code };
      else if (s.type !== "CODE" || s.code !== "") out.push(s);
    }
    return { __cc: "sections", sections: out };
  }

  function indentSections(list, indent) {
    if (!indent) return list;
    return list.map(function (s) {
      return s.type === "CODE" ? { type: "CODE", code: s.code.split("\n").join("\n" + indent) } : s;
    });
  }

  var state = null;

  // ---- Interpolation ------------------------------------------------------------------------------------------------

  function wrapperCode(w) {
    switch (w.__wrap) {
      case "templateString":
        return "`" + w.value + "`";
      case "object":
        return stringifyObject(w.value);
      case "array":
        return "[" + w.value.map(renderPropValue).join(", ") + "]";
      default:
        return String(w.value);
    }
  }

  function push(v, out, indent) {
    if (v === undefined || v === null || v === false) return;
    if (typeof v === "string" || typeof v === "number") return void out.push({ type: "CODE", code: String(v) });
    if (v === true) return void out.push({ type: "CODE", code: "true" });
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) {
        if (i > 0) out.push({ type: "CODE", code: "\n" + (indent || "") });
        push(v[i], out, indent);
      }
      return;
    }
    if (typeof v === "object") {
      if (v.__cc === "sections") return void Array.prototype.push.apply(out, indentSections(v.sections, indent));
      if (v.__handle === "instance") return push(v.executeTemplate().example, out, indent);
      if (v.__handle === "slot") return push(v.connectedInstances.map(function (h) { return h.executeTemplate().example; }), out, indent);
      if (v.__handle === "text") return void out.push({ type: "CODE", code: v.textContent });
      if (v.__handle === "error") throw v.__error;
      if (v.__wrap) return void out.push({ type: "CODE", code: wrapperCode(v) });
      if (v.example !== undefined && v.metadata !== undefined) return push(v.example, out, indent);
    }
    out.push({ type: "CODE", code: String(v) });
  }

  /** The whitespace that starts the line `text` ends on (nested code is indented to it, as Figma's). */
  function lineIndent(text) {
    var line = text.slice(text.lastIndexOf("\n") + 1);
    var m = /^[ \t]*/.exec(line);
    return m ? m[0] : "";
  }

  function code(strings) {
    var out = [];
    var sofar = "";
    for (var i = 0; i < strings.length; i++) {
      out.push({ type: "CODE", code: strings[i] });
      sofar += strings[i];
      if (i + 1 < arguments.length) {
        var at = out.length;
        push(arguments[i + 1], out, lineIndent(sofar));
        for (var k = at; k < out.length; k++) if (out[k].type === "CODE") sofar += out[k].code;
      }
    }
    return sections(out);
  }

  // ---- Helpers (figma.helpers) -------------------------------------------------------------------------------------

  function isCode(v) {
    return v && typeof v === "object" && (v.__cc === "sections" || v.__handle === "instance" || v.__handle === "slot");
  }

  function renderPropValue(v) {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === undefined || v === null) return "undefined";
    if (v.__wrap) return wrapperCode(v);
    if (Array.isArray(v)) return "[" + v.map(renderPropValue).join(", ") + "]";
    if (typeof v === "object" && !isCode(v)) return stringifyObject(v);
    return String(v);
  }

  function stringifyObject(o) {
    var keys = Object.keys(o || {});
    if (!keys.length) return "{}";
    return "{ " + keys.map(function (k) { return (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ": " + renderPropValue(o[k]); }).join(", ") + " }";
  }

  var react = {
    renderProp: function (name, prop) {
      if (prop === undefined || prop === null || prop === false) return "";
      if (prop === true) return " " + name;
      if (typeof prop === "string") return prop.indexOf('"') >= 0 ? " " + name + "={" + JSON.stringify(prop) + "}" : " " + name + '="' + prop + '"';
      if (typeof prop === "number") return " " + name + "={" + prop + "}";
      if (isCode(prop) || Array.isArray(prop)) return code([" " + name + "={", "}"], prop);
      if (prop.__wrap === "jsxElement" || prop.__wrap === "function" || prop.__wrap === "identifier") return " " + name + "={" + prop.value + "}";
      return " " + name + "={" + renderPropValue(prop) + "}";
    },
    renderChildren: function (prop) {
      if (prop === undefined || prop === null || typeof prop === "boolean") return "";
      if (typeof prop === "string" || typeof prop === "number") return String(prop);
      return prop;
    },
    renderPropValue: renderPropValue,
    stringifyObject: stringifyObject,
    isReactComponentArray: function (p) {
      return Array.isArray(p) && p.every(isCode);
    },
    jsxElement: function (v) { return { __wrap: "jsxElement", value: v }; },
    function: function (v) { return { __wrap: "function", value: v }; },
    identifier: function (v) { return { __wrap: "identifier", value: v }; },
    object: function (v) { return { __wrap: "object", value: v }; },
    templateString: function (v) { return { __wrap: "templateString", value: v }; },
    reactComponent: function (v) { return { __wrap: "identifier", value: v }; },
    array: function (v) { return { __wrap: "array", value: v }; },
  };

  function renderChildrenWith(prefix) {
    return function (children, pre) {
      var p = pre === undefined ? prefix : pre;
      var list = Array.isArray(children) ? children : children === undefined || children === null ? [] : [children];
      var out = [];
      list.forEach(function (c, i) {
        if (i > 0) out.push({ type: "CODE", code: "\n" });
        out.push({ type: "CODE", code: p });
        push(c, out, p);
      });
      return sections(out);
    };
  }

  // ---- Handles --------------------------------------------------------------------------------------------------------

  function errorHandle(type, message) {
    return { __handle: "error", __error: ccError(type, message), type: "ERROR", textContent: undefined };
  }

  function propOf(n, name, type) {
    var props = n.props || {};
    var p = props[name];
    if (!p && typeof name === "string" && name.indexOf("#") > 0) p = props[name.slice(0, name.lastIndexOf("#"))];
    if (!p) throw ccError("PROPERTY_NOT_FOUND", "Property \"" + name + "\" not found on " + n.name);
    if (type && p.type !== type) throw ccError("PROPERTY_TYPE_MISMATCH", "Property \"" + name + "\" on " + n.name + " is " + p.type + ", not " + type);
    return p;
  }

  /** The layers under `n` (and, with traverseInstances, inside its nested instances), each with its ancestors' names. */
  function descendants(n, opts) {
    var out = [];
    var walk = function (node, path) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        out.push({ node: c, path: path });
        if (c.type !== "INSTANCE" || (opts && opts.traverseInstances)) walk(c, path.concat([c.name]));
      }
    };
    walk(n, []);
    if (opts && opts.path && opts.path.length) {
      var want = opts.path;
      out = out.filter(function (d) {
        if (d.path.length < want.length) return false;
        var tail = d.path.slice(d.path.length - want.length);
        return tail.every(function (x, i) { return x === want[i]; });
      });
    }
    return out.map(function (d) { return d.node; });
  }

  function handleOf(n) {
    if (n.type === "INSTANCE") return instanceHandle(n);
    if (n.type === "TEXT") return { __handle: "text", type: "TEXT", id: n.id, name: n.name, textContent: n.text || "" };
    return null;
  }

  var handles = {};

  function instanceHandle(n) {
    if (handles[n.id]) return handles[n.id];
    var h = { __handle: "instance", type: "INSTANCE", id: n.id, name: n.name };
    var props = {};
    Object.keys(n.props || {}).forEach(function (k) {
      var p = n.props[k];
      props[k] = p.type === "INSTANCE_SWAP" ? (state.byId[p.layer] ? instanceHandle(state.byId[p.layer]) : null) : p.value;
    });
    h.properties = props;
    h.getString = function (name) { return String(propOf(n, name, "TEXT").value); };
    h.getBoolean = function (name, map) {
      var v = !!propOf(n, name, "BOOL").value;
      return map ? map[v ? "true" : "false"] : v;
    };
    h.getEnum = function (name, map) {
      var v = propOf(n, name, "VARIANT").value;
      return map ? map[v] : v;
    };
    h.getInstanceSwap = function (name) {
      var p = propOf(n, name, "INSTANCE_SWAP");
      var target = p.layer && state.byId[p.layer];
      if (!target) return errorHandle("CHILD_LAYER_NOT_FOUND", "The instance swapped in for \"" + name + "\" isn't in " + n.name);
      return instanceHandle(target);
    };
    h.getSlot = function (name) {
      var props = n.props || {};
      var p = props[name];
      if (!p || p.type !== "SLOT") return undefined;
      var slot = p.layer && state.byId[p.layer];
      if (!slot) return undefined;
      return {
        __handle: "slot",
        connectedInstances: slot.children
          .filter(function (c) { return c.type === "INSTANCE" && c.mapping; })
          .map(instanceHandle),
      };
    };
    h.getPropertyValue = function (name) {
      var p = propOf(n, name);
      return p.type === "INSTANCE_SWAP" ? p.value : p.value;
    };
    h.executeTemplate = function () { return execute(n); };
    h.hasCodeConnect = function () { return !!n.mapping; };
    h.codeConnectId = function () {
      if (!n.mapping) return null;
      var r = run(n);
      return r.id !== undefined && r.id !== null ? String(r.id) : null;
    };
    h.findText = function (name, opts) {
      var hit = descendants(n, opts).filter(function (c) { return c.type === "TEXT" && c.name === name; })[0];
      return hit ? handleOf(hit) : errorHandle("CHILD_LAYER_NOT_FOUND", "No text layer \"" + name + "\" in " + n.name);
    };
    h.findInstance = function (name, opts) {
      var hit = descendants(n, opts).filter(function (c) { return c.type === "INSTANCE" && c.name === name; })[0];
      return hit ? instanceHandle(hit) : errorHandle("CHILD_LAYER_NOT_FOUND", "No instance \"" + name + "\" in " + n.name);
    };
    h.findConnectedInstance = function (id, opts) {
      var hit = descendants(n, opts).filter(function (c) { return c.type === "INSTANCE" && c.mapping && instanceHandle(c).codeConnectId() === id; })[0];
      return hit ? instanceHandle(hit) : errorHandle("CHILD_LAYER_NOT_FOUND", "No instance connected as \"" + id + "\" in " + n.name);
    };
    h.findConnectedInstances = function (selector, opts) {
      return descendants(n, opts)
        .filter(function (c) { return c.type === "INSTANCE" && c.mapping; })
        .map(instanceHandle)
        .filter(function (x) { return !selector || selector(x); });
    };
    h.findLayers = function (selector, opts) {
      return descendants(n, opts)
        .map(handleOf)
        .filter(function (x) { return x && (!selector || selector(x)); });
    };
    // Figma's legacy names
    h.__properties__ = {
      boolean: h.getBoolean,
      enum: h.getEnum,
      string: h.getString,
      instance: function (name) { return h.getInstanceSwap(name); },
      __instance__: function (name) { return h.getInstanceSwap(name); },
    };
    h.children = n.children.map(handleOf).filter(Boolean);
    handles[n.id] = h;
    return h;
  }

  // ---- Running templates --------------------------------------------------------------------------------------------

  /** A stored template (our CLI's form, Figma's ESM, or CommonJS) as a function of `figma`. */
  function compile(src) {
    var body = String(src)
      .replace(/^\s*import\s+figma\s*(?:,\s*\{[^}]*\})?\s+from\s+["']figma["'];?/gm, "")
      .replace(/^\s*(?:const|let|var)\s+figma\s*=\s*require\(\s*["']figma["']\s*\);?/gm, "")
      .replace(/\bexport\s+default\s+/, "__codeConnectResult = ");
    return new Function(
      "figma",
      "require",
      "module",
      "exports",
      "var __codeConnectResult;\n" + body + "\n;return __codeConnectResult !== undefined ? __codeConnectResult : module.exports && module.exports.default !== undefined ? module.exports.default : module.exports;"
    );
  }

  var compiled = {};
  var results = {};

  function run(n) {
    if (results[n.id]) return results[n.id];
    var t = state.templates[n.mapping];
    var prev = { selectedInstance: figma.selectedInstance, batch: figma.batch };
    figma.selectedInstance = instanceHandle(n);
    figma.currentLayer = figma.selectedInstance;
    figma.properties = figma.selectedInstance.__properties__;
    figma.batch = t.batch || undefined;
    var r;
    try {
      var fn = compiled[n.mapping] || (compiled[n.mapping] = compile(t.template));
      var module = { exports: {} };
      r = fn(figma, function (m) {
        if (m === "figma") return figma;
        throw ccError("TEMPLATE_EXECUTION_ERROR", "Templates can only import figma (" + m + ")");
      }, module, module.exports);
    } finally {
      figma.selectedInstance = prev.selectedInstance;
      figma.currentLayer = prev.selectedInstance;
      figma.properties = prev.selectedInstance ? prev.selectedInstance.__properties__ : undefined;
      figma.batch = prev.batch;
    }
    if (!r || typeof r !== "object") throw ccError("TEMPLATE_EXECUTION_ERROR", "The template's default export isn't an object");
    var example = r.example;
    var list = [];
    push(example, list, "");
    var out = { sections: sections(list).sections, imports: Array.isArray(r.imports) ? r.imports.map(String) : [], metadata: r.metadata || {}, id: r.id };
    results[n.id] = out;
    return out;
  }

  function placeholder(n) {
    var name = n.mainName || n.name;
    return state.language === "swift" || state.language === "kotlin" ? name.replace(/[^A-Za-z0-9_]/g, "") + "()" : "<" + name.replace(/[^A-Za-z0-9_.]/g, "") + " />";
  }

  /** executeTemplate(): the instance's snippet as its parent interpolates it — inline, a pill, or an error section. */
  function execute(n) {
    if (!n.mapping) return { example: sections([{ type: "CODE", code: placeholder(n) }]), metadata: {} };
    var r;
    try {
      r = run(n);
    } catch (e) {
      if (n === state.root) throw e;
      return { example: sections([{ type: "ERROR", message: (e && e.message) || String(e) }]), metadata: {} };
    }
    if (n !== state.root) {
      r.imports.forEach(function (i) { state.imports.push(i); });
      var t = state.templates[n.mapping];
      var nestable = r.metadata.nestable !== undefined ? r.metadata.nestable !== false : t.nestable !== false;
      if (!nestable) return { example: sections([{ type: "INSTANCE", guid: n.id, name: t.component || n.mainName || n.name }]), metadata: r.metadata };
    }
    return { example: sections(r.sections), metadata: r.metadata };
  }

  var figma = {
    selectedInstance: undefined,
    currentLayer: undefined,
    properties: undefined,
    batch: undefined,
    code: code,
    tsx: code,
    html: code,
    swift: code,
    kotlin: code,
    helpers: { react: react, swift: { renderChildren: renderChildrenWith("") }, kotlin: { renderChildren: renderChildrenWith("") } },
  };

  g.__ccRun = function (payload) {
    state = { root: payload.root, templates: payload.templates || {}, language: payload.language || "", byId: {}, imports: [] };
    handles = {};
    results = {};
    compiled = {};
    var index = function (n) {
      state.byId[n.id] = n;
      n.children.forEach(index);
    };
    index(payload.root);
    try {
      var r = run(payload.root);
      var seen = {};
      var imports = r.imports.concat(state.imports).filter(function (i) {
        if (seen[i]) return false;
        seen[i] = true;
        return true;
      });
      return { sections: r.sections, imports: imports, metadata: r.metadata, id: r.id === undefined ? null : r.id };
    } catch (e) {
      return { error: { type: (e && e.ccType) || "TEMPLATE_EXECUTION_ERROR", message: (e && e.message) || String(e) } };
    }
  };
})();
