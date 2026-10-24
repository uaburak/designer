/**
 * File › Convert to Social file… (docs/social.md §18.1, the owner's wireframe H): Copy as a new Social file (the
 * default — the Design file stays as it is) or Convert this file (a version saved first); what was found, page by page
 * with the page's brand, each row's format (the size's, changeable; a size that fits none is skipped); Convert. Also
 * mounted for what waits for this editor as it opens: a Social copy's conversion, Home's "open with the dialog".
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Dialog, RadioGroup, Select, showToast, type SelectEntry } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { conversionCounts, defaultChoices, formatsFitting, type ConvertFound, type ConvertRow, type RowChoice } from "@shared/social/convert";
import { useEditor } from "../../controller";
import { useUI } from "../../hooks";
import { useBrands } from "../../studio/forms";
import { applyPendingConversion, canConvertInPlace, convertToSocialFile, findInEditor, openPendingDialog } from "./convert";
import styles from "./ConvertToSocialDialog.module.css";

const SKIP = "skip";

/** The dialog when it is open, and what waits for this editor as it opens (once). */
export function ConvertToSocial() {
  const ed = useEditor();
  const open = useUI((s) => !!s.socialConvertDialog);
  useEffect(() => {
    applyPendingConversion(ed);
    openPendingDialog(ed);
  }, [ed]);
  return open ? <ConvertForm /> : null;
}

const size = (r: { width: number; height: number }) => `${r.width} × ${r.height}`;

function ConvertForm() {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const found: ConvertFound = useMemo(() => findInEditor(ed, brands ?? []), [ed, brands]);
  const [choices, setChoices] = useState<Record<string, RowChoice>>(() => defaultChoices(found));
  const inPlace = canConvertInPlace(ed);
  const [mode, setMode] = useState<"copy" | "convert">("copy");
  const [busy, setBusy] = useState(false);
  const name = useUI((s) => s.fileName) || ed.source.fileName;
  const close = () => {
    ed.ui.set({ socialConvertDialog: false });
    ed.focusCanvas();
  };
  const counts = conversionCounts(found, choices);
  const total = found.pages.reduce((n, p) => n + p.rows.reduce((m, r) => m + r.count, 0), 0);
  const choose = (row: ConvertRow, next: RowChoice) => setChoices((c) => ({ ...c, [row.id]: next }));
  const run = async () => {
    setBusy(true);
    try {
      await convertToSocialFile(ed, found, choices, mode);
      close();
    } catch (e) {
      setBusy(false);
      showToast({ kind: "error", message: t("Couldn’t convert to a Social file: {reason}", { reason: e instanceof Error ? e.message : String(e) }) });
    }
  };
  return (
    <Dialog
      title={t("Convert to Social file")}
      size="medium"
      open
      onClose={close}
      footer={
        <>
          <span className={styles.summary}>{t("{designs} · {skipped}", { designs: tp(counts.designs, "1 design moves to Social", "{n} designs move to Social"), skipped: tp(counts.skipped, "1 skipped", "{n} skipped") })}</span>
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={busy || counts.designs === 0} onClick={() => void run()}>
            {t("Convert")}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <RadioGroup
          label={t("Convert to Social file")}
          value={mode}
          options={[
            { value: "copy", label: t("Copy as a new Social file “{name}”", { name }) },
            { value: "convert", label: t("Convert this file"), disabled: !inPlace },
          ]}
          onChange={(v) => setMode(v === "convert" ? "convert" : "copy")}
        />
        <p className={styles.note}>{mode === "copy" ? t("Recommended: the Design file stays as it is. The copy holds the pages below.") : t("A version is saved first. The file becomes a Social file and keeps its other pages.")}</p>
        <div className={styles.found}>{tp(total, "Found · 1 frame", "Found · {n} frames")}</div>
        {found.pages.length === 0 ? (
          <p className={styles.note}>{t("No frames of a social format’s size were found.")}</p>
        ) : (
          <div className={styles.list}>
            {found.pages.map((p) => (
              <section key={p.pageId} className={styles.page}>
                <div className={styles.pageHead}>
                  <span className={styles.pageName}>{p.pageName}</span>
                  {p.brand && <span className={styles.brand}>{t("→ brand: {brand}", { brand: p.brand.name })}</span>}
                </div>
                {p.rows.map((r) => (
                  <RowView key={r.id} row={r} choice={choices[r.id] ?? { checked: false, formatId: null }} onChange={(c) => choose(r, c)} />
                ))}
              </section>
            ))}
          </div>
        )}
        {found.leftOut.length > 0 && <p className={styles.leftOut}>{t("Left out: {pages}", { pages: found.leftOut.map((p) => p.pageName).join(", ") })}</p>}
      </div>
    </Dialog>
  );
}

function RowView({ row, choice, onChange }: { row: ConvertRow; choice: RowChoice; onChange: (c: RowChoice) => void }) {
  const fitting = formatsFitting(row.width, row.height);
  const options: SelectEntry[] = [{ value: SKIP, label: t("Skip (no format)") }, ...(fitting.length ? (["-"] as const) : []), ...fitting.map((f) => ({ value: f.id, label: t(f.name), hint: size(f) }))];
  const value = choice.checked && choice.formatId ? choice.formatId : SKIP;
  const title = row.kind === "container" ? t("“{name}” holds {n} designs", { name: row.name, n: String(row.count) }) : t("“{name}”", { name: row.name });
  return (
    <div className={styles.row}>
      <Checkbox label={title} hideLabel checked={value !== SKIP} disabled={!fitting.length} onChange={(on) => onChange(on ? { checked: true, formatId: choice.formatId ?? row.suggested ?? fitting[0]?.id ?? null } : { ...choice, checked: false })} />
      <div className={styles.what}>
        <span className={styles.name}>{title}</span>
        {row.kind === "container" && <span className={styles.detail}>{t("the container is unwrapped, order kept")}</span>}
      </div>
      <span className={styles.size}>{size(row)}</span>
      <Select label={t("Format")} value={value} options={options} width={180} onChange={(v) => onChange(v === SKIP ? { ...choice, checked: false } : { checked: true, formatId: v })} />
    </div>
  );
}
