/**
 * The brand and product forms (docs/studio.md §3.2, §4.1): one component each, used by the Brands panel and by the
 * chat's form cards. Pictures are staged in the form (dropped, pasted or picked) and written when it is saved, so
 * Cancel leaves the library as it was.
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button, Checkbox, Icon, IconButton, Select, Swatch, TextInput, cx, normalizeHex } from "@/ds";
import { t, useT } from "@/i18n";
import { getStoreClient } from "@/store";
import { DEFAULT_FORMATS, type Brand, type BrandColor, type BrandImage, type BrandImageRole, type BrandSave, type BrandsRepository, type LabelTier, type Product, type ProductSave, type SocialFormat } from "../../../../shared/studio/types";
import { foldName } from "../../../../shared/studio/library";
import styles from "./BrandsPanel.module.css";

// ── The library, as the views read it ─────────────────────────────────────────────────────────────────────────────

let repoOverride: BrandsRepository | null = null;
/** Tests give their own library. */
export function setBrandsRepository(r: BrandsRepository | null): void {
  repoOverride = r;
}
export const brandsRepo = (): BrandsRepository => repoOverride ?? getStoreClient().brands;

/** The brands, kept current: they are read again when the store says one changed (topic `brands`). */
export function useBrands(): { brands: Brand[] | null; error: string | null } {
  const [state, setState] = useState<{ brands: Brand[] | null; error: string | null }>({ brands: null, error: null });
  useEffect(() => {
    const repo = brandsRepo();
    let alive = true;
    const load = () => repo.list().then((brands) => alive && setState({ brands, error: null }), (e: unknown) => alive && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) })));
    void load();
    const off = repo.watch(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

const urls = new Map<string, Promise<string>>();
/** A library picture as a data URL (kept: pictures don't change under their id). */
export function useImageUrl(brandId: string, imageId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const key = `${brandId}/${imageId}`;
    let p = urls.get(key);
    if (!p) {
      p = brandsRepo().image(brandId, imageId).then((i) => `data:${i.mime};base64,${i.data}`);
      urls.set(key, p);
      p.catch(() => urls.delete(key));
    }
    let alive = true;
    p.then((u) => alive && setUrl(u), () => {});
    return () => {
      alive = false;
    };
  }, [brandId, imageId]);
  return url;
}

export function StoredPicture({ brandId, image, onRemove }: { brandId: string; image: BrandImage; onRemove?: () => void }) {
  useT();
  const url = useImageUrl(brandId, image.id);
  return (
    <div className={styles.picture} data-picture={image.id}>
      {url && <img src={url} alt={image.name} />}
      {onRemove && <IconButton icon="16.close" label={t("Remove {name}", { name: image.name })} className={styles.pictureRemove} onClick={onRemove} />}
    </div>
  );
}

// ── Pictures: drop, paste or a file picker ────────────────────────────────────────────────────────────────────────

export interface StagedPicture {
  key: string;
  role: BrandImageRole;
  name: string;
  /** base64 */
  data: string;
  url: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

let stageKey = 0;
/** Files → staged pictures (PNG, JPEG, WebP; the store checks their bytes again). Returns what was refused too. */
export async function stageFiles(files: Iterable<File>, role: BrandImageRole): Promise<{ staged: StagedPicture[]; refused: string[] }> {
  const staged: StagedPicture[] = [];
  const refused: string[] = [];
  for (const f of files) {
    if (!TYPES.includes(f.type)) {
      refused.push(f.name ? t("{name} isn't a PNG, JPEG or WebP picture", { name: f.name }) : t("That file isn't a PNG, JPEG or WebP picture"));
      continue;
    }
    if (f.size > MAX_BYTES) {
      refused.push(f.name ? t("{name} is over 20 MB", { name: f.name }) : t("That picture is over 20 MB"));
      continue;
    }
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error(t("The file can't be read")));
      r.readAsDataURL(f);
    });
    staged.push({ key: `s${++stageKey}`, role, name: f.name || `${role}.${f.type.slice(6)}`, data: url.slice(url.indexOf(",") + 1), url });
  }
  return { staged, refused };
}

export interface PicturesProps {
  label: string;
  role: BrandImageRole;
  brandId?: string;
  /** Saved pictures of this role */
  stored: readonly BrandImage[];
  removed: ReadonlySet<string>;
  staged: readonly StagedPicture[];
  onStage(p: StagedPicture[]): void;
  onUnstage(key: string): void;
  onRemoveStored(id: string): void;
  onProblem(message: string | null): void;
}

/** One kind of picture: its thumbnails and a place to drop, paste into (click it first) or pick files with. */
export function Pictures(p: PicturesProps) {
  useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = useCallback(
    async (files: Iterable<File>) => {
      const { staged, refused } = await stageFiles(files, p.role);
      p.onProblem(refused[0] ?? null);
      if (staged.length) p.onStage(staged);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.role, p.onStage, p.onProblem]
  );
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
  return (
    <div className={styles.field} data-pictures={p.role}>
      <span className={styles.fieldLabel}>{p.label}</span>
      <div className={styles.pictures}>
        {p.stored.filter((i) => !p.removed.has(i.id)).map((i) => p.brandId && <StoredPicture key={i.id} brandId={p.brandId} image={i} onRemove={() => p.onRemoveStored(i.id)} />)}
        {p.staged.map((s) => (
          <div key={s.key} className={styles.picture} data-picture="staged">
            <img src={s.url} alt={s.name} />
            <IconButton icon="16.close" label={t("Remove {name}", { name: s.name })} className={styles.pictureRemove} onClick={() => p.onUnstage(s.key)} />
          </div>
        ))}
      </div>
      <div
        className={styles.drop}
        role="button"
        tabIndex={0}
        aria-label={t("Add {what}", { what: p.label.toLocaleLowerCase() })}
        data-over={over || undefined}
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
        <Icon name="24.image" />
        {t("Drop, paste or choose pictures")}
      </div>
      <input
        ref={input}
        className={styles.file}
        type="file"
        accept={TYPES.join(",")}
        multiple
        tabIndex={-1}
        aria-hidden
        data-file-input={p.role}
        onChange={(e) => {
          void take([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

/** Staged pictures and removals of one form: written by `apply` after the item itself is saved. */
function usePictureEdits() {
  const [staged, setStaged] = useState<StagedPicture[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  return {
    staged,
    removed,
    stage: (p: StagedPicture[]) => setStaged((s) => [...s, ...p]),
    unstage: (key: string) => setStaged((s) => s.filter((x) => x.key !== key)),
    removeStored: (id: string) => setRemoved((r) => new Set(r).add(id)),
    async apply(repo: BrandsRepository, brandId: string, productId: string | null) {
      for (const id of removed) await repo.removeImage(brandId, id);
      for (const s of staged) await repo.addImage({ brandId, productId, role: s.role, name: s.name, data: s.data });
    },
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Brand ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BrandFormProps {
  brandId?: string;
  prefill?: Partial<BrandSave>;
  onDone(brandId: string): void;
  onCancel(): void;
  /** In the chat's form card (its padding, not the panel's) */
  inCard?: boolean;
}

const newColor = (): BrandColor => ({ name: "", hex: "#" });

export function BrandForm({ brandId, prefill, onDone, onCancel, inCard }: BrandFormProps) {
  useT();
  const [loaded, setLoaded] = useState<Brand | null>(null);
  const [ready, setReady] = useState(!brandId);
  const [name, setName] = useState(prefill?.name ?? "");
  const [colors, setColors] = useState<BrandColor[]>(prefill?.colors ?? []);
  const [fonts, setFonts] = useState((prefill?.fonts ?? []).join(", "));
  const [tone, setTone] = useState(prefill?.tone ?? "");
  const [formats, setFormats] = useState<SocialFormat[]>(prefill?.formats ?? DEFAULT_FORMATS.map((f) => ({ ...f })));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pics = usePictureEdits();
  useEffect(() => {
    if (!brandId) return;
    let alive = true;
    brandsRepo().get(brandId).then(
      (b) => {
        if (!alive) return;
        if (b) {
          setLoaded(b);
          setName(prefill?.name ?? b.name);
          setColors(prefill?.colors ?? b.colors);
          setFonts((prefill?.fonts ?? b.fonts).join(", "));
          setTone(prefill?.tone ?? b.tone);
          setFormats(prefill?.formats ?? b.formats);
        }
        setReady(true);
      },
      (e: unknown) => alive && (setProblem(messageOf(e)), setReady(true))
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const repo = brandsRepo();
      const good = colors.filter((c) => c.hex.trim().length > 1).map((c) => ({ name: c.name.trim(), hex: normalizeHex(c.hex) ?? c.hex.trim() }));
      const saved = await repo.saveBrand({
        ...(brandId ? { id: brandId } : {}),
        name,
        colors: good,
        fonts: fonts.split(",").map((f) => f.trim()).filter(Boolean),
        tone,
        formats: formats.filter((f) => f.width > 0 && f.height > 0),
        ...(prefill?.libraryFileKey !== undefined ? { libraryFileKey: prefill.libraryFileKey } : {}),
      });
      await pics.apply(repo, saved.id, null);
      onDone(saved.id);
    } catch (e) {
      setProblem(messageOf(e));
      setBusy(false);
    }
  };

  if (!ready) return null;
  const setColor = (i: number, c: Partial<BrandColor>) => setColors((cs) => cs.map((x, k) => (k === i ? { ...x, ...c } : x)));
  const setFormat = (i: number, f: Partial<SocialFormat>) => setFormats((fs) => fs.map((x, k) => (k === i ? { ...x, ...f } : x)));
  return (
    <form
      className={cx(styles.form, inCard && styles.formInCard)}
      data-brand-form={brandId ?? "new"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Name")}</span>
        <TextInput label={t("Brand name")} value={name} placeholder="Partner Agro" autoFocus={!brandId} onChange={setName} data-field="name" />
      </div>
      <Pictures
        label={t("Logos")}
        role="logo"
        brandId={brandId}
        stored={(loaded?.logos ?? []).filter((i) => i.role === "logo")}
        removed={pics.removed}
        staged={pics.staged.filter((s) => s.role === "logo")}
        onStage={pics.stage}
        onUnstage={pics.unstage}
        onRemoveStored={pics.removeStored}
        onProblem={setProblem}
      />
      <div className={styles.field} data-colors="">
        <span className={styles.fieldLabel}>{t("Colours")}</span>
        <div className={styles.list}>
          {colors.map((c, i) => (
            <div key={i} className={styles.listRow}>
              <TextInput label={t("Colour {n} name", { n: i + 1 })} value={c.name} placeholder={t("Name")} onChange={(v) => setColor(i, { name: v })} />
              <Swatch color={c.hex} size={16} shape="round" />
              <TextInput label={t("Colour {n} hex", { n: i + 1 })} className={styles.hex} value={c.hex} placeholder="#1BA37A" maxLength={9} onChange={(v) => setColor(i, { hex: v })} />
              <IconButton icon="16.close" label={t("Remove colour {n}", { n: i + 1 })} onClick={() => setColors((cs) => cs.filter((_, k) => k !== i))} />
            </div>
          ))}
        </div>
        <Button variant="ghost" icon="24.plus.small" onClick={() => setColors((cs) => [...cs, newColor()])}>
          {t("Add colour")}
        </Button>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Fonts (comma separated)")}</span>
        <TextInput label={t("Fonts")} value={fonts} placeholder="Inter, Playfair Display" onChange={setFonts} />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Tone and look")}</span>
        <textarea className={styles.textArea} aria-label={t("Tone and look")} placeholder={t("Calm, honest, close to the farmer")} value={tone} rows={3} onChange={(e) => setTone(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className={styles.field} data-formats="">
        <span className={styles.fieldLabel}>{t("Formats")}</span>
        <div className={styles.list}>
          {formats.map((f, i) => (
            <div key={i} className={styles.listRow}>
              <TextInput label={t("Format {n} name", { n: i + 1 })} value={f.name} placeholder={t("Post")} onChange={(v) => setFormat(i, { name: v })} />
              <TextInput label={t("Format {n} width", { n: i + 1 })} className={styles.num} value={String(f.width || "")} prefix="W" onChange={(v) => setFormat(i, { width: Number(v.replace(/\D/g, "")) || 0 })} />
              <TextInput label={t("Format {n} height", { n: i + 1 })} className={styles.num} value={String(f.height || "")} prefix="H" onChange={(v) => setFormat(i, { height: Number(v.replace(/\D/g, "")) || 0 })} />
              <IconButton icon="16.close" label={t("Remove format {n}", { n: i + 1 })} onClick={() => setFormats((fs) => fs.filter((_, k) => k !== i))} />
            </div>
          ))}
        </div>
        <Button variant="ghost" icon="24.plus.small" onClick={() => setFormats((fs) => [...fs, { id: `format-${fs.length + 1}`, name: "", width: 1080, height: 1080 }])}>
          {t("Add format")}
        </Button>
      </div>
      <Pictures
        label={t("Style pictures")}
        role="style"
        brandId={brandId}
        stored={(loaded?.logos ?? []).filter((i) => i.role === "style")}
        removed={pics.removed}
        staged={pics.staged.filter((s) => s.role === "style")}
        onStage={pics.stage}
        onUnstage={pics.unstage}
        onRemoveStored={pics.removeStored}
        onProblem={setProblem}
      />
      {problem && (
        <div className={styles.problem} role="alert">
          {problem}
        </div>
      )}
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()} data-save="">
          {brandId ? t("Save") : t("Add brand")}
        </Button>
      </div>
    </form>
  );
}

// ── Product ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProductFormProps {
  brandId: string;
  productId?: string;
  prefill?: Partial<ProductSave>;
  onDone(productId: string): void;
  onCancel(): void;
  /** In the chat's form card (its padding, not the panel's) */
  inCard?: boolean;
}

interface LabelRow {
  id?: string;
  text: string;
  tier: LabelTier;
}

const TIERS = [
  { value: "sharp", label: "Sharp" },
  { value: "soft", label: "Soft" },
];

/** The series a brand's products use, A to Z (each once, in the spelling first met). */
export function seriesOf(products: readonly Product[]): string[] {
  const seen = new Map<string, string>();
  for (const p of products) {
    const s = p.series?.trim();
    if (s && !seen.has(foldName(s))) seen.set(foldName(s), s);
  }
  return [...seen.values()].sort((a, b) => foldName(a).localeCompare(foldName(b)));
}

export function ProductForm({ brandId, productId, prefill, onDone, onCancel, inCard }: ProductFormProps) {
  useT();
  const [loaded, setLoaded] = useState<Product | null>(null);
  const [ready, setReady] = useState(!productId);
  const [name, setName] = useState(prefill?.name ?? "");
  const [series, setSeries] = useState(prefill?.series ?? "");
  // The brand's series, offered under the field
  const [knownSeries, setKnownSeries] = useState<string[]>([]);
  const [shape, setShape] = useState(prefill?.shape ?? "");
  const [notes, setNotes] = useState(prefill?.notes ?? "");
  const [labels, setLabels] = useState<LabelRow[]>(prefill?.labels ?? []);
  const [confirmed, setConfirmed] = useState(prefill?.labelsConfirmed ?? false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pics = usePictureEdits();
  useEffect(() => {
    let alive = true;
    brandsRepo().get(brandId).then(
      (b) => alive && setKnownSeries(seriesOf(b?.products ?? [])),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [brandId]);
  useEffect(() => {
    if (!productId) return;
    let alive = true;
    brandsRepo().get(brandId).then(
      (b) => {
        const p = b?.products.find((x) => x.id === productId) ?? null;
        if (!alive) return;
        if (p) {
          setLoaded(p);
          setName(prefill?.name ?? p.name);
          setSeries(prefill?.series ?? p.series ?? "");
          setShape(prefill?.shape ?? p.shape);
          setNotes(prefill?.notes ?? p.notes);
          setLabels(prefill?.labels ?? p.labels);
          setConfirmed(prefill?.labelsConfirmed ?? p.labelsConfirmed);
        }
        setReady(true);
      },
      (e: unknown) => alive && (setProblem(messageOf(e)), setReady(true))
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, productId]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const repo = brandsRepo();
      const rows = labels.filter((l) => l.text.trim());
      const saved = await repo.saveProduct({ ...(productId ? { id: productId } : {}), brandId, name, series: series.trim() || null, shape, notes, labels: rows, labelsConfirmed: confirmed && rows.length > 0 });
      await pics.apply(repo, brandId, saved.id);
      onDone(saved.id);
    } catch (e) {
      setProblem(messageOf(e));
      setBusy(false);
    }
  };

  if (!ready) return null;
  const setLabel = (i: number, l: Partial<LabelRow>) => {
    setLabels((ls) => ls.map((x, k) => (k === i ? { ...x, ...l } : x)));
    setConfirmed(false);
  };
  const of = (role: BrandImageRole) => ({
    brandId,
    stored: (loaded?.images ?? []).filter((i) => i.role === role),
    removed: pics.removed,
    staged: pics.staged.filter((s) => s.role === role),
    onStage: pics.stage,
    onUnstage: pics.unstage,
    onRemoveStored: pics.removeStored,
    onProblem: setProblem,
  });
  return (
    <form
      className={cx(styles.form, inCard && styles.formInCard)}
      data-product-form={productId ?? "new"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Name")}</span>
        <TextInput label={t("Product name")} value={name} placeholder="Liq Humus" autoFocus={!productId} onChange={setName} data-field="name" />
      </div>
      <div className={styles.field} data-series-field="">
        <span className={styles.fieldLabel}>{t("Series")}</span>
        <TextInput label={t("Series")} value={series} placeholder={t("No series")} onChange={setSeries} data-field="series" />
        {knownSeries.length > 0 && (
          <div className={styles.suggestions} role="group" aria-label={t("The brand's series")}>
            {knownSeries.map((s) => (
              <button key={s} type="button" className={styles.suggestion} aria-pressed={s === series.trim()} onClick={() => setSeries(s)} data-series-suggestion={s}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      <Pictures label={t("Product photos")} role="packshot" {...of("packshot")} />
      <Pictures label={t("Label close-ups")} role="label" {...of("label")} />
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Shape")}</span>
        <textarea className={styles.textArea} aria-label={t("Shape")} placeholder={t("20 L white translucent jerrycan, handle top left, blue hexagon seal on the cap")} value={shape} rows={3} onChange={(e) => setShape(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className={styles.field} data-labels="">
        <span className={styles.fieldLabel}>{t("Label texts")}</span>
        <div className={styles.list}>
          {labels.map((l, i) => (
            <div key={l.id ?? `n${i}`} className={styles.listRow}>
              <TextInput label={t("Label text {n}", { n: i + 1 })} value={l.text} placeholder={t("Exactly as printed")} onChange={(v) => setLabel(i, { text: v })} />
              <Select label={t("Label text {n} tier", { n: i + 1 })} className={styles.tier} value={l.tier} options={TIERS.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => setLabel(i, { tier: v as LabelTier })} />
              <IconButton
                icon="16.close"
                label={t("Remove label text {n}", { n: i + 1 })}
               
                onClick={() => {
                  setLabels((ls) => ls.filter((_, k) => k !== i));
                  setConfirmed(false);
                }}
              />
            </div>
          ))}
        </div>
        <Button variant="ghost" icon="24.plus.small" onClick={() => setLabels((ls) => [...ls, { text: "", tier: "sharp" }])}>
          {t("Add text")}
        </Button>
        <span className={styles.muted}>{t("Sharp texts are written exactly in pictures. Soft ones (small print) are left illegible.")}</span>
        <Checkbox label={t("These texts are checked")} checked={confirmed && labels.some((l) => l.text.trim())} onChange={setConfirmed} disabled={!labels.some((l) => l.text.trim())} />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("Notes")}</span>
        <textarea className={styles.textArea} aria-label={t("Notes")} value={notes} rows={2} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      {problem && (
        <div className={styles.problem} role="alert">
          {problem}
        </div>
      )}
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()} data-save="">
          {productId ? t("Save") : t("Add product")}
        </Button>
      </div>
    </form>
  );
}
