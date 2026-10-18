/**
 * Missing fonts (help.figma.com "Missing font alert in Figma Design"): when the file names a font nobody has — a
 * family not installed nor served (Figma's Inter, Google Fonts), a style the family lacks, or a Google family that
 * can't be downloaded now — the left panel shows the missing font icon; it opens the "Missing fonts" dialog, which
 * lists each missing font with its layers and a Replacement (family and style, from the fonts available), and
 * "Replace fonts" swaps them (one undo step; every text, run, text style and instance override naming it).
 *
 * Its scope is Figma's (atlas 06 §7): Current selection (when something is selected), Current page or All pages —
 * the engine reads the fonts the layers in and inside them name (`documentFonts(refs)`), each row offers "Select N
 * items using this font" there, and the selection's scope has "Replace on the whole page". Every page is in the
 * engine already, so All pages needs no "Finding missing fonts" wait. Which scope it opens on isn't read: here the
 * current page when it has a missing font, else All pages.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Dialog, RailItem, Select } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import { closestStyle, fonts, type FontFamily } from "@/engine/fonts";
import { useEditor } from "../controller";
import { missingFonts, useDocumentFonts, useFontFamilies, type DocumentFontUse } from "../fontList";
import { FontField } from "./design/FontPicker";
import { documentFamilies } from "./design/Typography";
import styles from "./Panels.module.css";
import { t, tp, useT } from "@/i18n";

const subscribeMissing = (cb: () => void) => fonts.onMissingChange(cb);
let missingVersion = 0;
fonts.onMissingChange(() => missingVersion++);

/** The file's missing fonts (computed from the document and the list, plus names the engine was told are missing). */
export function useMissingFonts(): DocumentFontUse[] {
  const ed = useEditor();
  const list = useFontFamilies();
  const used = useDocumentFonts(ed.engine, 1000);
  const version = useSyncExternalStore(subscribeMissing, () => missingVersion);
  return useMemo(() => {
    const out = missingFonts(list, used);
    // A face that couldn't be read (a Google family offline): missing too.
    const failed = new Set(fonts.missing().map((m) => `${m.family}\n${m.style}`.toLowerCase()));
    for (const u of used) if (failed.has(`${u.family}\n${u.style}`.toLowerCase()) && !out.includes(u)) out.push(u);
    return out;
    // `version` re-reads the service's missing names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, used, version]);
}

/**
 * The missing font alert, a notification at the bottom of the navigation bar (Figma 2026: "File notifications and
 * warnings, such as library updates and missing font alerts, are now at the bottom of the navigation bar"); shown
 * only while some font is missing; it opens the dialog.
 */
export function MissingFontsButton() {
  useT();
  const missing = useMissingFonts();
  const [open, setOpen] = useState(false);
  if (!missing.length) return null;
  return (
    <>
      <RailItem compact icon="24.missing-fonts" label={t("Missing fonts")} active={open} data-missing-fonts={missing.length} onClick={() => setOpen(true)} />
      {open && <MissingFontsDialog missing={missing} onClose={() => setOpen(false)} />}
    </>
  );
}

interface Replacement {
  family: string;
  style: string;
}

/** Figma's default replacement: the same style of Inter (its default font), else Inter Regular. */
function defaultReplacement(list: readonly FontFamily[] | null, m: DocumentFontUse): Replacement {
  const inter = list?.find((f) => f.family === "Inter");
  return { family: "Inter", style: inter ? closestStyle(inter.styles, m.style) : "Regular" };
}

/** The dialog's scope (Figma's `missing_fonts_modal` scope menu). */
export type MissingFontsScope = "selection" | "page" | "all";

/** A missing font as a scope sees it: its uses there and, in a page or selection scope, the layers naming it. */
export interface ScopedMissingFont extends DocumentFontUse {
  nodes?: Guid[];
}

/**
 * The file's missing fonts within a scope: those the scope's layers name (`scoped`, the engine's `documentFonts(refs)`),
 * with the scope's counts and layers; all of them for the whole file (`scoped` null).
 */
export function missingInScope(missing: readonly DocumentFontUse[], scoped: readonly (DocumentFontUse & { nodes?: Guid[] })[] | null): ScopedMissingFont[] {
  if (!scoped) return [...missing];
  const k = (f: { family: string; style: string }) => `${f.family}\n${f.style}`.toLowerCase();
  const byKey = new Map(scoped.map((f) => [k(f), f]));
  const out: ScopedMissingFont[] = [];
  for (const m of missing) {
    const s = byKey.get(k(m));
    if (s) out.push({ ...m, uses: s.uses, nodes: s.nodes });
  }
  return out;
}

export function MissingFontsDialog({ missing, onClose }: { missing: DocumentFontUse[]; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const list = useFontFamilies();
  const page = useCurrentPage(ed.store);
  const selection = useSelection(ed.store).refs;
  const pageMissing = useMemo(() => missingInScope(missing, ed.engine.documentFonts([page])), [ed, missing, page]);
  const [scope, setScope] = useState<MissingFontsScope>(() => (pageMissing.length ? "page" : "all"));
  const [wholePage, setWholePage] = useState(false);
  const [choice, setChoice] = useState<Record<string, Replacement>>({});
  const effective: MissingFontsScope = scope === "selection" && !selection.length ? "page" : scope;
  const roots: Guid[] | null = effective === "all" ? null : effective === "page" || wholePage ? [page] : selection;
  const shown = useMemo(
    () => (effective === "page" ? pageMissing : missingInScope(missing, roots ? ed.engine.documentFonts(roots) : null)),
    // `roots` is derived from the values listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, missing, effective, pageMissing, wholePage, selection, page]
  );
  const others = missing.length - shown.length;
  const key = (m: DocumentFontUse) => `${m.family}\n${m.style}`;
  const replacementOf = (m: DocumentFontUse) => choice[key(m)] ?? defaultReplacement(list, m);
  const replace = () => {
    const pairs = shown.map((m) => {
      const to = replacementOf(m);
      return { from: { family: m.family, style: m.style }, to: { family: to.family, style: to.style } };
    });
    if (pairs.length) ed.engine.command("REPLACE_FONTS", { fonts: pairs, ...(roots ? { nodes: roots } : {}) });
    onClose();
  };
  const selectUses = (nodes: Guid[]) => {
    ed.engine.setSelection(nodes);
    onClose();
  };
  const scopes = [
    ...(selection.length ? [{ value: "selection", label: t("Current selection") }] : []),
    { value: "page", label: t("Current page") },
    { value: "all", label: t("All pages") },
  ];
  return (
    <Dialog
      title={t("Missing fonts")}
      size="medium"
      open
      onClose={onClose}
      footer={
        <>
          {effective === "selection" && (
            <Checkbox label={t("Replace on the whole page")} checked={wholePage} onChange={setWholePage} className={styles.missingWholePage} data-whole-page="" />
          )}
          <Button variant="primary" size="large" onClick={replace} disabled={!shown.length} data-replace-fonts="">
            {t("Replace fonts")}
          </Button>
        </>
      }
    >
      <div className={styles.missingFonts} data-missing-fonts-dialog="" data-scope={effective}>
        <p className={styles.missingIntro}>{t("Some fonts used in this file aren’t available. Replace them with fonts you have; the layers in the scope below that use them change.")}</p>
        <Select label={t("Scope")} value={effective} options={scopes} onChange={(v) => setScope(v as MissingFontsScope)} width="hug" className={styles.missingScope} data-missing-scope="" />
        <div className={styles.missingHead}>
          <span>{t("Missing font")}</span>
          <span>{t("Replacement")}</span>
        </div>
        {shown.map((m) => {
          const r = replacementOf(m);
          const fam = list?.find((f) => f.family === r.family);
          return (
            <div key={key(m)} className={styles.missingRow} data-missing-font={`${m.family} ${m.style}`}>
              <div className={styles.missingName}>
                <span>{m.family}</span>
                <span className={styles.missingStyle}>
                  {m.style} · {tp(m.uses, "{n} layer", "{n} layers")}
                </span>
                {m.nodes?.length ? (
                  <Button variant="link" className={styles.missingSelect} onClick={() => selectUses(m.nodes!)} data-select-uses="">
                    {tp(m.nodes.length, "Select {n} item using this font", "Select {n} items using this font")}
                  </Button>
                ) : null}
              </div>
              <div className={styles.missingPick}>
                <FontField
                  family={r.family}
                  style={r.style}
                  list={list}
                  fileFamilies={() => documentFamilies(ed.engine)}
                  onPick={(f) => setChoice({ ...choice, [key(m)]: { family: f.family, style: closestStyle(list?.find((x) => x.family === f.family)?.styles ?? [f.style], m.style) } })}
                />
                <Select
                  label={t("Replacement style")}
                  value={r.style}
                  options={(fam?.styles ?? [r.style]).map((s) => ({ value: s, label: s }))}
                  onChange={(s) => setChoice({ ...choice, [key(m)]: { family: r.family, style: s } })}
                />
              </div>
            </div>
          );
        })}
        {!shown.length && <p className={styles.missingIntro}>{effective === "selection" ? t("No missing fonts in the selection.") : t("No missing fonts on this page.")}</p>}
        {others > 0 && (
          <Button variant="link" className={styles.missingSelect} onClick={() => setScope("all")} data-show-other-missing="">
            {t("Show other missing fonts")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
