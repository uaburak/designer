/**
 * J · A brand's page (docs/studio.md §3.2): its logo, name and tone in the header with Edit, Ask agent and Design
 * posts; tabs Products (filtered by series and readiness, searched, sorted; picked for the bulk bar), Identity (logos,
 * colours, fonts, tone, style pictures) and Formats.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { Badge, Button, Checkbox, Icon, MenuButton, SearchField, Select, Tabs, cx, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Brand, Product } from "../../../../../shared/studio/types";
import { StoredPicture, brandsRepo } from "../forms";
import { filterProducts, productGap, seriesCounts, toneSummary, type ProductFilter, type SeriesFilter } from "./model";
import { BrandLogo, ConfirmDelete, LibraryImage, TopBar, type BrandsActions } from "./parts";
import styles from "./BrandsView.module.css";

export type BrandTab = "products" | "identity" | "formats";

export interface BrandPageProps {
  brand: Brand;
  tab: BrandTab;
  onTab(tab: BrandTab): void;
  filter: ProductFilter;
  onFilter(f: ProductFilter): void;
  actions: BrandsActions | null;
  onClose?: () => void;
  onBack(): void;
  onEdit(): void;
  onProduct(id: string): void;
  /** A new product, in the series shown (when one is) */
  onNewProduct(series: string | null): void;
  onGone(): void;
}

export function BrandPage({ brand, tab, onTab, filter, onFilter, actions, onClose, onBack, onEdit, onProduct, onNewProduct, onGone }: BrandPageProps) {
  useT();
  const [confirm, setConfirm] = useState(false);
  const tone = toneSummary(brand.tone);
  return (
    <>
      <TopBar onBack={onBack} onClose={onClose}>
        <span className={styles.crumbs}>
          <button type="button" className={styles.crumb} onClick={onBack}>
            {t("Brands")}
          </button>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.topName}>{brand.name}</span>
        </span>
      </TopBar>
      <div className={styles.scroll} data-brand-page={brand.id}>
        <div className={styles.hero}>
          <BrandLogo brand={brand} className={styles.heroLogo} />
          <div className={styles.heroText}>
            <h1 className={styles.heroName}>{brand.name}</h1>
            {tone ? <p className={styles.heroTone}>{tone}</p> : <p className={styles.heroTone}>{t("No tone described yet.")}</p>}
          </div>
          <div className={styles.heroActions}>
            <Button variant="secondary" icon="24.pencil" onClick={onEdit} data-brand-edit="">
              {t("Edit")}
            </Button>
            {actions && (
              <Button variant="secondary" icon="24.rail.agents" onClick={() => actions.askAgent(t("About {name}: ", { name: brand.name }))} data-brand-ask="">
                {t("Ask agent")}
              </Button>
            )}
            {actions && (
              <Button variant="primary" icon="24.social" onClick={() => actions.designPosts(brand, [])} data-brand-design="">
                {t("Design posts")}
              </Button>
            )}
            <MenuButton label={t("{name} options", { name: brand.name })} entries={[{ id: "delete", label: t("Delete brand") }]} onSelect={() => setConfirm(true)} className={styles.iconMenu} align="end">
              <Icon name="24.more" />
            </MenuButton>
          </div>
        </div>
        <Tabs
          label={t("Brand")}
          className={styles.tabs}
          value={tab}
          onChange={(v) => onTab(v as BrandTab)}
          tabs={[
            { value: "products", label: t("Products"), badge: brand.products.length },
            { value: "identity", label: t("Identity") },
            { value: "formats", label: t("Formats") },
          ]}
          data-brand-tabs=""
        />
        {tab === "products" ? <ProductsTab brand={brand} filter={filter} onFilter={onFilter} actions={actions} onProduct={onProduct} onNewProduct={onNewProduct} /> : tab === "identity" ? <IdentityTab brand={brand} /> : <FormatsTab brand={brand} />}
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

// ── Products ──────────────────────────────────────────────────────────────────────────────────────────────────────

const sameSeries = (a: SeriesFilter, b: SeriesFilter) => (typeof a === "object" && typeof b === "object" ? a.key === b.key : a === b);

function ProductsTab({ brand, filter, onFilter, actions, onProduct, onNewProduct }: { brand: Brand; filter: ProductFilter; onFilter(f: ProductFilter): void; actions: BrandsActions | null; onProduct(id: string): void; onNewProduct(series: string | null): void }) {
  useT();
  const counts = useMemo(() => seriesCounts(brand.products), [brand.products]);
  const shown = useMemo(() => filterProducts(brand.products, filter), [brand.products, filter]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reading, setReading] = useState(false);
  // Products gone from the brand leave the selection
  const chosen = brand.products.filter((p) => picked.has(p.id));
  const set = (patch: Partial<ProductFilter>) => onFilter({ ...filter, ...patch });
  const toggle = (id: string, on: boolean) => setPicked((s) => (on ? new Set(s).add(id) : new Set([...s].filter((x) => x !== id))));
  const seriesName = typeof filter.series === "object" ? (counts.series.find((s) => s.key === (filter.series as { key: string }).key)?.name ?? null) : null;
  const readAll = async () => {
    if (!actions) return;
    const withPictures = chosen.filter((p) => p.images.length);
    if (!withPictures.length) return void showToast({ message: t("Add a photo first") });
    setReading(true);
    const problems: string[] = [];
    for (const p of withPictures) {
      const problem = await actions.readLabels(brand.id, p.id);
      if (problem) problems.push(`${p.name}: ${problem}`);
    }
    setReading(false);
    showToast(problems.length ? { message: problems[0], kind: "error" } : { message: tp(withPictures.length, "Read the label of {n} product: check the texts", "Read the labels of {n} products: check the texts") });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && picked.size && !(e.target as Element).closest("input, textarea, #ds-overlays")) {
      e.preventDefault();
      setPicked(new Set());
    }
  };
  const seriesRow = (value: SeriesFilter, name: string, count: number) => (
    <button key={typeof value === "object" ? value.key : value} type="button" className={styles.filterRow} aria-pressed={sameSeries(filter.series, value)} onClick={() => set({ series: value })} data-series-filter={typeof value === "object" ? value.key : value}>
      <span className={styles.filterName}>{name}</span>
      <span className={styles.filterCount}>{count}</span>
    </button>
  );
  return (
    <div className={styles.productsTab} onKeyDown={onKeyDown}>
      <aside className={styles.filters} aria-label={t("Filters")}>
        <h3 className={styles.filterTitle}>{t("Series")}</h3>
        <div className={styles.filterGroup}>
          {seriesRow("all", t("All"), brand.products.length)}
          {counts.series.map((s) => seriesRow({ key: s.key }, s.name, s.count))}
          {counts.none > 0 && counts.series.length > 0 && seriesRow("none", t("No series"), counts.none)}
        </div>
        <h3 className={styles.filterTitle}>{t("Readiness")}</h3>
        <div className={styles.filterChecks}>
          <Checkbox label={t("Labels not confirmed")} checked={filter.labelsUnconfirmed} onChange={(c) => set({ labelsUnconfirmed: c })} data-filter="labels" />
          <Checkbox label={t("No product photo")} checked={filter.noPhoto} onChange={(c) => set({ noPhoto: c })} data-filter="photo" />
        </div>
      </aside>
      <section className={styles.productsMain} aria-label={t("Products")}>
        <div className={styles.toolbar}>
          <SearchField value={filter.query} onChange={(q) => set({ query: q })} placeholder={t("Search in {name}", { name: brand.name })} label={t("Search products")} className={styles.search} onExit={(r) => r === "escape" && set({ query: "" })} />
          <Select
            label={t("Sort")}
            className={styles.sort}
            value={filter.sort}
            options={[
              { value: "name", label: t("Sort by name") },
              { value: "series", label: t("Sort by series") },
            ]}
            onChange={(v) => set({ sort: v as ProductFilter["sort"] })}
          />
          <span className={styles.toolbarCount}>{tp(shown.length, "{n} product", "{n} products")}</span>
          <Button variant="secondary" icon="24.plus.small" onClick={() => onNewProduct(seriesName)} data-product-new="">
            {t("Add product")}
          </Button>
        </div>
        {shown.length ? (
          <div className={styles.productGrid} role="list" aria-label={t("Products")}>
            {shown.map((p) => (
              <ProductCard key={p.id} brand={brand} product={p} picking={!!actions} picked={picked.has(p.id)} anyPicked={picked.size > 0} onPick={(on) => toggle(p.id, on)} onOpen={() => onProduct(p.id)} />
            ))}
          </div>
        ) : (
          <p className={styles.muted}>{brand.products.length ? t("No product matches these filters.") : t("No products yet.")}</p>
        )}
        {actions && chosen.length > 0 && (
          <div className={styles.bulkBar} role="toolbar" aria-label={t("Selected products")} data-bulk-bar="">
            <span className={styles.bulkCount}>{tp(chosen.length, "{n} product selected", "{n} products selected")}</span>
            <span className={styles.bulkSep} />
            <button type="button" className={styles.bulkButton} onClick={() => actions.designPosts(brand, chosen)} data-bulk-design="">
              {t("Ask the agent to design…")}
            </button>
            <button type="button" className={styles.bulkButton} disabled={reading} onClick={() => void readAll()} data-bulk-read="">
              {reading ? t("Reading labels…") : t("Read labels")}
            </button>
            <button type="button" className={cx(styles.bulkButton, styles.bulkClose)} aria-label={t("Clear selection")} onClick={() => setPicked(new Set())} data-bulk-clear="">
              <Icon name="24.close" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProductCard({ brand, product, picking, picked, anyPicked, onPick, onOpen }: { brand: Brand; product: Product; picking: boolean; picked: boolean; anyPicked: boolean; onPick(on: boolean): void; onOpen(): void }) {
  useT();
  const photo = product.images.find((i) => i.role === "packshot") ?? product.images[0];
  const gap = productGap(product);
  return (
    <div className={styles.productCard} role="listitem" data-product={product.id} data-picked={picked || undefined} data-picking={anyPicked || undefined}>
      <button type="button" className={styles.productPhoto} onClick={onOpen} aria-label={t("Open {name}", { name: product.name })}>
        {photo ? <LibraryImage brandId={brand.id} imageId={photo.id} /> : <Icon name="24.image" />}
      </button>
      {picking && <Checkbox label={t("Select {name}", { name: product.name })} hideLabel checked={picked} onChange={onPick} className={styles.productCheck} data-product-pick="" />}
      <div className={styles.productBody}>
        <button type="button" className={styles.productName} onClick={onOpen}>
          {product.name}
        </button>
        <div className={styles.productTags}>
          {product.series && <span className={styles.seriesChip}>{product.series}</span>}
          {gap ? (
            <Badge className={styles.gapBadge} data-gap="">
              {gap.more ? `${t(gap.label)} +${gap.more}` : t(gap.label)}
            </Badge>
          ) : (
            <Badge tone="success" className={styles.gapBadge} data-gap="ready">
              {t("Ready")}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Identity, formats ─────────────────────────────────────────────────────────────────────────────────────────────

function IdentityTab({ brand }: { brand: Brand }) {
  useT();
  const logos = brand.logos.filter((i) => i.role === "logo");
  const looks = brand.logos.filter((i) => i.role === "style");
  return (
    <div className={styles.tabBody} data-brand-identity="">
      <section className={styles.block}>
        <h3 className={styles.blockTitle}>{t("Logos")}</h3>
        {logos.length ? <div className={styles.pictures}>{logos.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} />)}</div> : <p className={styles.muted}>{t("No logo yet.")}</p>}
      </section>
      <section className={styles.block}>
        <h3 className={styles.blockTitle}>{t("Colours")}</h3>
        {brand.colors.length ? (
          <div className={styles.colorGrid}>
            {brand.colors.map((c) => (
              <div key={c.hex + c.name} className={styles.colorCard}>
                <span className={styles.colorChip} style={{ background: c.hex }} />
                <span className={styles.colorName}>{c.name || c.hex}</span>
                <span className={styles.colorHex}>{c.hex}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.muted}>{t("No colours yet.")}</p>
        )}
      </section>
      <section className={styles.block}>
        <h3 className={styles.blockTitle}>{t("Fonts")}</h3>
        {brand.fonts.length ? (
          <div className={styles.fontList}>
            {brand.fonts.map((f) => (
              <div key={f} className={styles.fontCard}>
                {/* The font's own face when this computer has it */}
                <span className={styles.fontSample} style={{ fontFamily: `"${f}", var(--ds-font-family)` }}>
                  Aa
                </span>
                <span>{f}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.muted}>{t("No font yet")}</p>
        )}
      </section>
      <section className={styles.block}>
        <h3 className={styles.blockTitle}>{t("Tone and look")}</h3>
        {brand.tone ? <p className={styles.text}>{brand.tone}</p> : <p className={styles.muted}>{t("No tone described yet.")}</p>}
      </section>
      {looks.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle}>{t("Style pictures")}</h3>
          <div className={styles.pictures}>{looks.map((i) => <StoredPicture key={i.id} brandId={brand.id} image={i} />)}</div>
        </section>
      )}
    </div>
  );
}

function FormatsTab({ brand }: { brand: Brand }) {
  useT();
  return (
    <div className={styles.tabBody} data-brand-formats="">
      {brand.formats.length ? (
        <div className={styles.formatGrid}>
          {brand.formats.map((f) => (
            <div key={f.id} className={styles.formatCard}>
              <span className={styles.formatFrame}>
                <span className={styles.formatShape} style={{ aspectRatio: `${f.width} / ${f.height}` }} />
              </span>
              <span className={styles.formatName}>{f.name}</span>
              <span className={styles.muted}>
                {f.width} × {f.height}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.muted}>{t("No formats yet.")}</p>
      )}
    </div>
  );
}
