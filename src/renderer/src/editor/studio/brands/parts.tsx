/**
 * Small pieces the Brands view's pages share: a library picture, a brand's logo, the delete confirmation, a top bar.
 */
import { useState, type ReactNode } from "react";
import { Button, Dialog, IconButton, cx, showToast } from "@/ds";
import { t, useT } from "@/i18n";
import type { Brand, Product } from "../../../../../shared/studio/types";
import { useImageUrl } from "../forms";
import styles from "./BrandsView.module.css";

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What the view can do beyond the library (the editor's agent and text model); absent at Home. */
export interface BrandsActions {
  /** Puts text in the agent's composer */
  askAgent(text: string): void;
  /** Design posts about the brand (and the products picked, when any) */
  designPosts(brand: Brand, products: readonly Product[]): void;
  /** Reads a product's label texts off its pictures (saved unconfirmed); an error's text, or null */
  readLabels(brandId: string, productId: string): Promise<string | null>;
}

/** A library picture filling its box (`fit` contain), or the box empty while it loads. */
export function LibraryImage({ brandId, imageId, alt = "", className }: { brandId: string; imageId: string; alt?: string; className?: string }) {
  const url = useImageUrl(brandId, imageId);
  return url ? <img className={cx(styles.image, className)} src={url} alt={alt} draggable={false} /> : <span className={cx(styles.image, className)} />;
}

export function BrandLogo({ brand, className }: { brand: Brand; className?: string }) {
  const logo = brand.logos.find((i) => i.role === "logo");
  return <span className={cx(styles.logo, className)}>{logo ? <LibraryImage brandId={brand.id} imageId={logo.id} alt={brand.name} /> : <span className={styles.logoLetter}>{brand.name.trim().charAt(0).toLocaleUpperCase()}</span>}</span>;
}

/** The page's top bar: Back (when there is somewhere to go back to), its title or breadcrumb, its actions, Close. */
export function TopBar({ onBack, children, actions, onClose }: { onBack?: () => void; children: ReactNode; actions?: ReactNode; onClose?: () => void }) {
  useT();
  return (
    <header className={styles.topBar} data-brands-topbar="">
      {onBack && <IconButton icon="24.arrow.left" label={t("Back")} tone="secondary" onClick={onBack} data-brands-back="" />}
      <div className={styles.topTitle}>{children}</div>
      {actions && <div className={styles.topActions}>{actions}</div>}
      {onClose && <IconButton icon="24.close" label={t("Close")} tone="secondary" onClick={onClose} data-brands-close="" />}
    </header>
  );
}

export function ConfirmDelete({ open, title, body, onClose, onConfirm }: { open: boolean; title: string; body: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  useT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            size="large"
            disabled={busy}
            data-confirm-delete=""
            onClick={() => {
              setBusy(true);
              onConfirm().then(
                () => setBusy(false),
                (e: unknown) => {
                  setBusy(false);
                  onClose();
                  showToast({ message: messageOf(e), kind: "error" });
                }
              );
            }}
          >
            {t("Delete")}
          </Button>
        </>
      }
    >
      <p className={styles.text}>{body}</p>
    </Dialog>
  );
}

/** A readiness bar: its name, n / of, and the share filled (full: the success colour). */
export function Meter({ label, n, of }: { label: string; n: number; of: number }) {
  const share = of ? n / of : 0;
  return (
    <div className={styles.meter} data-meter={label}>
      <div className={styles.meterRow}>
        <span>{label}</span>
        <span className={styles.meterCount}>
          {n}/{of}
        </span>
      </div>
      <span className={styles.meterTrack} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={n}>
        <span className={styles.meterFill} data-full={(of > 0 && n === of) || undefined} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </div>
  );
}
