/**
 * Brands, full size (docs/studio.md §3.2): the library's brands as cards (I), a brand's page with its products by
 * series, its identity and formats (J), a product's page with its pictures, readiness and label texts (K). The same
 * view opens over the editor (the navigation bar's Brands tab, BrandsWindow) and in Home (its sidebar's Brands);
 * `actions` (the agent, the text model) are the editor's — without them those buttons aren't there.
 */
import { useState, type KeyboardEvent } from "react";
import { Button, EmptyState, Icon, MenuButton, SearchField, Swatch, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Brand } from "../../../../../shared/studio/types";
import { BrandForm, ProductForm, brandsRepo, useBrands } from "../forms";
import { createBrandsLibrary, storeBrandsLibraryDeps } from "../../social/templates/brandLibrary";
import { NO_FILTER, brandGaps, brandStats, filterBrands, type ProductFilter } from "./model";
import { BrandLogo, ConfirmDelete, Meter, TopBar, messageOf, type BrandsActions } from "./parts";
import { BrandPage, type BrandTab } from "./BrandPage";
import { ProductPage } from "./ProductPage";
import styles from "./BrandsView.module.css";

export type BrandsPlace =
  | { page: "list" }
  | { page: "brand"; brandId: string }
  | { page: "product"; brandId: string; productId: string }
  | { page: "brand-form"; brandId?: string }
  | { page: "product-form"; brandId: string; productId?: string; series?: string | null };

export interface BrandsViewProps {
  actions?: BrandsActions | null;
  /** Over the editor: its Close (Esc closes it too) */
  onClose?: () => void;
  initial?: BrandsPlace;
}

export function BrandsView({ actions = null, onClose, initial = { page: "list" } }: BrandsViewProps) {
  useT();
  const { brands, error } = useBrands();
  const [place, setPlace] = useState<BrandsPlace>(initial);
  // Each brand's page keeps its tab, filters and order while the view is open (a product's arrows follow them)
  const [filters, setFilters] = useState<Record<string, ProductFilter>>({});
  const [tabs, setTabs] = useState<Record<string, BrandTab>>({});
  const [query, setQuery] = useState("");
  const brand = "brandId" in place && place.brandId ? (brands?.find((b) => b.id === place.brandId) ?? null) : null;
  const product = place.page === "product" ? (brand?.products.find((p) => p.id === place.productId) ?? null) : null;
  const toList = () => setPlace({ page: "list" });
  const toBrand = (brandId: string) => setPlace({ page: "brand", brandId });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // A field's Esc is its own; a dialog or menu over the view closes itself
    if ((e.target as Element).closest("input, textarea, select, [contenteditable='true'], #ds-overlays, [role='menu']")) return;
    e.preventDefault();
    // Esc goes up a page; on the list, it closes the view (over the editor)
    if (place.page === "product" || place.page === "brand-form" || place.page === "product-form") back();
    else if (place.page === "brand") toList();
    else onClose?.();
  };
  const back = () => {
    if (place.page === "product") toBrand(place.brandId);
    else if (place.page === "brand-form" && place.brandId) toBrand(place.brandId);
    else if (place.page === "product-form" && place.productId) setPlace({ page: "product", brandId: place.brandId, productId: place.productId });
    else if (place.page === "product-form") toBrand(place.brandId);
    else toList();
  };

  let body: React.ReactNode;
  if (place.page === "list") {
    body = <BrandList brands={brands} error={error} query={query} onQuery={setQuery} onOpen={toBrand} onNew={() => setPlace({ page: "brand-form" })} onEdit={(id) => setPlace({ page: "brand-form", brandId: id })} onClose={onClose} />;
  } else if (place.page === "brand-form") {
    body = (
      <>
        <TopBar onBack={back} onClose={onClose}>
          <span className={styles.topName}>{place.brandId ? t("Edit brand") : t("New brand")}</span>
        </TopBar>
        <div className={styles.scroll}>
          <div className={styles.formPage}>
            <BrandForm brandId={place.brandId} onDone={toBrand} onCancel={back} />
          </div>
        </div>
      </>
    );
  } else if (place.page === "product-form") {
    const { brandId, productId, series } = place;
    body = (
      <>
        <TopBar onBack={back} onClose={onClose}>
          <span className={styles.topName}>{productId ? t("Edit product") : t("New product")}</span>
        </TopBar>
        <div className={styles.scroll}>
          <div className={styles.formPage}>
            <ProductForm brandId={brandId} productId={productId} prefill={!productId && series ? { series } : undefined} onDone={(id) => setPlace({ page: "product", brandId, productId: id })} onCancel={back} />
          </div>
        </div>
      </>
    );
  } else if (place.page === "product") {
    body =
      brand && product ? (
        <ProductPage
          brand={brand}
          product={product}
          filter={filters[brand.id] ?? NO_FILTER}
          actions={actions}
          onClose={onClose}
          onBack={back}
          onList={toList}
          onBrand={(series) => {
            if (series !== undefined) setFilters((f) => ({ ...f, [brand.id]: { ...(f[brand.id] ?? NO_FILTER), series } }));
            setTabs((x) => ({ ...x, [brand.id]: "products" }));
            toBrand(brand.id);
          }}
          onProduct={(id) => setPlace({ page: "product", brandId: brand.id, productId: id })}
          onEdit={() => setPlace({ page: "product-form", brandId: brand.id, productId: product.id })}
        />
      ) : (
        <Gone what="product" loading={!brands} onBack={back} onClose={onClose} />
      );
  } else {
    body = brand ? (
      <BrandPage
        brand={brand}
        tab={tabs[brand.id] ?? "products"}
        onTab={(tab) => setTabs((x) => ({ ...x, [brand.id]: tab }))}
        filter={filters[brand.id] ?? NO_FILTER}
        onFilter={(f) => setFilters((x) => ({ ...x, [brand.id]: f }))}
        actions={actions}
        onClose={onClose}
        onBack={toList}
        onEdit={() => setPlace({ page: "brand-form", brandId: brand.id })}
        onProduct={(id) => setPlace({ page: "product", brandId: brand.id, productId: id })}
        onNewProduct={(series) => setPlace({ page: "product-form", brandId: brand.id, series })}
        onGone={toList}
      />
    ) : (
      <Gone what="brand" loading={!brands} onBack={toList} onClose={onClose} />
    );
  }
  return (
    <div className={styles.root} data-brands-view={place.page} onKeyDown={onKeyDown}>
      {body}
    </div>
  );
}

function Gone({ what, loading, onBack, onClose }: { what: "brand" | "product"; loading: boolean; onBack: () => void; onClose?: () => void }) {
  useT();
  return (
    <>
      <TopBar onBack={onBack} onClose={onClose}>
        <span className={styles.topName}>{t("Brands")}</span>
      </TopBar>
      {!loading && <EmptyState size="page" icon="24.library" title={what === "brand" ? t("This brand isn't in the library any more") : t("This product isn't in the library any more")} action={{ label: t("Back"), onClick: onBack }} />}
    </>
  );
}

// ── I · The list ──────────────────────────────────────────────────────────────────────────────────────────────────

interface BrandListProps {
  brands: Brand[] | null;
  error: string | null;
  query: string;
  onQuery(q: string): void;
  onOpen(id: string): void;
  onNew(): void;
  onEdit(id: string): void;
  onClose?: () => void;
}

function BrandList({ brands, error, query, onQuery, onOpen, onNew, onEdit, onClose }: BrandListProps) {
  useT();
  const [deleting, setDeleting] = useState<Brand | null>(null);
  const shown = brands ? filterBrands(brands, query) : [];
  return (
    <>
      <TopBar
        onClose={onClose}
        actions={
          <>
            {!!brands?.length && <SearchField value={query} onChange={onQuery} placeholder={t("Search brands and products")} label={t("Search brands and products")} className={styles.search} onExit={(r) => r === "escape" && onQuery("")} />}
            {!!brands?.length && <BrandsLibraryButton brands={brands} />}
            <Button variant="primary" icon="24.plus.small" onClick={onNew} data-brands-new="">
              {t("New brand")}
            </Button>
          </>
        }
      >
        <h1 className={styles.pageTitle}>{t("Brands")}</h1>
      </TopBar>
      <div className={styles.scroll}>
        {error ? (
          <div className={styles.content}>
            <div className={styles.problem} role="alert">
              {error}
            </div>
          </div>
        ) : !brands ? null : !brands.length ? (
          <EmptyState size="page" icon="24.library" title={t("No brands yet")} body={t("Add a brand with its logo, colours and products, or ask the manager in the Agents tab to create one.")} action={{ label: t("New brand"), onClick: onNew }} />
        ) : (
          <div className={styles.content}>
            <div className={styles.cards} role="list" aria-label={t("Brands")}>
              {shown.map((b) => (
                <BrandCard key={b.id} brand={b} onOpen={() => onOpen(b.id)} onEdit={() => onEdit(b.id)} onDelete={() => setDeleting(b)} />
              ))}
              {!query && (
                <button type="button" role="listitem" className={styles.newCard} onClick={onNew} data-brands-new-card="">
                  <Icon name="24.plus" />
                  {t("New brand")}
                </button>
              )}
            </div>
            {!shown.length && <p className={styles.muted}>{t("No brand or product matches.")}</p>}
          </div>
        )}
      </div>
      {deleting && (
        <ConfirmDelete
          open
          title={t("Delete brand")}
          body={tp(deleting.products.length, "{name}, its {n} product and all their pictures leave the library. This can't be undone.", "{name}, its {n} products and all their pictures leave the library. This can't be undone.", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await brandsRepo().removeBrand(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

function BrandCard({ brand, onOpen, onEdit, onDelete }: { brand: Brand; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  useT();
  const s = brandStats(brand);
  const gaps = brandGaps(brand);
  const meta = [tp(s.products, "{n} product", "{n} products"), s.series ? tp(s.series, "{n} series", "{n} series") : null, s.logos ? tp(s.logos, "{n} logo", "{n} logos") : null, brand.fonts[0] ?? null].filter(Boolean).join(" · ");
  return (
    <div className={styles.card} role="listitem" data-brand={brand.id}>
      <button type="button" className={styles.cardCover} onClick={onOpen} aria-label={t("Open {name}", { name: brand.name })}>
        <BrandLogo brand={brand} className={styles.coverLogo} />
      </button>
      <div className={styles.cardBody}>
        <div className={styles.cardNameRow}>
          <button type="button" className={styles.cardName} onClick={onOpen}>
            {brand.name}
          </button>
          <MenuButton
            label={t("{name} options", { name: brand.name })}
            entries={[
              { id: "edit", label: t("Edit") },
              { id: "delete", label: t("Delete") },
            ]}
            onSelect={(id) => (id === "edit" ? onEdit() : onDelete())}
            className={styles.cardMenu}
            align="end"
          >
            <Icon name="24.more" />
          </MenuButton>
        </div>
        <p className={styles.meta} data-brand-meta="">
          {meta}
        </p>
        {brand.colors.length > 0 && (
          <div className={styles.swatches} aria-label={t("Colours")}>
            {brand.colors.slice(0, 8).map((c) => (
              <span key={c.hex + c.name} title={c.name ? `${c.name} ${c.hex}` : c.hex}>
                <Swatch color={c.hex} size={16} shape="round" />
              </span>
            ))}
          </div>
        )}
        {s.products > 0 && (
          <div className={styles.meters}>
            <Meter label={t("Product photos")} n={s.withPhoto} of={s.products} />
            <Meter label={t("Label texts confirmed")} n={s.labelsConfirmed} of={s.products} />
          </div>
        )}
        {gaps.length > 0 && (
          <div className={styles.hint} data-brand-gaps="">
            <Icon name="16.warning" />
            <span>{gaps.map((g) => t(g)).join(" · ")}</span>
          </div>
        )}
      </div>
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
    <Button
      variant="secondary"
      icon="24.library"
      disabled={busy}
      onClick={() => void run()}
      tooltip={exists ? t("The brands library holds every brand's colours, fonts, text styles and logo for templates.") : t("Make one library with every brand's colours, fonts, text styles and logo, for Social's templates.")}
      data-brands-library={exists ? "update" : "create"}
    >
      {exists ? t("Update brands library") : t("Create brands library")}
    </Button>
  );
}
