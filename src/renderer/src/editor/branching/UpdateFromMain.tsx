/**
 * "Update from main file" (R21 [update]): the items main changed, each previewed in its latest version (main's side —
 * "not a before and after"); conflicts go through Resolve conflicts; Apply changes takes them all (no picking of
 * updates). A head that moved since the preview (`stale`) previews again.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, EmptyState, ScrollArea, Spinner, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { MergePreview } from "../../../../shared/merge/branches";
import type { Resolutions } from "../../../../shared/merge/types";
import type { FileKey } from "../../../../shared/store/types";
import { useEditor } from "../controller";
import type { BranchingBackend } from "./access";
import { ChunkCompare, useSideDocs } from "./ChunkCompare";
import { allPicked, pickAll } from "./model";
import { BranchWindow, ChangeDetails, ChangeList, codeOf, Conflicts, errorText, ForceDialog } from "./parts";
import { openBranchWindow, refreshBranch, setBranching } from "./state";
import styles from "./Branching.module.css";

export function UpdateFromMain({ backend, branchFileKey }: { backend: BranchingBackend; branchFileKey: FileKey }) {
  useT();
  const ed = useEditor();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Resolutions>({});
  const [step, setStep] = useState<"changes" | "conflicts">("changes");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const images = ed.source.images ? (h: string) => ed.source.images!.get(h) : null;
  const docs = useSideDocs(backend.branches, images);
  const close = () => {
    openBranchWindow(ed, null);
    ed.focusCanvas();
  };
  // The latest preview asked for is the one shown (the store keeps only the latest one per branch).
  const loads = useRef(0);
  const load = async (resolutions: Resolutions) => {
    const n = ++loads.current;
    try {
      const p = await backend.branches.preview(branchFileKey, "update", resolutions);
      if (n !== loads.current) return p;
      setPreview(p);
      setSelected((s) => s ?? p.chunks[0]?.index ?? null);
      return p;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  useEffect(() => {
    void Promise.resolve().then(() => load({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
  }, [branchFileKey]);

  const [forcing, setForcing] = useState(false);
  const apply = async (chosen: Resolutions = picks) => {
    if (!preview) return;
    setBusy(true);
    try {
      // The picks go in with a fresh preview, so its batch is the one applied.
      const p = Object.keys(chosen).length ? await backend.branches.preview(branchFileKey, "update", chosen) : preview;
      await backend.branches.applyUpdate(branchFileKey, { previewId: p.previewId, resolutions: chosen });
      setBranching(ed, { mainChanged: false, noticeDismissed: false });
      await refreshBranch(ed);
      showToast({ message: t("Updated from main") });
      close();
    } catch (e) {
      setBusy(false);
      if (codeOf(e) === "stale") {
        showToast({ message: t("The main file changed. Review the updates again.") });
        void load(picks);
      } else showToast({ kind: "error", message: t("Couldn’t apply the changes: {error}", { error: errorText(e) }) });
    }
  };

  const conflicts = preview ? preview.conflicts.length > 0 : false;
  const ready = !!preview && (!conflicts || allPicked(picks, preview));
  const chunk = preview?.chunks.find((c) => c.index === selected) ?? null;
  return (
    <BranchWindow
      label="Update from main file"
      title={t("Update from main file")}
      onClose={close}
      onBack={step === "conflicts" ? () => setStep("changes") : undefined}
      footer={
        step === "changes" ? (
          <>
            {conflicts && (
              <Button variant="secondary" disabled={busy} onClick={() => setForcing(true)} data-force-open="">
                {t("Force update…")}
              </Button>
            )}
            <span className={styles.grow} />
            <Button variant="secondary" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" disabled={!ready || busy} loading={busy} onClick={() => void apply()} data-apply="">
              {t("Apply changes")}
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <EmptyState icon="24.warning" title={t("The updates couldn’t be loaded")} body={error} />
      ) : !preview ? (
        <div className={styles.loading}>
          <Spinner size={24} />
        </div>
      ) : step === "conflicts" ? (
        <Conflicts preview={preview} picks={picks} onPicks={setPicks} docs={docs} selected={selected} onSelect={setSelected} onNext={() => setStep("changes")} />
      ) : (
        <div className={styles.body}>
          <nav className={styles.sidebar}>
            {conflicts && (
              <Banner tone="warning" action={{ label: t("Resolve conflicts"), onClick: () => setStep("conflicts") }} data-conflict-banner="">
                {allPicked(picks, preview) ? t("Conflicts resolved") : tp(preview.conflicts.length, "{n} conflict with your branch", "{n} conflicts with your branch")}
              </Banner>
            )}
            <div className={styles.sectionTitle}>{t("Changes")}</div>
            <ScrollArea className={styles.scroll}>
              <ChangeList chunks={preview.chunks} selected={selected} onSelect={setSelected} />
            </ScrollArea>
          </nav>
          <section className={styles.main}>
            {chunk ? (
              <>
                <ChunkCompare docs={docs} previewId={preview.previewId} chunk={chunk} sides={[{ side: "main", caption: t("Main file") }]} modes={false} />
                <ChangeDetails chunk={chunk} />
              </>
            ) : (
              <EmptyState icon="24.check" title={t("No updates")} body={t("The branch has every change from the main file.")} />
            )}
          </section>
        </div>
      )}
      {forcing && (
        <ForceDialog
          direction="update"
          onClose={() => setForcing(false)}
          onConfirm={async (side) => {
            setForcing(false);
            await apply(pickAll(side));
          }}
        />
      )}
    </BranchWindow>
  );
}
