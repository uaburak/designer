/**
 * `?present&file=<fileKey>[&page=<id>][&node=<id>]` (and Figma's prototype parameters: `presentUrlOptions`): the presentation view in a tab of its own (Figma's desktop app
 * opens Present in a new tab; R8 §9). The file is opened read-only (`mode: "view"`, alongside its editor's session),
 * loaded from its snapshot and journal, and kept current through the store's change feed — an edit in the editor
 * shows in the prototype. Nothing is ever written from here.
 */
import { t, useT } from "@/i18n";
import "@/ds/global.css";
import { useMemo, useState } from "react";
import { ToastHost, TooltipManager, useThemeRoot } from "@/ds";
import { getStoreClient } from "@/store";
import { SharePrototypeDialog } from "@/editor/SharePrototypeDialog";
import { withLinkPassword } from "@/files/LinkPassword";
import { PresentationView, presentUrlOptions, type PresentationSource } from "./PresentationView";

const params = new URLSearchParams(location.search);

/**
 * The local file a key names: the file itself, else — a shared file's link (`/f/<key>?m=proto` in a browser) names the
 * server's key — its local copy, made from its room the first time (asking for the link's password when it has one).
 */
async function localKey(store: ReturnType<typeof getStoreClient>, key: string): Promise<string> {
  if (await store.workspace.getFile(key).catch(() => null)) return key;
  const shared = await withLinkPassword((password) => store.multiplayer.openShared(key, password));
  return shared?.fileKey ?? key;
}

/** The store's file, read-only, as the presentation's source. */
export function storePresentationSource(key: string): PresentationSource {
  const store = getStoreClient();
  let headSeq = 0;
  let fileKey = key;
  const source: PresentationSource = {
    fileName: "Prototype",
    stateKey: key,
    async load() {
      fileKey = await localKey(store, key);
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

/** The title's "Open in editor": the file's tab in the desktop app, else its editor in a browser tab. */
function openEditor(fileKey: string): void {
  const nav = (window as unknown as { designer?: { nav?: { openFile?: (key: string, options?: { pageId?: string }) => Promise<unknown> } } }).designer?.nav;
  if (nav?.openFile) {
    void nav.openFile(fileKey, { pageId: params.get("page") ?? undefined });
    return;
  }
  window.open(`${location.pathname}?editor&file=${encodeURIComponent(fileKey)}`, "_blank");
}

export default function PresentRoute() {
  useT();
  useThemeRoot();
  const fileKey = params.get("file");
  const source = useMemo(() => (fileKey ? storePresentationSource(fileKey) : null), [fileKey]);
  // Share prototype (docs/editor.md D-6): the prototype's share modal, at the screen shown
  const [sharing, setSharing] = useState<{ node: string | null } | null>(null);
  return (
    <>
      {source ? (
        <PresentationView
          source={source}
          page={params.get("page")}
          node={params.get("node")}
          urlOptions={presentUrlOptions(params)}
          onShare={(screen) => setSharing({ node: screen })}
          onOpenEditor={fileKey ? () => openEditor(fileKey) : undefined}
        />
      ) : (
        <p>{t("No file to present.")}</p>
      )}
      {sharing && fileKey && <SharePrototypeDialog fileKey={fileKey} nodeId={sharing.node} onClose={() => setSharing(null)} />}
      <TooltipManager />
      <ToastHost />
    </>
  );
}
