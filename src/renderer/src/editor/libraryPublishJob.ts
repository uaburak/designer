/**
 * Publishing in the background (as Figma's: Publish closes the dialog at once; a toast follows the run — "Publishing
 * HeroUI… 153/8295" with a bar, then "Uploading HeroUI… 42%" while an org library's bytes go up — and becomes "Library published", or the error with Retry). One run per editor at a
 * time: the Publish dialog, opened again meanwhile, shows the run instead of a second Publish. `publishLibrary` hands
 * the event loop back between slices, so the editor stays usable while a big file publishes.
 */
import { dismissToast, showToast, updateToast } from "@/ds";
import { t } from "@/i18n";
import type { EditorController } from "./controller";
import { publishLibrary, type PublishChoices, type PublishDraft, type PublishedLibrary } from "./libraries";
import { publishErrorText, publishRetryable } from "./panels/libraries/publishErrors";

export interface PublishRun {
  done: number;
  total: number;
  /** After drafting, while the payloads and thumbnails go up: the share sent (0…1); absent before (or with no upload) */
  uploaded?: number;
}

/** Each editor's run in progress, as last reported (a new object per report: what `useSyncExternalStore` compares). */
const runs = new WeakMap<EditorController, PublishRun>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The run in progress in this editor (null: none). */
export const publishRun = (ed: EditorController): PublishRun | null => runs.get(ed) ?? null;

export function subscribePublishRun(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** How often the toast's count is redrawn (a publish reports every asset). */
const TOAST_EVERY_MS = 100;

/**
 * Starts publishing `draft` in the background; false when this editor is already publishing (nothing started). The
 * promise of the run is returned as `done` for callers (tests) that wait for it; it never rejects.
 */
export function publishInBackground(ed: EditorController, draft: PublishDraft, choices: PublishChoices, opts: { name: string }): { started: boolean; done: Promise<PublishedLibrary | null> } {
  if (runs.has(ed)) return { started: false, done: Promise.resolve(null) };
  const run: PublishRun = { done: 0, total: draft.items.length };
  runs.set(ed, { ...run });
  emit();
  const text = () =>
    run.uploaded === undefined ? t("Publishing {name}… {done}/{total}", { name: opts.name, done: run.done, total: run.total }) : t("Uploading {name}… {percent}%", { name: opts.name, percent: Math.floor(run.uploaded * 100) });
  const toast = showToast({ message: text(), spinner: true, progress: 0, duration: Infinity });
  let drawn = 0;
  const done = (async (): Promise<PublishedLibrary | null> => {
    try {
      const draw = (progress: number, force: boolean) => {
        const now = performance.now();
        if (now - drawn < TOAST_EVERY_MS && !force) return;
        drawn = now;
        updateToast(toast, { message: text(), progress });
        runs.set(ed, { ...run });
        emit();
      };
      const published = await publishLibrary(
        ed,
        draft,
        choices,
        (n, total) => {
          run.done = n;
          run.total = total;
          draw(total ? n / total : 1, n >= total);
        },
        // The upload after drafting (an org library's payloads and thumbnails): "Uploading HeroUI… 42%" until the commit
        (sent, total) => {
          const first = run.uploaded === undefined;
          run.uploaded = total ? Math.min(1, sent / total) : 1;
          draw(run.uploaded, first || sent >= total);
        },
      );
      finish();
      // Published; should this file not have recorded it on its assets yet (an edit kept the engine busy), it says so.
      showToast(published.recorded ? { message: t("Library published"), kind: "success" } : { message: t("Library published, but this file couldn't record it yet"), kind: "error" });
      return published;
    } catch (e) {
      finish();
      const conflict = (e as { code?: string }).code === "conflict";
      // Someone published meanwhile (an org library, docs/data.md §16.6): Review opens the dialog, which looks again.
      const action = conflict
        ? { label: t("Review"), onAction: () => ed.ui.set({ publishOpen: true }) }
        : publishRetryable(e)
          ? { label: t("Retry"), onAction: () => void publishInBackground(ed, draft, choices, opts) }
          : undefined;
      showToast({ message: publishErrorText(e), kind: "error", ...(action ? { action } : {}) });
      return null;
    }
  })();
  function finish() {
    runs.delete(ed);
    dismissToast(toast);
    emit();
  }
  return { started: true, done };
}
