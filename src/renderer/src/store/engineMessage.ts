/**
 * The engine's interim payload (JSON with schema/document.kiwi's names, GUIDs as "s:l" strings — src/renderer/src/engine/codec.ts)
 * ⇄ the store's kiwi Messages (src/shared/schema, GUIDs as {sessionID, localID}). Driven by the schema, so every field
 * the engine learns later converts without touching this file; when the engine speaks kiwi itself (engine.md §1.6)
 * these two functions become the identity and go away.
 *
 *   engine → store: GUID strings become objects, int64/uint64 become bigints, fields the schema doesn't know
 *                   (`childIds`) are dropped;
 *   store → engine: GUID objects become strings, bigints become numbers, bytes (Uint8Array, which JSON can't carry)
 *                   are left out — the store keeps them, since the engine's changes carry only the fields they touch.
 */
import type { Message as EngineMessage, NodeChange as EngineNodeChange } from "@/engine/codec";
import { guidKey, parseGuid } from "../../../shared/schema/guid";
import { MODEL, NATIVE_TYPES, type SchemaModel } from "../../../shared/schema/model";
import type { Message, NodeChange } from "../../../shared/schema/codec";

/* eslint-disable @typescript-eslint/no-explicit-any -- values are shaped by the schema at run time */

function toKiwiValue(m: SchemaModel, type: string, isArray: boolean, v: any): any {
  if (v === undefined || v === null) return undefined;
  if (isArray) {
    if (type === "byte") return v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v) : undefined;
    if (!Array.isArray(v)) return undefined;
    const out: any[] = [];
    for (const e of v) {
      const x = toKiwiValue(m, type, false, e);
      if (x !== undefined) out.push(x);
    }
    return out;
  }
  if (NATIVE_TYPES.has(type)) {
    if (type === "int64" || type === "uint64") return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
    return v;
  }
  if (type === "GUID") return typeof v === "string" ? parseGuid(v) : { sessionID: v.sessionID, localID: v.localID };
  const d = m.defs.get(type);
  if (!d) return undefined;
  if (d.kind === "ENUM") return v;
  if (typeof v !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const key in v) {
    const f = d.byName.get(key);
    if (!f || !f.type) continue;
    const x = toKiwiValue(m, f.type, f.isArray, v[key]);
    if (x !== undefined) out[key] = x;
  }
  return out;
}

function toEngineValue(m: SchemaModel, type: string, isArray: boolean, v: any): any {
  if (v === undefined || v === null) return undefined;
  if (isArray) {
    if (type === "byte" || v instanceof Uint8Array) return undefined;
    const out: any[] = [];
    for (const e of v as any[]) {
      const x = toEngineValue(m, type, false, e);
      if (x !== undefined) out.push(x);
    }
    return out;
  }
  if (typeof v === "bigint") return Number(v);
  if (NATIVE_TYPES.has(type)) return v;
  if (type === "GUID") return guidKey(v);
  const d = m.defs.get(type);
  if (!d) return undefined;
  if (d.kind === "ENUM") return v;
  const out: Record<string, unknown> = {};
  for (const key in v) {
    const f = d.byName.get(key);
    if (!f || !f.type) continue;
    const x = toEngineValue(m, f.type, f.isArray, v[key]);
    if (x !== undefined) out[key] = x;
  }
  return out;
}

/** One engine NodeChange → a kiwi NodeChange. */
export function nodeToKiwi(node: EngineNodeChange, model: SchemaModel = MODEL): NodeChange {
  return toKiwiValue(model, "NodeChange", false, node) as NodeChange;
}

/** One kiwi NodeChange → the engine's form. */
export function nodeToEngine(node: NodeChange, model: SchemaModel = MODEL): EngineNodeChange {
  return toEngineValue(model, "NodeChange", false, node) as EngineNodeChange;
}

/** An engine change Message (DOCUMENT_CHANGED's message) → the kiwi Message the store journals. */
export function messageToKiwi(message: EngineMessage, model: SchemaModel = MODEL): Message {
  return {
    type: "NODE_CHANGES",
    sessionID: message.sessionID ?? 0,
    ackID: 0,
    nodeChanges: (message.nodeChanges ?? []).map((n) => nodeToKiwi(n, model)).filter((n) => !!n.guid),
    blobs: [],
  };
}

/** A kiwi Message (a snapshot, a journal frame, a restore diff) → what `engine_load` / `engine_apply_changes` take. */
export function messageToEngine(message: Message, model: SchemaModel = MODEL): EngineMessage {
  return {
    type: "NODE_CHANGES",
    sessionID: message.sessionID ?? 0,
    nodeChanges: (message.nodeChanges ?? []).filter((n) => !!n.guid).map((n) => nodeToEngine(n, model)),
  };
}
