/**
 * Quitting while files are still uploading (docs/multiplayer.md §5.1, docs/desktop.md §6): main asks first — "Uploads
 * in progress" — and the uploads continue at the next start (the store's links keep `pendingUpload`). Asked once per
 * quit, however many windows close; a cancelled quit asks again next time. Imports nothing from Electron (the window
 * and the store's client are handed in), so the decision is tested on its own.
 */
import { t, tp } from "../shared/i18n";
import { isDownload, uploadInFlight, type UploadProgress } from "../shared/multiplayer/uploads";

/** How long the quit waits for the store's answer before going on without asking */
export const UPLOADS_ASK_TIMEOUT_MS = 1500;

export interface UploadsQuitDeps {
  /** The store's uploads (null: no store) */
  list(): Promise<UploadProgress[]> | null;
  /** The question; true: quit */
  ask(count: number): Promise<boolean>;
  timeoutMs?: number;
}

/** Uploads still going (images coming down don't hold a quit: they continue at the next start) */
export const uploadsInFlight = (list: readonly Pick<UploadProgress, "state" | "direction">[]): number => list.filter((u) => uploadInFlight(u) && !isDownload(u)).length;

/** The question's words (ours: Figma's desktop app has no such question) */
export const uploadsQuitText = (count: number) => ({
  message: t("Uploads in progress"),
  detail: tp(count, "Wecra is still uploading 1 file. If you quit, it’ll continue next time you open Wecra.", "Wecra is still uploading {n} files. If you quit, they’ll continue next time you open Wecra."),
});

let decided: Promise<boolean> | null = null;

/** May the quit go on? Asks only when uploads are in flight; the store not answering in time doesn't hold the quit. */
export function confirmQuitWithUploads(deps: UploadsQuitDeps): Promise<boolean> {
  decided ??= (async () => {
    let list: UploadProgress[] = [];
    try {
      const pending = deps.list();
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        list = await Promise.race([pending, new Promise<UploadProgress[]>((r) => (timer = setTimeout(() => r([]), deps.timeoutMs ?? UPLOADS_ASK_TIMEOUT_MS)))]);
        clearTimeout(timer);
      }
    } catch {
      list = [];
    }
    const n = uploadsInFlight(list);
    const ok = n === 0 || (await deps.ask(n));
    // Cancelled: the next quit asks again
    if (!ok) decided = null;
    return ok;
  })();
  return decided;
}

/** @internal tests */
export function resetUploadsQuit(): void {
  decided = null;
}
