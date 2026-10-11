// The VM side of the plugin host's bridge (docs/plugins.md §3.1), evaluated first in every plugin VM (QuickJS, or the
// developer VM's Worker) and in Code Connect templates. Plain ES2020, no imports: it is the VM's own code.
//
// The host gives one global, `__hostCall(op, json) → json` (synchronous). Values travel as JSON; a Uint8Array as
// {"$u8": base64}, figma.mixed as {"$mixed": 1}. An answer is {"ok": value} | {"err": message, "name"?} |
// {"async": id} — the last settles later through `__settle(id, json)`. A node travels as {"$node": id, "$type": type}
// (the next script revives it into its handle). Timers fire through `__timer(id)`.
// The bridge leaves `__bridge` for the next script (the figma API or a template's API), which takes it off the global.
(function () {
  "use strict";
  var g = globalThis;
  var hostCall = g.__hostCall;
  delete g.__hostCall;
  var MIXED = Symbol("figma.mixed");
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64enc(u8) {
    var out = "";
    var i = 0;
    for (; i + 2 < u8.length; i += 3) {
      var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < u8.length) {
      var rest = u8.length - i;
      var m = (u8[i] << 16) | (rest > 1 ? u8[i + 1] << 8 : 0);
      out += B64[(m >> 18) & 63] + B64[(m >> 12) & 63] + (rest > 1 ? B64[(m >> 6) & 63] : "=") + "=";
    }
    return out;
  }

  function b64dec(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, "");
    var len = Math.floor((s.length * 3) / 4);
    var out = new Uint8Array(len);
    var o = 0;
    for (var i = 0; i < s.length; i += 4) {
      var a = B64.indexOf(s[i]);
      var b = B64.indexOf(s[i + 1]);
      var c = i + 2 < s.length ? B64.indexOf(s[i + 2]) : 0;
      var d = i + 3 < s.length ? B64.indexOf(s[i + 3]) : 0;
      var n = (a << 18) | (b << 12) | (c << 6) | d;
      if (o < len) out[o++] = (n >> 16) & 255;
      if (o < len && i + 2 < s.length) out[o++] = (n >> 8) & 255;
      if (o < len && i + 3 < s.length) out[o++] = n & 255;
    }
    return o === len ? out : out.subarray(0, o);
  }

  function encode(v) {
    return JSON.stringify(v === undefined ? null : v, function (_k, x) {
      if (x instanceof Uint8Array) return { $u8: b64enc(x) };
      if (x === MIXED) return { $mixed: 1 };
      if (typeof x === "symbol" || typeof x === "function") return undefined;
      if (x && typeof x === "object" && typeof x.__nodeId === "string") return { $node: x.__nodeId };
      if (x instanceof Map) return Array.from(x.entries());
      if (x instanceof Set) return Array.from(x);
      return x;
    });
  }

  var reviveNode = null;
  function decode(s) {
    return JSON.parse(s, function (_k, x) {
      if (x && typeof x === "object" && !Array.isArray(x)) {
        if (typeof x.$u8 === "string") return b64dec(x.$u8);
        if (x.$mixed === 1) return MIXED;
        if (typeof x.$node === "string" && reviveNode) return reviveNode(x.$node, x.$type);
      }
      return x;
    });
  }

  var pending = new Map();
  function call(op) {
    var args = Array.prototype.slice.call(arguments, 1);
    var answer = decode(hostCall(op, encode(args)));
    if (answer && Object.prototype.hasOwnProperty.call(answer, "ok")) return answer.ok;
    if (answer && typeof answer.async === "number") {
      return new Promise(function (resolve, reject) {
        pending.set(answer.async, { resolve: resolve, reject: reject });
      });
    }
    var e = new Error(answer && answer.err ? answer.err : "The host refused " + op);
    if (answer && answer.name) e.name = answer.name;
    throw e;
  }

  g.__settle = function (id, json) {
    var p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    var a = decode(json);
    if (a && Object.prototype.hasOwnProperty.call(a, "ok")) p.resolve(a.ok);
    else {
      var e = new Error(a && a.err ? a.err : "failed");
      if (a && a.name) e.name = a.name;
      p.reject(e);
    }
  };

  // Timers: the host keeps the clock; the VM keeps the callbacks.
  var timers = new Map();
  function addTimer(fn, ms, repeat, args) {
    if (typeof fn !== "function") throw new TypeError("The callback must be a function");
    var id = call("timer.set", Math.max(0, Number(ms) || 0), repeat);
    timers.set(id, { fn: fn, args: args, repeat: repeat });
    return id;
  }
  g.setTimeout = function (fn, ms) {
    return addTimer(fn, ms, false, Array.prototype.slice.call(arguments, 2));
  };
  g.setInterval = function (fn, ms) {
    return addTimer(fn, ms, true, Array.prototype.slice.call(arguments, 2));
  };
  g.clearTimeout = g.clearInterval = function (id) {
    if (!timers.has(id)) return;
    timers.delete(id);
    call("timer.clear", id);
  };
  g.__timer = function (id) {
    var t = timers.get(id);
    if (!t) return;
    if (!t.repeat) timers.delete(id);
    t.fn.apply(undefined, t.args);
  };

  // A minimal console (Figma's: the messages go to the developer's console).
  function show(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
    try {
      var s = encode(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }
  var consoleObj = {};
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    consoleObj[level] = function () {
      call("console", level, Array.prototype.map.call(arguments, show));
    };
  });
  consoleObj.clear = function () {};
  consoleObj.assert = function (ok) {
    if (!ok) consoleObj.error.apply(null, ["Assertion failed"].concat(Array.prototype.slice.call(arguments, 1)));
  };
  g.console = consoleObj;

  if (typeof g.structuredClone !== "function") {
    g.structuredClone = function clone(v) {
      if (v === null || typeof v !== "object") {
        if (typeof v === "function" || typeof v === "symbol") throw new Error("DataCloneError: " + String(v) + " could not be cloned.");
        return v;
      }
      if (v instanceof Uint8Array || v instanceof Float32Array || v instanceof Int32Array || v instanceof Uint16Array) return v.slice();
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof Map) return new Map(Array.from(v.entries()).map(function (e) { return [clone(e[0]), clone(e[1])]; }));
      if (v instanceof Set) return new Set(Array.from(v).map(clone));
      if (Array.isArray(v)) return v.map(clone);
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = clone(v[k]); });
      return out;
    };
  }

  g.__bridge = {
    call: call,
    MIXED: MIXED,
    encode: encode,
    decode: decode,
    b64enc: b64enc,
    b64dec: b64dec,
    setNodeReviver: function (f) { reviveNode = f; },
  };
})();
