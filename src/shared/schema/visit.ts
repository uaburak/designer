/**
 * Schema-driven traversal of decoded kiwi values. Kiwi values are plain objects keyed by field name, so the schema
 * says what each key holds. Only fields whose type can reach one of the `targets` definitions are visited, which keeps
 * a walk over a whole document proportional to the data that matters (images, GUIDs, blob indices).
 */
import { NATIVE_TYPES, type SchemaModel } from "./model";

/* eslint-disable @typescript-eslint/no-explicit-any -- decoded kiwi values are dynamically shaped by the schema */

export interface MapContext {
  /** The value is an element of an array field */
  inArray: boolean;
  /** Name of the field holding the value in its parent */
  field: string;
  /** Definition of the parent value */
  parent: string;
}

/** Called bottom-up on every value of a target definition. Return the value, a replacement, or undefined to drop it. */
export type MapHook = (def: string, value: any, ctx: MapContext) => any;

/**
 * Rebuilds `value` (of definition `def`) bottom-up with structural sharing: objects and arrays are copied only when
 * something under them changed. The input is never mutated.
 */
export function mapValue(model: SchemaModel, def: string, value: any, targets: ReadonlySet<string>, hook: MapHook, ctx: MapContext = { inArray: false, field: "", parent: "" }): any {
  const d = model.defs.get(def);
  if (!d || d.kind === "ENUM" || value == null || typeof value !== "object") return value;
  let copy: any = null;
  for (const key in value) {
    const f = d.byName.get(key);
    if (!f || !f.type || NATIVE_TYPES.has(f.type)) continue;
    if (!model.canContain(f.type, targets)) continue;
    const v = value[key];
    if (v == null) continue;
    let nv: any;
    if (f.isArray) {
      let arr: any[] | null = null;
      let dropped = false;
      for (let i = 0; i < v.length; i++) {
        const e = v[i];
        const ne = mapValue(model, f.type, e, targets, hook, { inArray: true, field: key, parent: def });
        if (ne !== e) {
          arr ??= v.slice();
          arr![i] = ne;
          if (ne === undefined) dropped = true;
        }
      }
      nv = arr ? (dropped ? arr.filter((e) => e !== undefined) : arr) : v;
    } else nv = mapValue(model, f.type, v, targets, hook, { inArray: false, field: key, parent: def });
    if (nv !== v) {
      copy ??= { ...value };
      if (nv === undefined) delete copy[key];
      else copy[key] = nv;
    }
  }
  const result = copy ?? value;
  return targets.has(def) ? hook(def, result, ctx) : result;
}

/** Visits every value of a target definition under `value` (read-only, top-down). */
export function walkValue(model: SchemaModel, def: string, value: any, targets: ReadonlySet<string>, visit: (def: string, value: any) => void): void {
  const d = model.defs.get(def);
  if (!d || d.kind === "ENUM" || value == null || typeof value !== "object") return;
  if (targets.has(def)) visit(def, value);
  for (const key in value) {
    const f = d.byName.get(key);
    if (!f || !f.type || NATIVE_TYPES.has(f.type)) continue;
    if (!model.canContain(f.type, targets)) continue;
    const v = value[key];
    if (v == null) continue;
    if (f.isArray) for (const e of v) walkValue(model, f.type, e, targets, visit);
    else walkValue(model, f.type, v, targets, visit);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Deep equality of two values of the same field type. Blob-index fields compare the bytes they point at (each side
 * through its own blob table), so the same geometry in two tables is equal whatever its index.
 */
export function valuesEqual(
  model: SchemaModel,
  type: string,
  isArray: boolean,
  a: any,
  b: any,
  blobA: (index: number) => Uint8Array | undefined,
  blobB: (index: number) => Uint8Array | undefined,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (isArray) {
    if (type === "byte") return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b);
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEqual(model, type, false, a[i], b[i], blobA, blobB)) return false;
    return true;
  }
  if (NATIVE_TYPES.has(type)) return Object.is(a, b);
  const d = model.defs.get(type);
  if (!d || d.kind === "ENUM") return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va == null && vb == null) continue;
    const f = d.byName.get(key);
    if (!f || !f.type) {
      if (va !== vb) return false;
      continue;
    }
    if (model.isBlobField(type, key)) {
      if (va == null || vb == null) return false;
      const ba = blobA(va);
      const bb = blobB(vb);
      if (!ba || !bb || !bytesEqual(ba, bb)) return false;
      continue;
    }
    if (!valuesEqual(model, f.type, f.isArray, va, vb, blobA, blobB)) return false;
  }
  return true;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
