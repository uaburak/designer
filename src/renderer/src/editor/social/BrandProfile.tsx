/**
 * A page's brand as its Instagram profile (docs/social.md §34, the owner's ask 2026-11-03): each page of a Social file is
 * a brand's account, so the canvas (over the board, CanvasProfile) and the Prototype tab show that brand — its name, its
 * description (the bio), its profile picture (a logo), its counts. A page no brand is set up for shows a placeholder;
 * what is written there (a double-click on the name or the description, a click on the picture) makes the brand in the
 * library (Brands), named after the page when the name isn't given first, and sets it as the page's brand — its posts
 * without a brand take it too. A brand's edits go to the library the same way (Brands shows them).
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, showToast } from "@/ds";
import { t } from "@/i18n";
import type { Brand } from "@shared/studio/types";
import { useEditor, type EditorController } from "../controller";
import { brandsRepo, useBrands, useImageUrl } from "../studio/forms";
import { canWritePosts, editorWriter, setPost } from "./actions";
import { writePageBrand } from "./posts";
import { socialOf, useSocialBoard } from "./socialState";

export interface BrandProfile {
  brand: Brand | null;
  /** The brand's name, else the placeholder's ("Your brand") */
  name: string;
  handle: string;
  initial: string;
  description: string;
  /** The profile picture's logo, when the brand has one */
  avatar: { brandId: string; imageId: string } | null;
  /** The page's name: a new brand's when the name isn't given first */
  pageName: string;
}

/** The handle Instagram would show for `name`: lower case, letters, digits, "." and "_" only. */
export function handleOf(name: string): string {
  return name.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}._]+/gu, "") || "brand";
}

/** The current page's brand as a profile (re-rendering when the board or the library changes). */
export function useBrandProfile(): BrandProfile {
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const { brands } = useBrands();
  const id = board.brandId ?? ed.ui.get().socialBrandId ?? null;
  const brand = (id && brands?.find((b) => b.id === id)) || null;
  const name = brand?.name ?? t("Your brand");
  const logo = brand ? (brand.logos.find((l) => l.id === brand.avatar && l.role === "logo") ?? brand.logos.find((l) => l.role === "logo")) : undefined;
  const pageName = board.page ? ((ed.engine.readNode(board.page, { fields: ["name"] }) as { name?: string } | null)?.name ?? "") : "";
  return {
    brand,
    name,
    handle: handleOf(name),
    initial: name.trim().charAt(0).toLocaleUpperCase("tr") || "B",
    description: brand?.description ?? "",
    avatar: brand && logo ? { brandId: brand.id, imageId: logo.id } : null,
    pageName,
  };
}

/**
 * Writes the profile's `patch` to the page's brand in the library; with none yet, makes it (named `patch.name`, else
 * after the page) and makes it the page's brand (its posts without one take it). Returns the brand's id, or null when
 * it couldn't be saved (a toast says why).
 */
export async function saveBrandProfile(ed: EditorController, profile: BrandProfile, patch: { name?: string; description?: string; avatar?: string }): Promise<string | null> {
  if (!canWritePosts(ed)) return null;
  const brand = profile.brand;
  const name = (patch.name ?? brand?.name ?? (profile.pageName.trim() || t("Your brand"))).trim();
  if (!name) return brand?.id ?? null;
  try {
    const saved = await brandsRepo().saveBrand({ ...(brand ? { id: brand.id } : {}), name, ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}) });
    if (!brand && !ed.engine.destroyed) {
      const board = socialOf(ed).get();
      const loose = board.posts.filter((p) => !p.data.brandId).map((p) => p.id);
      editorWriter(ed)(t("Brand"), () => {
        writePageBrand(ed, board.page, saved.id);
        if (loose.length) setPost(ed, (_l, fn) => fn(), loose, { brandId: saved.id });
      });
    }
    return saved.id;
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    return null;
  }
}

/** A picture the user picks (PNG, JPEG or WebP) as the brand's new logo and profile picture. */
export function pickBrandAvatar(ed: EditorController, profile: BrandProfile): void {
  if (!canWritePosts(ed)) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const brandId = await saveBrandProfile(ed, profile, {});
      if (!brandId) return;
      try {
        const repo = brandsRepo();
        const image = await repo.addImage({ brandId, productId: null, role: "logo", name: file.name, data: btoa(bin) });
        const brand = await repo.get(brandId);
        if (brand) await repo.saveBrand({ id: brandId, name: brand.name, avatar: image.id });
      } catch (e) {
        showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
      }
    })();
  };
  input.click();
}

/** The profile picture: the brand's logo, else its initial. */
export function AvatarPicture({ profile, className }: { profile: BrandProfile; className?: string }) {
  return profile.avatar ? <LogoPicture brandId={profile.avatar.brandId} imageId={profile.avatar.imageId} className={className} /> : <span className={className}>{profile.initial}</span>;
}

function LogoPicture({ brandId, imageId, className }: { brandId: string; imageId: string; className?: string }) {
  const url = useImageUrl(brandId, imageId);
  return url ? <img src={url} alt="" className={className} draggable={false} /> : <span className={className} />;
}

/**
 * A profile field edited in place: a double-click shows an input (a textarea when `multiline`); Return (⌘↵ in a
 * textarea) or a click away saves it, Esc leaves it. `placeholder` shows, muted, when the value is empty.
 */
export function EditableField({ value, placeholder, multiline, maxLength, label, className, editingClassName, placeholderClassName, onCommit, children, ...data }: { value: string; placeholder: string; multiline?: boolean; maxLength?: number; label: string; className?: string; editingClassName?: string; placeholderClassName?: string; onCommit: (value: string) => void; children?: ReactNode } & Record<`data-${string}`, string>) {
  const ed = useEditor();
  const [editing, setEditing] = useState<string | null>(null);
  const commit = (v: string) => {
    setEditing(null);
    if (v.trim() !== value.trim()) onCommit(v.trim());
  };
  const keys = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(e.currentTarget.value);
    }
  };
  if (editing !== null) {
    const props = { className: cx(className, editingClassName), autoFocus: true, value: editing, maxLength, "aria-label": label, onChange: (e: { currentTarget: { value: string } }) => setEditing(e.currentTarget.value), onBlur: (e: { currentTarget: { value: string } }) => commit(e.currentTarget.value), onKeyDown: keys, ...data };
    return multiline ? <textarea {...props} rows={Math.max(2, editing.split("\n").length)} /> : <input {...props} />;
  }
  return (
    <span className={cx(className, !value && placeholderClassName)} onDoubleClick={() => canWritePosts(ed) && setEditing(value)} title={canWritePosts(ed) ? t("Double-click to edit") : undefined} {...data}>
      {value || placeholder}
      {children}
    </span>
  );
}
