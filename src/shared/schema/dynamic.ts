/**
 * An interpreting kiwi codec for any schema (an older one of ours, Figma's): the same values as kiwi-schema's
 * `compileSchema()` produces, without `new Function`, so it also runs under the renderer's CSP (paste from Figma,
 * docs/desktop.md §13). The store may use `compileSchema` instead for speed (docs/schema.md §2.3); both agree.
 */
import { ByteBuffer, decodeBinarySchema, type Schema } from "kiwi-schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- values are shaped by a runtime schema */

interface FieldPlan {
  name: string;
  type: string;
  isArray: boolean;
  value: number;
  deprecated: boolean;
}

interface DefPlan {
  name: string;
  kind: "ENUM" | "STRUCT" | "MESSAGE";
  fields: FieldPlan[];
  byId: Map<number, FieldPlan>;
  /** ENUM: value → name, name → value */
  names: Map<number, string>;
  values: Map<string, number>;
}

export interface DynamicCodec {
  readonly schema: Schema;
  decode(root: string, bytes: Uint8Array): any;
  encode(root: string, value: any): Uint8Array;
}

export function interpretSchema(schema: Schema): DynamicCodec {
  const plans = new Map<string, DefPlan>();
  for (const d of schema.definitions) {
    const fields: FieldPlan[] = d.fields.map((f) => ({ name: f.name, type: f.type ?? "", isArray: f.isArray, value: f.value, deprecated: f.isDeprecated }));
    plans.set(d.name, {
      name: d.name,
      kind: d.kind,
      fields,
      byId: new Map(fields.map((f) => [f.value, f])),
      names: new Map(d.kind === "ENUM" ? fields.map((f) => [f.value, f.name]) : []),
      values: new Map(d.kind === "ENUM" ? fields.map((f) => [f.name, f.value]) : []),
    });
  }
  const plan = (name: string) => {
    const p = plans.get(name);
    if (!p) throw new Error(`schema has no definition ${name}`);
    return p;
  };

  function readOne(bb: ByteBuffer, type: string): any {
    switch (type) {
      case "bool":
        return !!bb.readByte();
      case "byte":
        return bb.readByte();
      case "int":
        return bb.readVarInt();
      case "uint":
        return bb.readVarUint();
      case "float":
        return bb.readVarFloat();
      case "string":
        return bb.readString();
      case "int64":
        return bb.readVarInt64();
      case "uint64":
        return bb.readVarUint64();
    }
    const p = plan(type);
    if (p.kind === "ENUM") return p.names.get(bb.readVarUint());
    return readDef(bb, p);
  }

  function readField(bb: ByteBuffer, f: FieldPlan): any {
    if (!f.isArray) return readOne(bb, f.type);
    if (f.type === "byte") return bb.readByteArray();
    const n = bb.readVarUint();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = readOne(bb, f.type);
    return out;
  }

  function readDef(bb: ByteBuffer, p: DefPlan): any {
    const result: any = {};
    if (p.kind === "STRUCT") {
      for (const f of p.fields) {
        const v = readField(bb, f);
        if (!f.deprecated) result[f.name] = v;
      }
      return result;
    }
    for (;;) {
      const id = bb.readVarUint();
      if (id === 0) return result;
      const f = p.byId.get(id);
      if (!f) throw new Error("Attempted to parse invalid message");
      const v = readField(bb, f);
      if (!f.deprecated) result[f.name] = v;
    }
  }

  function writeOne(bb: ByteBuffer, type: string, value: any): void {
    switch (type) {
      case "bool":
      case "byte":
        bb.writeByte(type === "bool" ? (value ? 1 : 0) : value);
        return;
      case "int":
        bb.writeVarInt(value);
        return;
      case "uint":
        bb.writeVarUint(value);
        return;
      case "float":
        bb.writeVarFloat(value);
        return;
      case "string":
        bb.writeString(value);
        return;
      case "int64":
        bb.writeVarInt64(value);
        return;
      case "uint64":
        bb.writeVarUint64(value);
        return;
    }
    const p = plan(type);
    if (p.kind === "ENUM") {
      const v = p.values.get(value);
      if (v === undefined) throw new Error(`Invalid value ${JSON.stringify(value)} for enum "${p.name}"`);
      bb.writeVarUint(v);
      return;
    }
    writeDef(bb, p, value);
  }

  function writeDef(bb: ByteBuffer, p: DefPlan, value: any): void {
    for (const f of p.fields) {
      if (f.deprecated) continue;
      const v = value[f.name];
      if (v == null) {
        if (p.kind === "STRUCT") throw new Error(`Missing required field "${f.name}"`);
        continue;
      }
      if (p.kind === "MESSAGE") bb.writeVarUint(f.value);
      if (!f.isArray) writeOne(bb, f.type, v);
      else if (f.type === "byte") bb.writeByteArray(v);
      else {
        bb.writeVarUint(v.length);
        for (const e of v) writeOne(bb, f.type, e);
      }
    }
    if (p.kind === "MESSAGE") bb.writeVarUint(0);
  }

  return {
    schema,
    decode(root, bytes) {
      return readDef(new ByteBuffer(bytes), plan(root));
    },
    encode(root, value) {
      const bb = new ByteBuffer();
      writeDef(bb, plan(root), value);
      return bb.toUint8Array();
    },
  };
}

export function interpretBinarySchema(binarySchema: Uint8Array): DynamicCodec {
  return interpretSchema(decodeBinarySchema(binarySchema));
}
