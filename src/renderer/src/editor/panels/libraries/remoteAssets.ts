/**
 * The enabled libraries' styles, variables and collections as the pickers list them (the colour picker's Libraries
 * tab, Apply variable, Apply styles): a copy already in this file is listed as itself; one that isn't yet is read
 * from the library's payload and imported (as a copy, with what it needs) when it is picked.
 */
import { useEffect, useMemo, useState } from "react";
import type { Guid, Message } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { useLibraries, useLocalAssets } from "../../hooks";
import { ensureCopy } from "../../libraries";
import { payloadRoot } from "../../model/libraries";
import { byPosition, readCollection, readVariable, type Collection, type Variable, type VNode } from "../../model/variables";
import { isStyleNode, readStyle, type Style, type StyleNode } from "../../model/styles";

export interface RemoteRef {
  library: string;
  libraryName: string;
  key: string;
  /** Already copied into this file (`id` is the copy) */
  imported: boolean;
}
export type RemoteVariable = Variable & { remote: RemoteRef };
export type RemoteStyle = Style & { remote: RemoteRef };
export type RemoteCollection = Collection & { remote: RemoteRef };

export interface RemoteLibraryAssets {
  library: string;
  name: string;
  collections: RemoteCollection[];
  variables: RemoteVariable[];
  styles: RemoteStyle[];
}

/** Every enabled library's styles and variables (payloads fetched once per published version). */
export function useRemoteAssets(): RemoteLibraryAssets[] {
  const ed = useEditor();
  const state = useLibraries();
  const local = useLocalAssets();
  const [payloads, setPayloads] = useState<Map<string, Map<string, Message>>>(new Map());
  useEffect(() => {
    let live = true;
    void Promise.all(state.enabled.map(async (lib) => [lib, await ed.libraries.previewPayloads(lib)] as const)).then((list) => {
      if (live) setPayloads(new Map(list));
    });
    return () => {
      live = false;
    };
  }, [ed, state]);
  return useMemo(() => {
    const out: RemoteLibraryAssets[] = [];
    for (const lib of state.enabled) {
      const manifest = state.manifests.get(lib);
      if (!manifest) continue;
      const name = state.names.get(lib) ?? "Library";
      const ref = (key: string, imported: boolean): RemoteRef => ({ library: lib, libraryName: name, key, imported });
      const copyKey = (node: unknown) => {
        const n = node as { sourceLibraryKey?: string; key?: string };
        return n.sourceLibraryKey === lib ? (n.key ?? null) : null;
      };
      const copies = {
        collections: new Map(local.library.collections.filter((c) => copyKey(c.node)).map((c) => [copyKey(c.node)!, c])),
        variables: new Map(local.library.variables.filter((v) => copyKey(v.node)).map((v) => [copyKey(v.node)!, v])),
        styles: new Map(local.library.styles.filter((s) => copyKey(s.node)).map((s) => [copyKey(s.node)!, s])),
      };
      const nodes = payloads.get(lib) ?? new Map<string, Message>();
      const nodeOf = (key: string) => {
        const m = nodes.get(key);
        return m ? payloadRoot(m, key) : null;
      };
      const collections: RemoteCollection[] = [];
      const variables: RemoteVariable[] = [];
      const styles: RemoteStyle[] = [];
      const libGuidToCollection = new Map<Guid, RemoteCollection>();
      for (const a of manifest.assets) {
        if (a.dependencyOnly && a.kind !== "VARIABLE_COLLECTION") continue;
        if (a.kind === "VARIABLE_COLLECTION") {
          const copy = copies.collections.get(a.key);
          const n = copy?.node ?? nodeOf(a.key);
          if (!n) continue;
          const c = copy ?? { ...readCollection(n as VNode), id: `${lib}/${a.key}` };
          const rc = { ...c, remote: ref(a.key, !!copy) };
          collections.push(rc);
          libGuidToCollection.set(a.guid, rc);
        } else if (a.kind === "VARIABLE") {
          const copy = copies.variables.get(a.key);
          const n = copy?.node ?? nodeOf(a.key);
          if (!n) continue;
          variables.push({ ...(copy ?? { ...readVariable(n as VNode), id: `${lib}/${a.key}` }), remote: ref(a.key, !!copy) });
        } else if (a.kind === "STYLE") {
          const copy = copies.styles.get(a.key);
          const n = copy?.node ?? nodeOf(a.key);
          if (!n || !isStyleNode(n as StyleNode)) continue;
          styles.push({ ...(copy ?? { ...readStyle(n as StyleNode), id: `${lib}/${a.key}` }), remote: ref(a.key, !!copy) });
        }
      }
      // Variables point at their collection by its library GUID (payloads) or by the copy's (copies).
      for (const v of variables) {
        if (v.remote.imported) continue;
        const c = libGuidToCollection.get(v.collection);
        if (c) v.collection = c.id;
      }
      collections.sort(byPosition);
      styles.sort(byPosition);
      out.push({ library: lib, name, collections, variables, styles });
    }
    return out;
  }, [state, local, payloads]);
}

/** The local GUID of a picked library item: itself when copied already, else the copy made now (one step). */
export async function pickRemote(ed: EditorController, item: { id: Guid; remote: RemoteRef }): Promise<Guid | null> {
  if (item.remote.imported) return item.id;
  return ensureCopy(ed, item.remote.library, item.remote.key);
}

/** A remote variable's value in its collection's default mode (aliases unresolved until it is copied). */
export function remoteDefaultValue(v: RemoteVariable, collections: readonly Collection[]): unknown {
  const c = collections.find((x) => x.id === v.collection);
  const d = c ? v.values.get(c.defaultMode) : [...v.values.values()][0];
  return d && d.kind !== "alias" ? d.value : null;
}
