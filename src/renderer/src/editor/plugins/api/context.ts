/**
 * What the API's host functions see of a run (host.ts implements it): the editor, the run's identity and manifest,
 * and the run's write slice — every write calls `write()` first, which opens the run's transaction (one undo step
 * per run, docs/plugins.md §2 decision 6).
 */
import type { Guid, NodeChange } from "@/engine/codec";
import type { PluginManifest } from "@shared/plugins/types";
import type { EditorController } from "../../controller";
import { ApiError } from "./codec";
import { apiType } from "./convert";

export interface ApiContext {
  readonly ed: EditorController;
  readonly pluginId: string;
  readonly name: string;
  readonly manifest: PluginManifest;
  readonly development: boolean;
  readonly mode: "default" | "inspect" | "codegen";
  readonly editorType: "figma" | "dev";
  /** `documentAccess: "dynamic-page"` */
  readonly dynamicPage: boolean;
  /** Opens (or keeps) the run's write slice; throws when the document can't be written now. */
  write(): void;
  /** Flags the plugin set (`figma.skipInvisibleInstanceChildren`) */
  flags: { skipInvisibleInstanceChildren: boolean };
}

/** A node as the API reads it: its fields with the real type. */
export function readNode(ctx: ApiContext, id: Guid, withChildren = true): NodeChange | null {
  const n = ctx.ed.engine.readNode(id, { childIds: withChildren });
  return n ? ctx.ed.withRealType(n) : null;
}

export function mustNode(ctx: ApiContext, id: unknown): NodeChange {
  if (typeof id !== "string" || !id) throw new ApiError("Expected a node");
  const n = readNode(ctx, id);
  if (!n) throw new ApiError(`The node (id: ${id}) does not exist`);
  return n;
}

/** A node handle for the VM ({$node, $type}). */
export function ref(n: NodeChange | null): { $node: string; $type: string } | null {
  return n ? { $node: n.guid, $type: apiType(n as never) } : null;
}

export function refOf(ctx: ApiContext, id: Guid | null | undefined): { $node: string; $type: string } | null {
  if (!id) return null;
  if (id === "0:0") return { $node: "0:0", $type: "DOCUMENT" };
  return ref(readNode(ctx, id, false));
}

export const parentOf = (ctx: ApiContext, n: NodeChange): NodeChange | null => (n.parentIndex?.guid ? readNode(ctx, n.parentIndex.guid) : null);
