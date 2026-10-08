/**
 * `?present&file=<fileKey>[&page=<id>][&node=<id>]`: the presentation view in a tab of its own (Figma's desktop app
 * opens Present in a new tab; R8 §9). The file is opened read-only (`mode: "view"`, alongside its editor's session),
 * loaded from its snapshot and journal, and kept current through the store's change feed — an edit in the editor
 * shows in the prototype. Nothing is ever written from here.
 */
import "@/ds/global.css";
import { useMemo } from "react";
import { ToastHost, TooltipManager, useThemeRoot } from "@/ds";
import { getStoreClient } from "@/store";
import { PresentationView, type PresentationSource } from "./PresentationView";

const params = new URLSearchParams(location.search);

/** The store's file, read-only, as the presentation's source. */
export function storePresentationSource(fileKey: string): PresentationSource {
  const store = getStoreClient();
  let headSeq = 0;
  const source: PresentationSource = {
    fileName: "Prototype",
    async load() {
      const opened = await store.files.open(fileKey, { mode: "view" });
      headSeq = opened.headSeq;
      source.fileName = opened.meta.name;
      document.title = opened.meta.name;
      // A prototype tab of the desktop app: its title, and that it is up.
      (window as unknown as { designer?: { tab?: { report?: (r: { title?: string; status?: string }) => void } } }).designer?.tab?.report?.({ title: opened.meta.name, status: "ready" });
      return { bytes: opened.snapshot, frames: opened.journal.map((f) => f.message) };
    },
    subscribe(apply) {
      return store.files.subscribe(fileKey, headSeq, (c) => apply(c.message));
    },
    images: async (hash) => {
      try {
        return await store.blobs.get(hash);
      } catch {
        return null;
      }
    },
  };
  return source;
}

export default function PresentRoute() {
  useThemeRoot();
  const fileKey = params.get("file");
  const source = useMemo(() => (fileKey ? storePresentationSource(fileKey) : null), [fileKey]);
  return (
    <>
      {source ? <PresentationView source={source} page={params.get("page")} node={params.get("node")} /> : <p>No file to present.</p>}
      <TooltipManager />
      <ToastHost />
    </>
  );
}
