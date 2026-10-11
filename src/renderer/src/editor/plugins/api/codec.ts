/**
 * The host's side of the bridge's JSON (runtime/bridge.js): a Uint8Array as {"$u8": base64}, figma.mixed as
 * {"$mixed": 1}, a node as {"$node": id, "$type": type} out and as its id in. Kept apart from the API so the
 * developer VM and the templates' sandbox share it.
 */

/** figma.mixed on the host's side. */
export const MIXED: unique symbol = Symbol("figma.mixed");
export type Mixed = typeof MIXED;

/** A node going to the VM. */
export interface NodeRef {
  $node: string;
  $type: string;
}
export const nodeRef = (id: string, type: string): NodeRef => ({ $node: id, $type: type });
export const isNodeRef = (v: unknown): v is NodeRef => !!v && typeof v === "object" && typeof (v as NodeRef).$node === "string";

export function b64encode(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeValue(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v, (_k, x: unknown) => {
    if (x instanceof Uint8Array) return { $u8: b64encode(x) };
    if (x === MIXED) return { $mixed: 1 };
    if (x instanceof ArrayBuffer) return { $u8: b64encode(new Uint8Array(x)) };
    if (typeof x === "number" && !Number.isFinite(x)) return null;
    return x;
  });
}

/** The VM's JSON: {$node} becomes the node's id (the API reads ids), {$u8} bytes, {$mixed} MIXED. */
export function decodeValue(json: string): unknown {
  return JSON.parse(json, (_k, x: unknown) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (typeof o.$u8 === "string") return b64decode(o.$u8);
      if (o.$mixed === 1) return MIXED;
      if (typeof o.$node === "string") return o.$node;
    }
    return x;
  });
}

/** An error the API throws with Figma's wording (it reaches the plugin as an Error with this message). */
export class ApiError extends Error {}

export const ok = (v: unknown): string => encodeValue({ ok: v === undefined ? null : v });
export const fail = (e: unknown): string => JSON.stringify({ err: e instanceof Error ? e.message : String(e) });
