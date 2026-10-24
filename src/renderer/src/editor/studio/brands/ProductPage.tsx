/**
 * K · A product's page (docs/studio.md §3.2): Brands › brand › series › product with the previous / next product (in
 * the brand page's order) and Edit; at the left its pictures by role — the one picked large, the others as thumbnails,
 * a tile to drop, paste or pick more; at the right its readiness (missingFor's steps), shape, notes and the label
 * texts table (Sharp / Soft, Read label from photos, These texts are checked).
 */
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button, Checkbox, Icon, IconButton, MenuButton, Select, TextInput, cx } from "@/ds";
import { t, useT } from "@/i18n";
import type { Brand, BrandImageRole, LabelTier, Product } from "../../../../../shared/studio/types";
import { brandsRepo, stageFiles } from "../forms";
import { filterProducts, productReadiness, seriesKey, type ProductFilter, type SeriesFilter } from "./model";
import { ConfirmDelete, LibraryImage, TopBar, messageOf, type BrandsActions } from "./parts";
import styles from "./BrandsView.module.css";

const TIERS = [
  { value: "sharp", label: "Sharp" },
  { value: "soft", label: "Soft" },
];
const ROLES: { role: BrandImageRole; label: string }[] = [
  { role: "packshot", label: "Product photo" },
  { role: "label", label: "Label close-up" },
];
const TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Notes longer than this fold (Show more) */
const NOTES_FOLD = 280;

export interface ProductPageProps {
  brand: Brand;
  product: Product;
  /** The brand page's filter: the arrows step through the products it shows */
  filter: ProductFilter;
  actions: BrandsActions | null;
  onClose?: () => void;
  onBack(): void;
  onList(): void;
  /** The brand's page; with `series`, filtered to it */
  onBrand(series?: SeriesFilter): void;
  onProduct(id: string): void;
  onEdit(): void;
}

export function ProductPage({ brand, product, filter, actions, onClose, onBack, onList, onBrand, onProduct, onEdit }: ProductPageProps) {
  useT();
  const [confirm, setConfirm] = useState(false);
  const order = useMemo(() => {
    const shown = filterProducts(brand.products, filter);
    return shown.some((p) => p.id === product.id) ? shown : filterProducts(brand.products, { ...filter, series: "all", labelsUnconfirmed: false, noPhoto: false, query: "" });
  }, [brand.products, filter, product.id]);
  const at = order.findIndex((p) => p.id === product.id);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  const key = seriesKey(product);
  return (
    <>
      <TopBar
        onBack={onBack}
        onClose={onClose}
        actions={
          <>
            <IconButton icon="24.chevron.left" label={t("Previous product")} disabled={!prev} onClick={() => prev && onProduct(prev.id)} data-product-prev="" />
            {/* The kit's right chevron is the small one: the left one, mirrored */}
            <IconButton icon="24.chevron.left" className={styles.mirrored} label={t("Next product")} disabled={!next} onClick={() => next && onProduct(next.id)} data-product-next="" />
            <Button variant="secondary" icon="24.pencil" onClick={onEdit} data-product-edit="">
              {t("Edit")}
            </Button>
            <MenuButton label={t("{name} options", { name: product.name })} entries={[{ id: "delete", label: t("Delete product") }]} onSelect={() => setConfirm(true)} className={styles.iconMenu} align="end">
              <Icon name="24.more" />
            </MenuButton>
          </>
        }
      >
        <nav className={styles.crumbs} aria-label={t("Breadcrumb")} data-product-crumbs="">
          <button type="button" className={styles.crumb} onClick={onList}>
            {t("Brands")}
          </button>
          <span className={styles.crumbSep}>/</span>
          <button type="button" className={styles.crumb} onClick={() => onBrand()}>
            {brand.name}
          </button>
          {key && (
            <>
              <span className={styles.crumbSep}>/</span>
              <button type="button" className={styles.crumb} onClick={() => onBrand({ key })}>
                {product.series}
              </button>
            </>
          )}
          <span className={styles.crumbSep}>/</span>
          <span className={styles.topName} aria-current="page">
            {product.name}
          </span>
        </nav>
      </TopBar>
      <div className={styles.scroll} data-product-page={product.id}>
        <div className={styles.productLayout}>
          {/* Keyed: another product starts on its own pictures, without the last one's problem */}
          <ProductPictures key={product.id} brand={brand} product={product} />
          <div className={styles.productSide}>
            <Readiness brand={brand} product={product} actions={actions} />
            <section className={styles.block}>
              <h3 className={styles.blockTitle}>{t("Shape")}</h3>
              {product.shape ? <p className={styles.text}>{product.shape}</p> : <p className={styles.muted}>{t("No shape described yet.")}</p>}
            </section>
            {product.notes && <Notes text={product.notes} />}
            <LabelTexts key={product.id} brand={brand} product={product} actions={actions} />
          </div>
        </div>
      </div>
      <ConfirmDelete
        open={confirm}
        title={t("Delete product")}
        body={t("{name} and its pictures leave the library. This can't be undone.", { name: product.name })}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await brandsRepo().removeProduct(brand.id, product.id);
          onBrand();
        }}
      />
    </>
  );
}

// ── Pictures ──────────────────────────────────────────────────────────────────────────────────────────────────────

function ProductPictures({ brand, product }: { brand: Brand; product: Product }) {
  useT();
  const [role, setRole] = useState<BrandImageRole>(product.images.some((i) => i.role === "packshot") || !product.images.length ? "packshot" : "label");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ofRole = product.images.filter((i) => i.role === role);
  const big = ofRole.find((i) => i.id === pickedId) ?? ofRole[0] ?? null;
  const take = async (files: Iterable<File>) => {
    const { staged, refused } = await stageFiles(files, role);
    setProblem(refused[0] ?? null);
    try {
      for (const s of staged) await brandsRepo().addImage({ brandId: brand.id, productId: product.id, role, name: s.name, data: s.data });
    } catch (e) {
      setProblem(messageOf(e));
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    void take(files);
  };
  const remove = (id: string) => void brandsRepo().removeImage(brand.id, id).catch((e: unknown) => setProblem(messageOf(e)));
  return (
    <section className={styles.picturesColumn} aria-label={t("Pictures")} data-product-pictures="">
      <div className={styles.roleChips} role="group" aria-label={t("Pictures")}>
        {ROLES.map((r) => (
          <button key={r.role} type="button" className={styles.roleChip} aria-pressed={role === r.role} onClick={() => (setRole(r.role), setPickedId(null))} data-role-chip={r.role}>
            {t(r.label)} <span className={styles.roleCount}>{product.images.filter((i) => i.role === r.role).length}</span>
          </button>
        ))}
      </div>
      <div className={styles.bigPhoto} data-big-photo={big?.id ?? ""}>
        {big ? (
          <>
            <LibraryImage brandId={brand.id} imageId={big.id} alt={big.name} />
            <IconButton icon="24.trash" label={t("Remove {name}", { name: big.name })} className={styles.bigRemove} onClick={() => remove(big.id)} />
          </>
        ) : (
          <span className={styles.bigEmpty}>
            <Icon name="24.image" />
            {role === "packshot" ? t("No product photo yet.") : t("No label close-up yet.")}
          </span>
        )}
      </div>
      <div className={styles.thumbs}>
        {ofRole.map((i) => (
          <button key={i.id} type="button" className={styles.thumb} aria-pressed={big?.id === i.id} aria-label={i.name} onClick={() => setPickedId(i.id)} data-thumb={i.id}>
            <LibraryImage brandId={brand.id} imageId={i.id} />
          </button>
        ))}
        <div
          className={styles.addTile}
          role="button"
          tabIndex={0}
          aria-label={role === "packshot" ? t("Add product photos") : t("Add label close-ups")}
          title={t("Drop, paste or choose pictures")}
          data-over={over || undefined}
          data-add-tile={role}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onPaste={onPaste}
        >
          <Icon name="24.plus" />
        </div>
        <input
          ref={input}
          className={styles.file}
          type="file"
          accept={TYPES.join(",")}
          multiple
          tabIndex={-1}
          aria-hidden
          data-file-input={role}
          onChange={(e) => {
            void take([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = "";
          }}
        />
      </div>
      <p className={styles.mutedSmall}>{t("Drop, paste or choose pictures")}</p>
      {problem && (
        <div className={styles.problem} role="alert">
          {problem}
        </div>
      )}
    </section>
  );
}

// ── Readiness, notes, label texts ─────────────────────────────────────────────────────────────────────────────────

function Readiness({ brand, product, actions }: { brand: Brand; product: Product; actions: BrandsActions | null }) {
  useT();
  const { steps, missing } = productReadiness(brand, product);
  const done = steps.filter((s) => s.done).length;
  return (
    <section className={styles.block} data-readiness="">
      <h3 className={styles.blockTitle}>
        {t("Readiness")}
        <span className={styles.blockCount}>
          {done}/{steps.length}
        </span>
      </h3>
      <ul className={styles.checklist}>
        {steps.map((s) => (
          <li key={s.field} className={styles.check} data-step={s.field} data-done={s.done || undefined}>
            <span className={styles.checkMark}>{s.done && <Icon name="16.check" />}</span>
            {t(s.label)}
          </li>
        ))}
      </ul>
      {actions && missing.length > 0 && (
        <div className={styles.actionsRow}>
          <Button
            variant="secondary"
            icon="24.rail.agents"
            onClick={() => actions.askAgent(t("Complete {name} of {brand} in the library: {missing}", { name: product.name, brand: brand.name, missing: missing.map((m) => m.message).join("; ") }))}
            data-complete-agent=""
          >
            {t("Complete with the agent")}
          </Button>
        </div>
      )}
    </section>
  );
}

function Notes({ text }: { text: string }) {
  useT();
  const long = text.length > NOTES_FOLD;
  const [open, setOpen] = useState(!long);
  return (
    <section className={styles.block} data-notes="">
      <h3 className={styles.blockTitle}>{t("Notes")}</h3>
      <p className={cx(styles.text, !open && styles.folded)}>{text}</p>
      {long && (
        <div className={styles.actionsRow}>
          <Button variant="link" onClick={() => setOpen((o) => !o)} data-notes-toggle="">
            {open ? t("Show less") : t("Show more")}
          </Button>
        </div>
      )}
    </section>
  );
}

function LabelTexts({ brand, product, actions }: { brand: Brand; product: Product; actions: BrandsActions | null }) {
  useT();
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const repo = brandsRepo();
  const guard = (p: Promise<unknown>) => p.catch((e: unknown) => setProblem(messageOf(e)));
  const saveLabels = (labels: { id?: string; text: string; tier: LabelTier }[], labelsConfirmed?: boolean) =>
    guard(repo.saveProduct({ id: product.id, brandId: brand.id, name: product.name, labels, ...(labelsConfirmed !== undefined ? { labelsConfirmed } : {}) }));
  const setLabel = (id: string, patch: Partial<{ text: string; tier: LabelTier }>) => saveLabels(product.labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const read = async () => {
    if (!actions) return;
    setReading(true);
    setProblem(null);
    const p = await actions.readLabels(brand.id, product.id);
    setReading(false);
    if (p) setProblem(p);
  };
  return (
    <section className={styles.block} data-labels="">
      <h3 className={styles.blockTitle}>{t("Label texts")}</h3>
      {product.labels.length > 0 && (
        <div className={styles.labelTable} role="table" aria-label={t("Label texts")}>
          {product.labels.map((l) => (
            <div key={l.id} className={styles.labelRow} role="row">
              <TextInput label={t("Label text")} value={l.text} onCommit={(v) => void setLabel(l.id, { text: v })} />
              <Select label={t("Tier")} className={styles.tier} value={l.tier} options={TIERS.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => void setLabel(l.id, { tier: v as LabelTier })} />
              <IconButton icon="16.close" label={t("Remove text")} onClick={() => void saveLabels(product.labels.filter((x) => x.id !== l.id))} />
            </div>
          ))}
        </div>
      )}
      {!product.labels.length && <p className={styles.muted}>{t("No label texts yet.")}</p>}
      <p className={styles.mutedSmall}>{t("Sharp texts are written exactly in pictures. Soft ones (small print) are left illegible.")}</p>
      <div className={styles.actionsRow}>
        <Button variant="secondary" icon="24.plus.small" onClick={() => void saveLabels([...product.labels, { text: t("New text"), tier: "sharp" }])}>
          {t("Add text")}
        </Button>
        {actions && (
          <Button variant="secondary" loading={reading} disabled={reading || !product.images.length} tooltip={product.images.length ? undefined : t("Add a photo first")} onClick={() => void read()} data-read-labels="">
            {t("Read label from photos")}
          </Button>
        )}
      </div>
      <Checkbox label={t("These texts are checked")} checked={product.labelsConfirmed} disabled={!product.labels.length} onChange={(c) => void saveLabels(product.labels, c)} data-labels-confirmed="" />
      {problem && (
        <div className={styles.problem} role="alert">
          {problem}
        </div>
      )}
    </section>
  );
}
