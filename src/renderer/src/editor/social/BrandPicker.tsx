/**
 * The board's brand (docs/social.md §6.2): the library's brands, "No brand", and Manage brands… (the Brands tab). The
 * pick is `ui.socialBrandId`, kept per file (SocialMode); new posts and inserted templates take it.
 */
import { Select } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { useBrands } from "../studio/forms";

const NONE = "none";
const MANAGE = "manage";

export function BrandPicker({ className }: { className?: string }) {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const id = useUI((s) => s.socialBrandId ?? null);
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
        ed.ui.set({ socialBrandId: v === NONE ? null : v });
      }}
      data-social-brand=""
    />
  );
}
