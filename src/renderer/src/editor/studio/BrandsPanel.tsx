/**
 * Brands (the navigation bar's Brands tab, docs/studio.md §3.2): the brands of the library; a brand's page shows its
 * logos, colours, fonts, tone, formats and products; a product's page its pictures by role, its shape and the label
 * texts table (Sharp / Soft), with "Read label from photos". Add and edit use the forms the chat's form cards use.
 * Under the list: Create / Update brands library (Social's Brands library, docs/social.md §4.1).
 */
import { useState } from "react";
import { Button, Checkbox, Dialog, EmptyState, IconButton, SearchField, Select, Swatch, TextInput, showToast } from "@/ds";
import { foldName, nameScore } from "../../../../shared/studio/library";
import type { Brand, LabelTier, Product } from "../../../../shared/studio/types";
import { t, tp, useT } from "@/i18n";
import { useEditor } from "../controller";
import { TabHeader } from "../panels/TabHeader";
import { BrandForm, ProductForm, StoredPicture, brandsRepo, useBrands, useImageUrl } from "./forms";
import { runLibraryTool } from "./libraryTools";
import { createBrandsLibrary, storeBrandsLibraryDeps } from "../social/templates/brandLibrary";
import styles from "./BrandsPanel.module.css";

type View =
  | { page: "list" }
  | { page: "brand"; brandId: string }
  | { page: "product"; brandId: string; productId: string }
  | { page: "brand-form"; brandId?: string }
  | { page: "product-form"; brandId: string; productId?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function BrandsPanel() {
  useT();
  const { brands, error } = useBrands();
  const [view, setView] = useState<View>({ page: "list" });
  const brand = "brandId" in view && view.brandId ? (brands?.find((b) => b.id === view.brandId) ?? null) : null;
  const product = view.page === "product" ? (brand?.products.find((p) => p.id === view.productId) ?? null) : null;
  const toBrand = (brandId: string): View => ({ page: "brand", brandId });
  return (
    <div className={styles.panel} data-brands="">
      {view.page === "list" && <TabHeader title={t("Brands")} actions={<button type="button" className={styles.create} onClick={() => setView({ page: "brand-form" })}>{t("New brand")}</button>} />}
      {view.page === "list" ? (
        <>
          <BrandList brands={brands} error={error} onOpen={(id) => setView(toBrand(id))} onNew={() => setView({ page: "brand-form" })} />
          {!!brands?.length && <BrandsLibraryButton brands={brands} />}
        </>
      ) : view.page === "brand-form" ? (
        <>
          <Bar title={view.brandId ? t("Edit brand") : t("New brand")} onBack={() => setView(view.brandId ? toBrand(view.brandId) : { page: "list" })} />
          <div className={styles.scroll}>
            <BrandForm brandId={view.brandId} onDone={(id) => setView(toBrand(id))} onCancel={() => setView(view.brandId ? toBrand(view.brandId) : { page: "list" })} />
          </div>
        </>
      ) : view.page === "product-form" ? (
        <>
          <Bar title={view.productId ? t("Edit product") : t("New product")} onBack={() => setView(view.productId ? { page: "product", brandId: view.brandId, productId: view.productId } : toBrand(view.brandId))} />
          <div className={styles.scroll}>
            <ProductForm
              brandId={view.brandId}
              productId={view.productId}
              onDone={(id) => setView({ page: "product", brandId: view.brandId, productId: id })}
              onCancel={() => setView(view.productId ? { page: "product", brandId: view.brandId, productId: view.productId } : toBrand(view.brandId))}
            />
          </div>
        </>
      ) : view.page === "product" ? (
        product && brand ? (
          <ProductPage brand={brand} product={product} onBack={() => setView(toBrand(brand.id))} onEdit={() => setView({ page: "product-form", brandId: brand.id, productId: product.id })} onGone={() => setView(toBrand(brand.id))} />
        ) : (
          <Gone what="product" loading={!brands} onBack={() => setView(view.brandId ? toBrand(view.brandId) : { page: "list" })} />
        )
      ) : brand ? (
        <BrandPage brand={brand} onBack={() => setView({ page: "list" })} onEdit={() => setView({ page: "brand-form", brandId: brand.id })} onProduct={(id) => setView({ page: "product", brandId: brand.id, productId: id })} onNewProduct={() => setView({ page: "product-form", brandId: brand.id })} onGone={() => setView({ page: "list" })} />
      ) : (
        <Gone what="brand" loading={!brands} onBack={() => setView({ page: "list" })} />
      )}
    </div>
  );
}

/**
 * Create brands library / Update brands library (docs/social.md §4.1, round 18b): the file "Brands" made and every
 * brand pointed at it, or the existing one opened — its banner runs the update; publishing stays the owner's click.
 */
function BrandsLibraryButton({ brands }: { brands: Brand[] }) {
  useT();
  const [busy, setBusy] = useState(false);
  const exists = brands.some((b) => b.libraryFileKey);
  const run = async () => {
    setBusy(true);
    try {
      await createBrandsLibrary(brands, storeBrandsLibraryDeps());
    } catch (e) {
      showToast({ message: messageOf(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.section} data-brands-library="">
      <p className={styles.muted}>{exists ? t("The brands library holds every brand's colours, fonts, text styles and logo for templates.") : t("Make one library with every brand's colours, fonts, text styles and logo, for Social's templates.")}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {exists ? t("Update brands library") : t("Create brands library")}
      </Button>
    </div>
  );
}

function Bar({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  useT();
  return (
    <div className={styles.bar} data-brands-bar="">
      <IconButton icon="24.arrow.left" label={t("Back")} tone="secondary" onClick={onBack} />
      <span className={styles.barTitle}>{title}</span>
      {children}
    </div>
  );
}

function Gone({ what, loading, onBack }: { what: "brand" | "product"; loading: boolean; onBack: () => void }) {
  useT();
  return loading ? null : <EmptyState icon="24.library" title={what === "brand" ? t("This brand isn't in the library any more") : t("This product isn't in the library any more")} action={{ label: t("Back"), onClick: onBack }} />;
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────

function BrandList({ brands, error, onOpen, onNew }: { brands: Brand[] | null; error: string | null; onOpen: (id: string) => void; onNew: () => void }) {
  useT();
  const [query, setQuery] = useState("");
  if (error) return <div className={styles.section}><div className={styles.problem} role="alert">{error}</div></div>;
  if (!brands) return null;
  if (!brands.length) return <EmptyState icon="24.library" title={t("No brands yet")} body={t("Add a brand with its logo, colours and products, or ask the manager in the Agents tab to create one.")} action={{ label: t("New brand"), onClick: onNew }} />;
  const shown = foldName(query) ? brands.map((b) => ({ b, s: Math.max(nameScore(b.name, query), ...b.products.map((p) => nameScore(p.name, query))) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.b) : brands;
  return (
    <>
      <SearchField value={query} onChange={setQuery} placeholder={t("Search brands and products")} label={t("Search brands and products")} className={styles.search} />
      <div className={styles.scroll} role="list" aria-label={t("Brands")}>
        {shown.map((b) => (
          <button key={b.id} type="button" role="listitem" className={styles.row} data-brand={b.id} onClick={() => onOpen(b.id)}>
            <BrandThumb brand={b} />
            <span className={styles.rowName}>{b.name}</span>
            <span className={styles.rowHint}>{tp(b.products.length, "{n} product", "{n} products")}</span>
          </button>
        ))}
        {!shown.length && <p className={styles.muted} style={{ padding: "var(--ds-space-3) var(--ds-space-4)" }}>{t("No brand or product matches.")}</p>}
      </div>
    </>
  );
}

function BrandThumb({ brand }: { brand: Brand }) {
  const logo = brand.logos.find((i) => i.role === "logo");
  return logo ? <ThumbImage brandId={brand.id} imageId={logo.id} /> : <span className={styles.thumbSmall} />;
}

function ThumbImage({ brandId, imageId }: { brandId: string; imageId: string }) {
  const url = useImageUrl(brandId, imageId);
  return url ? <img className={styles.thumbSmall} src={url} alt="" /> : <span className={styles.thumbSmall} />;
}

// ── A brand ───────────────────────────────────────────────────────────────────────────────────────────────────────

function BrandPage({ brand, onBack, onEdit, onProduct, onNewProduct, onGone }: { brand: Brand; onBack: () => void; onEdit: () => void; onProduct: (id: string) => void; onNewProduct: () => void; onGone: () => void }) {
  useT();
  const [confirm, setConfirm] = useState(false);
  const logos = brand.logos.filter((i) => i.role === "logo");
  const styles_ = brand.logos.filter((i) => i.role === "style");
  return (
    <>
      <Bar title={brand.name} onBack={onBack}>
        <IconButton icon="24.pencil" label={t("Edit brand")} onClick={onEdit} />
        <IconButton icon="24.trash" label={t("Delete brand")} onClick={() => setConfirm(true)} />
      </Bar>
      <div className={styles.scroll} data-brand-page={brand.id}>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Logos")}</h3>
          {logos.length ? <div className={styles.pictures}>{logos.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} />)}</div> : <p className={styles.muted}>{t("No logo yet.")}</p>}
        </div>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Colours")}</h3>
          {brand.colors.length ? (
            <div className={styles.chips}>
              {brand.colors.map((c) => (
                <span key={c.hex + c.name} className={styles.chip}>
                  <Swatch color={c.hex} size={16} shape="round" />
                  {c.name ? `${c.name} ${c.hex}` : c.hex}
                </span>
              ))}
            </div>
          ) : (
            <p className={styles.muted}>{t("No colours yet.")}</p>
          )}
        </div>
        {(brand.fonts.length > 0 || brand.tone) && (
          <div className={styles.section}>
            {brand.fonts.length > 0 && (
              <>
                <h3 className={styles.sectionTitle}>{t("Fonts")}</h3>
                <p className={styles.text}>{brand.fonts.join(", ")}</p>
              </>
            )}
            {brand.tone && (
              <>
                <h3 className={styles.sectionTitle}>{t("Tone and look")}</h3>
                <p className={styles.text}>{brand.tone}</p>
              </>
            )}
          </div>
        )}
        {styles_.length > 0 && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>{t("Style pictures")}</h3>
            <div className={styles.pictures}>{styles_.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} />)}</div>
          </div>
        )}
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Formats")}</h3>
          {brand.formats.map((f) => (
            <div key={f.id} className={styles.formatRow}>
              <span>{f.name}</span>
              <span className={styles.formatSize}>{f.width} × {f.height}</span>
            </div>
          ))}
        </div>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Products")}</h3>
        </div>
        {brand.products.map((p) => (
          <button key={p.id} type="button" className={styles.row} data-product={p.id} onClick={() => onProduct(p.id)}>
            {p.images.find((i) => i.role === "packshot") ? <ThumbImage brandId={brand.id} imageId={p.images.find((i) => i.role === "packshot")!.id} /> : <span className={styles.thumbSmall} />}
            <span className={styles.rowName}>{p.name}</span>
            {!p.labelsConfirmed && <span className={styles.rowHint}>{t("Labels unchecked")}</span>}
          </button>
        ))}
        <div className={styles.section}>
          <div className={styles.actions}>
            <Button variant="secondary" icon="24.plus.small" onClick={onNewProduct}>{t("Add product")}</Button>
          </div>
        </div>
      </div>
      <ConfirmDelete
        open={confirm}
        title={t("Delete brand")}
        body={tp(brand.products.length, "{name}, its {n} product and all their pictures leave the library. This can't be undone.", "{name}, its {n} products and all their pictures leave the library. This can't be undone.", { name: brand.name })}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await brandsRepo().removeBrand(brand.id);
          onGone();
        }}
      />
    </>
  );
}

function ConfirmDelete({ open, title, body, onClose, onConfirm }: { open: boolean; title: string; body: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  useT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="destructive"
            size="large"
            disabled={busy}
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

// ── A product ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TIERS = [
  { value: "sharp", label: "Sharp" },
  { value: "soft", label: "Soft" },
];

function ProductPage({ brand, product, onBack, onEdit, onGone }: { brand: Brand; product: Product; onBack: () => void; onEdit: () => void; onGone: () => void }) {
  useT();
  const ed = useEditor();
  const [confirm, setConfirm] = useState(false);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const photos = product.images.filter((i) => i.role === "packshot");
  const closeUps = product.images.filter((i) => i.role === "label");
  const repo = brandsRepo();
  const guard = (p: Promise<unknown>) => p.catch((e: unknown) => setProblem(messageOf(e)));
  const saveLabels = (labels: { id?: string; text: string; tier: LabelTier }[], labelsConfirmed?: boolean) =>
    guard(repo.saveProduct({ id: product.id, brandId: brand.id, name: product.name, labels, ...(labelsConfirmed !== undefined ? { labelsConfirmed } : {}) }));
  const setLabel = (id: string, patch: Partial<{ text: string; tier: LabelTier }>) => saveLabels(product.labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const read = async () => {
    setReading(true);
    setProblem(null);
    const r = await runLibraryTool(ed, "library_read_labels", { brandId: brand.id, productId: product.id });
    setReading(false);
    if (r.isError) setProblem(r.content[0]?.type === "text" ? r.content[0].text : t("The label couldn't be read"));
  };
  return (
    <>
      <Bar title={product.name} onBack={onBack}>
        <IconButton icon="24.pencil" label={t("Edit product")} onClick={onEdit} />
        <IconButton icon="24.trash" label={t("Delete product")} onClick={() => setConfirm(true)} />
      </Bar>
      <div className={styles.scroll} data-product-page={product.id}>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Product photos")}</h3>
          {photos.length ? <div className={styles.pictures}>{photos.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} onRemove={() => void guard(repo.removeImage(brand.id, i.id))} />)}</div> : <p className={styles.muted}>{t("No product photo yet.")}</p>}
          <h3 className={styles.sectionTitle}>{t("Label close-ups")}</h3>
          {closeUps.length ? <div className={styles.pictures}>{closeUps.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} onRemove={() => void guard(repo.removeImage(brand.id, i.id))} />)}</div> : <p className={styles.muted}>{t("No label close-up yet.")}</p>}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={onEdit}>{t("Add pictures")}</Button>
          </div>
        </div>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("Shape")}</h3>
          {product.shape ? <p className={styles.text}>{product.shape}</p> : <p className={styles.muted}>{t("No shape described yet.")}</p>}
        </div>
        <div className={styles.section} data-labels="">
          <h3 className={styles.sectionTitle}>{t("Label texts")}</h3>
          <div className={styles.list}>
            {product.labels.map((l) => (
              <div key={l.id} className={styles.listRow}>
                <TextInput label={t("Label text")} value={l.text} onCommit={(v) => void setLabel(l.id, { text: v })} />
                <Select label={t("Tier")} className={styles.tier} value={l.tier} options={TIERS.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => void setLabel(l.id, { tier: v as LabelTier })} />
                <IconButton icon="16.close" label={t("Remove text")} onClick={() => void saveLabels(product.labels.filter((x) => x.id !== l.id))} />
              </div>
            ))}
          </div>
          {!product.labels.length && <p className={styles.muted}>{t("No label texts yet.")}</p>}
          <div className={styles.actions}>
            <Button variant="secondary" icon="24.plus.small" onClick={() => void saveLabels([...product.labels, { text: "New text", tier: "sharp" }])}>{t("Add text")}</Button>
            <Button variant="secondary" loading={reading} disabled={reading || !product.images.length} tooltip={product.images.length ? undefined : t("Add a photo first")} onClick={() => void read()} data-read-labels="">
              {t("Read label from photos")}
            </Button>
          </div>
          <Checkbox label={t("These texts are checked")} checked={product.labelsConfirmed} disabled={!product.labels.length} onChange={(c) => void saveLabels(product.labels, c)} />
          {problem && <div className={styles.problem} role="alert">{problem}</div>}
        </div>
        {product.notes && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>{t("Notes")}</h3>
            <p className={styles.text}>{product.notes}</p>
          </div>
        )}
      </div>
      <ConfirmDelete
        open={confirm}
        title={t("Delete product")}
        body={t("{name} and its pictures leave the library. This can't be undone.", { name: product.name })}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await repo.removeProduct(brand.id, product.id);
          onGone();
        }}
      />
    </>
  );
}
