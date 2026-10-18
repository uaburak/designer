/**
 * Export… (docs/social.md §8): a post's menu (the Posts list, the canvas), and Export campaign… for a campaign's posts.
 * Each post with its preset ("Auto" — its format's own, §8 — or another that fits it), what the preset renders (size,
 * frame rate, codec, bitrate, length or quality, the limit) and the file it makes ("‹Campaign› / ‹post name› —
 * ‹format›.‹ext›"), with its format's limits checked before anything is drawn; Export renders them (a progress row
 * with Cancel), saves one file or a zip of them all, and marks the posts exported (one undo step). What the files
 * showed afterwards — over a size limit, a JPEG made smaller — is listed before the dialog closes.
 */
import { useMemo, useRef, useState } from "react";
import { Button, Dialog, Select, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { canExport } from "../../exporting";
import { useUI } from "../../hooks";
import { PostThumb } from "../PostsList";
import { socialOf } from "../socialState";
import { AUTO_PRESET, autoPreset, exportAndSavePosts, planExports, presetsFor, secondsLabel, type PostExportPlan, type PostExportResult, type PostsProgress } from "./exportPosts";
import styles from "./ExportPostsDialog.module.css";

export function ExportPostsDialog() {
  const req = useUI((s) => s.socialExport ?? null);
  return req ? <ExportPosts key={req.ids.join(",")} ids={req.ids} /> : null;
}

/** What a plan renders, in one line: "1080 × 1920 · MP4 · H.264 · 30 fps · 12.4 Mbps · 6 s · ≤ 100 MB". */
export function planSummary(plan: PostExportPlan): string {
  const parts = [`${plan.width} × ${plan.height}`];
  if (plan.still) {
    parts.push(plan.still.imageType === "JPEG" ? t("JPEG {q}", { q: String(plan.still.quality) }) : String(plan.still.imageType));
    if (plan.still.imageType === "PDF") parts.push(tp(plan.slides.length, "{n} page", "{n} pages"));
  } else {
    parts.push(plan.animated!.format === "WEBM" ? "WebM" : "MP4", plan.codec ?? "", `${plan.fps} fps`, t("{rate} Mbps", { rate: ((plan.bitrate ?? 0) / 1e6).toFixed(1) }));
    if (plan.durationSec !== undefined) parts.push(secondsLabel(plan.durationSec));
  }
  if (plan.maxBytes) parts.push(t("≤ {n} MB", { n: String(Math.round(plan.maxBytes / (1024 * 1024))) }));
  return parts.filter(Boolean).join(" · ");
}

function ExportPosts({ ids }: { ids: Guid[] }) {
  useT();
  const ed = useEditor();
  const close = () => ed.ui.set({ socialExport: null });
  const [presets, setPresets] = useState<Record<Guid, string>>({});
  const [progress, setProgress] = useState<PostsProgress | null>(null);
  const [done, setDone] = useState<PostExportResult[] | null>(null);
  const controller = useRef<AbortController | null>(null);
  const plans = useMemo(() => planExports(ed, ids, presets), [ed, ids, presets]);
  const rows = useMemo(() => new Map(socialOf(ed).get().posts.map((p) => [p.id, p])), [ed]);
  const busy = progress !== null;

  const run = async () => {
    const ctl = new AbortController();
    controller.current = ctl;
    setProgress({ index: 0, total: plans.length, name: plans[0]?.name ?? "", frame: 0, frames: 0 });
    try {
      const { saved, result } = await exportAndSavePosts(ed, plans.map((p) => p.post), { preset: presets, onProgress: setProgress, signal: ctl.signal });
      const failed = result.posts.filter((p) => p.error);
      // What rendering found beyond the warnings already shown (an error, a size over its limit, a smaller JPEG).
      const shown = new Map(plans.map((p) => [p.post, p.warnings.length]));
      const noted = result.posts.filter((p) => p.error || p.warnings.length > (shown.get(p.post) ?? 0));
      if (saved) showToast({ message: tp(result.posts.length - failed.length, "Exported {n} post", "Exported {n} posts") });
      // Something to read (an error, a warning on a file): the dialog stays with the results; else it closes.
      if (noted.length && !ctl.signal.aborted) setDone(result.posts);
      else close();
    } finally {
      setProgress(null);
      controller.current = null;
    }
  };

  const file = plans.length === 1 ? plans[0].file.split("/").pop() : null;
  return (
    <Dialog
      title={plans.length === 1 ? t("Export post") : tp(plans.length, "Export {n} post", "Export {n} posts")}
      size="medium"
      open
      onClose={() => {
        controller.current?.abort();
        close();
      }}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            {t("Done")}
          </Button>
        ) : busy ? (
          <div className={styles.progress} role="status">
            <span>
              {progress.frames
                ? t("Exporting {name}: frame {frame} of {frames}…", { name: progress.name, frame: String(progress.frame), frames: String(progress.frames) })
                : t("Exporting {name} ({index} of {total})…", { name: progress.name, index: String(progress.index + 1), total: String(progress.total) })}
            </span>
            <Button variant="secondary" onClick={() => controller.current?.abort()}>
              {t("Cancel")}
            </Button>
          </div>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" disabled={!plans.length || !canExport(ed)} onClick={() => void run()} data-export-posts="">
              {t("Export")}
            </Button>
          </>
        )
      }
    >
      <div className={styles.body} data-export-posts-dialog="">
        <p className={styles.target}>{file ? file : plans.length > 1 ? t("One zip of {n} files, by campaign", { n: String(plans.length) }) : t("No posts to export")}</p>
        <div className={styles.list}>
          {plans.map((plan) => {
            const row = rows.get(plan.post);
            const result = done?.find((r) => r.post === plan.post);
            const notes = result ? [...(result.error ? [result.error] : []), ...result.warnings] : plan.warnings;
            const options = presetsFor(plan.formatId, row?.animated ?? false);
            return (
              <div key={plan.post} className={styles.row} data-export-post={plan.post} data-preset={plan.preset.id}>
                {row ? <PostThumb row={row} /> : <span />}
                <div className={styles.main}>
                  <div className={styles.head}>
                    <span className={styles.name}>{plan.name || t("Untitled")}</span>
                    <Select
                      label={t("Preset")}
                      value={plan.auto ? AUTO_PRESET : plan.preset.id}
                      options={[{ value: AUTO_PRESET, label: t("Auto ({preset})", { preset: t(autoPreset(plan.formatId, row?.animated ?? false).label) }) }, "-", ...options.map((p) => ({ value: p.id, label: t(p.label) }))]}
                      onChange={(v) => setPresets((s) => ({ ...s, [plan.post]: v }))}
                      disabled={busy || !!done}
                    />
                  </div>
                  <span className={styles.spec}>{planSummary(plan)}</span>
                  <span className={styles.file}>{plan.file}</span>
                  {notes.map((n) => (
                    <span key={n} className={styles.warning} data-export-warning="">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
