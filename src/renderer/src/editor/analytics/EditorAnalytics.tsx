/**
 * Library analytics in the editor: the file name menu's "Library analytics" (Figma: in the library file, nothing
 * selected, the file name's ⌄) opens the modal for this file's org library. Its open state is kept per editor here
 * (no field in the editor's UI state); the host renders with the Libraries modal.
 */
import { useSyncExternalStore } from "react";
import type { EditorController } from "../controller";
import { useEditor } from "../controller";
import { useLibraries, useUI } from "../hooks";
import { Store } from "../uiStore";
import { LibraryAnalyticsModal } from "./LibraryAnalyticsModal";

const openState = new WeakMap<EditorController, Store<{ open: boolean }>>();
const stateOf = (ed: EditorController) => {
  let s = openState.get(ed);
  if (!s) openState.set(ed, (s = new Store<{ open: boolean }>({ open: false })));
  return s;
};

/** Can this file show its library analytics? An org file published as a library, the store's views at hand. */
export function canShowLibraryAnalytics(ed: EditorController): boolean {
  const lib = ed.libraries.get();
  return lib.on && !!lib.org && !!lib.own && lib.own.status === "published" && !!ed.source.libraries?.analytics?.views;
}

export function openLibraryAnalytics(ed: EditorController): void {
  stateOf(ed).set({ open: true });
}

export function EditorLibraryAnalytics() {
  const ed = useEditor();
  const s = stateOf(ed);
  const open = useSyncExternalStore(s.subscribe, () => s.get().open);
  const lib = useLibraries();
  const fileName = useUI((u) => u.fileName);
  const access = ed.source.libraries;
  const views = access?.analytics?.views;
  if (!open || !access || !views) return null;
  return (
    <LibraryAnalyticsModal
      store={{ analytics: views, ...(access.analytics?.orgLibraries ? { orgLibraries: access.analytics.orgLibraries } : {}) }}
      libraryKey={access.libraryKey}
      name={fileName}
      {...(lib.org ? { orgId: lib.org.orgId } : {})}
      onClose={() => {
        s.set({ open: false });
        ed.focusCanvas();
      }}
    />
  );
}
