/**
 * The Brands library's banner (docs/social.md §4.1 step 2): over the canvas of the file that is the Brands library —
 * its marker, or a brand's `libraryFileKey` on a new file — "Brands library · ‹n› brands changed" with Update (the
 * library brought up to the Brands panel, one undo step) and Publish… (Figma's Publish dialog; the owner presses
 * Publish). On the new, empty file Update runs at once and the Publish dialog opens after it.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { useEditor, type EditorController } from "../../controller";
import { useBrands } from "../../studio/forms";
import { canWritePosts, editorWriter } from "../actions";
import { useSocialBoard } from "../socialState";
import { changedBrands, isBrandsLibrary, readBrandLibrary, updateBrandLibrary } from "./brandLibrary";
import styles from "./Templates.module.css";

/** Nothing drawn on the page shown: the file was just made (a new file's Thumbnail page aside). */
const isEmpty = (ed: EditorController) => !(ed.engine.readNode(ed.store.page, { childIds: true })?.childIds ?? []).length;

export function BrandLibraryBanner() {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  useSocialBoard(ed); // re-read on every document change
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const library = !!brands && isBrandsLibrary(ed, brands);
  const marker = readBrandLibrary(ed);
  const changed = brands ? changedBrands(marker, brands) : 0;
  const write = canWritePosts(ed);

  const update = async (thenPublish: boolean) => {
    if (!brands || busy) return;
    setBusy(true);
    try {
      await updateBrandLibrary(ed, editorWriter(ed), brands);
      showToast({ message: t("Brands library updated") });
      if (thenPublish) ed.ui.set({ publishOpen: true });
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // A new, empty library file: Update at once, then the Publish dialog.
  useEffect(() => {
    if (started.current || !library || marker || !write || !brands?.length || !isEmpty(ed)) return;
    started.current = true;
    void update(true);
  });

  if (!library) return null;
  return (
    <Banner tone="brand" icon="24.library" className={styles.banner} action={write ? { label: busy ? t("Updating…") : t("Update"), onClick: () => void update(false) } : undefined} data-brand-library-banner={changed}>
      <span className={styles.bannerText}>
        {changed ? tp(changed, "Brands library · {n} brand changed", "Brands library · {n} brands changed") : t("Brands library · up to date")}
        {write && (
          <Button variant="ghost" onClick={() => ed.ui.set({ publishOpen: true })} data-brand-library-publish="">
            {t("Publish…")}
          </Button>
        )}
      </span>
    </Banner>
  );
}
