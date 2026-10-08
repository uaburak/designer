/**
 * Missing fonts (help.figma.com "Missing font alert in Figma Design"): when the file names a font nobody has — a
 * family not installed nor served (Figma's Inter, Google Fonts), a style the family lacks, or a Google family that
 * can't be downloaded now — the left panel shows the missing font icon; it opens the "Missing fonts" dialog, which
 * lists each missing font with its layers and a Replacement (family and style, from the fonts available), and
 * "Replace fonts" swaps them everywhere in the file (one undo step; every text, run, text style and instance
 * override naming it).
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, Dialog, RailItem, Select } from "@/ds";
import { closestStyle, fonts, type FontFamily } from "@/engine/fonts";
import { useEditor } from "../controller";
import { missingFonts, useDocumentFonts, useFontFamilies, type DocumentFontUse } from "../fontList";
import { FontField } from "./design/FontPicker";
import { documentFamilies } from "./design/Typography";
import styles from "./Panels.module.css";

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
  const missing = useMissingFonts();
  const [open, setOpen] = useState(false);
  if (!missing.length) return null;
  return (
    <>
      <RailItem compact icon="24.missing-fonts" label="Missing fonts" active={open} data-missing-fonts={missing.length} onClick={() => setOpen(true)} />
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

export function MissingFontsDialog({ missing, onClose }: { missing: DocumentFontUse[]; onClose: () => void }) {
  const ed = useEditor();
  const list = useFontFamilies();
  const [choice, setChoice] = useState<Record<string, Replacement>>({});
  const key = (m: DocumentFontUse) => `${m.family}\n${m.style}`;
  const replacementOf = (m: DocumentFontUse) => choice[key(m)] ?? defaultReplacement(list, m);
  const replace = () => {
    const pairs = missing.map((m) => {
      const to = replacementOf(m);
      return { from: { family: m.family, style: m.style }, to: { family: to.family, style: to.style } };
    });
    ed.engine.command("REPLACE_FONTS", { fonts: pairs });
    onClose();
  };
  return (
    <Dialog
      title="Missing fonts"
      size="medium"
      open
      onClose={onClose}
      footer={
        <Button variant="primary" size="large" onClick={replace} data-replace-fonts="">
          Replace fonts
        </Button>
      }
    >
      <div className={styles.missingFonts} data-missing-fonts-dialog="">
        <p className={styles.missingIntro}>Some fonts used in this file aren’t available. Replace them with fonts you have; every layer in the file that uses them changes.</p>
        <div className={styles.missingHead}>
          <span>Missing font</span>
          <span>Replacement</span>
        </div>
        {missing.map((m) => {
          const r = replacementOf(m);
          const fam = list?.find((f) => f.family === r.family);
          return (
            <div key={key(m)} className={styles.missingRow} data-missing-font={`${m.family} ${m.style}`}>
              <div className={styles.missingName}>
                <span>{m.family}</span>
                <span className={styles.missingStyle}>
                  {m.style} · {m.uses === 1 ? "1 layer" : `${m.uses} layers`}
                </span>
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
                  label="Replacement style"
                  value={r.style}
                  options={(fam?.styles ?? [r.style]).map((s) => ({ value: s, label: s }))}
                  onChange={(s) => setChoice({ ...choice, [key(m)]: { family: r.family, style: s } })}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
