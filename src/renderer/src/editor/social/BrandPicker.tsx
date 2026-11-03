/**
 * The board's brand (docs/social.md §6.2, §34): the library's brands, "No brand", and Manage brands… (the Brands tab).
 * The pick is the page's (its `brand` record, one undo step; a page is a brand's account) and the file's default for
 * pages without one (`ui.socialBrandId`, kept per file by SocialMode); new posts and inserted templates take it.
 */
import { Select } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { useBrands } from "../studio/forms";
import { canWritePosts, editorWriter } from "./actions";
import { writePageBrand } from "./posts";
import { useSocialBoard } from "./socialState";

const NONE = "none";
const MANAGE = "manage";

export function BrandPicker({ className }: { className?: string }) {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const board = useSocialBoard(ed);
  const fallback = useUI((s) => s.socialBrandId ?? null);
  const id = board.brandId ?? fallback;
  // A brand removed from the library reads as none.
  const value = id && brands?.some((b) => b.id === id) ? id : NONE;
  return (
    <Select
      label={t("Brand")}
      className={className}
      value={value}
      prefix="24.library"
      options={[...(brands ?? []).map((b) => ({ value: b.id, label: b.name })), ...(brands?.length ? (["-"] as const) : []), { value: NONE, label: t("No brand") }, "-", { value: MANAGE, label: t("Manage brands…") }]}
      onChange={(v) => {
        if (v === MANAGE) return ed.ui.set({ railTab: "brands", variablesOpen: false });
        const brandId = v === NONE ? null : v;
        if (board.page && canWritePosts(ed)) editorWriter(ed)(t("Brand"), () => writePageBrand(ed, board.page, brandId));
        ed.ui.set({ socialBrandId: brandId });
      }}
      data-social-brand=""
    />
  );
}
