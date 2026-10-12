/**
 * File exporting (docs/governance.md §2.7) in main: Save local copy… is refused for a shared file's viewer whom the
 * file's "Viewers can copy, share, and export from this file" (or the org's File exporting) keeps out — whichever
 * view or menu asked. The same reading as the renderer's `exportAllowedFor` (src/renderer/src/files/governance.ts):
 * a local read of the file's share state, and the server's file info only for a viewer. Electron-free.
 */

export interface ExportAccessStore {
  fileState(key: string): Promise<{ shared: boolean; role: string | null }>;
  fileInfo(key: string): Promise<{ access?: { canExport?: boolean } | null }>;
}

/** The refusal's text (ours) */
export const EXPORT_RESTRICTED_MESSAGE = "The owner has turned off copying and exporting for viewers of this file.";

/** Whether the person may save a local copy of `fileKey` (local files, owners and editors: always). */
export async function mayExportFile(store: ExportAccessStore, fileKey: string): Promise<boolean> {
  const st = await store.fileState(fileKey).catch(() => null);
  if (!st?.shared || st.role !== "viewer") return true;
  const info = await store.fileInfo(fileKey).catch(() => null);
  return info?.access?.canExport !== false;
}
