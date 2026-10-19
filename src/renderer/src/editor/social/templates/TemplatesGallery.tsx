/**
 * The Templates gallery (docs/social.md §4.3), the Posts tab's Templates section: this file's templates and every
 * enabled library's (their manifests' `social`, no payloads fetched), filtered by platform, format, Static / Animated
 * and the board's brand (a library template fits a brand when the brand's library file is the one it comes from or
 * is enabled here). A click inserts the template as a post — the variant for the picked format (default: its first),
 * bound to the board's brand, a product's packshot in the picture slot when the Post section has one picked — and a
 * drag inserts it where it is let go (templates.ts `insertTemplate`, one undo step), the post's outline at the canvas's
 * zoom showing where while it is over the canvas. Empty: Make starter templates… sends the manager its starter brief
 * (SocialMode.tsx `makeStarterTemplates`).
 */
import { useMemo, useState } from "react";
import { EmptyState, Icon, Select, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { PLATFORMS, PLATFORM_NAMES, formatById, formatsFor } from "@shared/social/formats";
import type { Platform } from "@shared/social/types";
import type { Brand, SocialFormat } from "@shared/studio/types";
import { useEditor, type EditorController } from "../../controller";
import { useLibraries, useUI } from "../../hooks";
import { applySelection } from "../../agents/mcpTools";
import { NodeThumb, RemoteThumb } from "../../panels/libraries/Thumbs";
import { toPage } from "../../placeImages";
import { useBrands } from "../../studio/forms";
import { canWritePosts, editorWriter } from "../actions";
import { boardBrand } from "../NewPostMenu";
import { makeStarterTemplates, selectedPosts } from "../SocialMode";
import { readPost } from "../posts";
import { useSocialBoard } from "../socialState";
import { filterTemplates, insertTemplate, localTemplates, libraryTemplates, type TemplateEntry } from "./templates";
import styles from "./Templates.module.css";

const ALL = "all";

/** Every template this file can use, re-read when the document or its libraries change. */
export function useTemplates(): TemplateEntry[] {
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const libs = useLibraries();
  return useMemo(() => {
    void board;
    const local = localTemplates(ed);
    const lib = libs.on ? libraryTemplates(libs, ed.libraries.copies()) : [];
    return [...local, ...lib.filter((l) => !local.some((x) => x.key === l.key))];
  }, [ed, board, libs]);
}

/** The libraries a brand's templates may come from: its own library file and what this file has enabled. */
const brandLibraries = (brand: Brand | null, enabled: readonly string[]): Set<string> | null => (brand ? new Set([...(brand.libraryFileKey ? [brand.libraryFileKey] : []), ...enabled]) : null);

/** Where a dragged template would land: the post's box at the camera's zoom (window px) and its format, "Instagram post · 1080 × 1350". */
export interface DropPreview {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

/**
 * The drop preview over the canvas (round 18 leftovers): the post's outline centred on the pointer at the canvas's
 * zoom, where the drop puts it; null off the canvas (the dragged card shows instead).
 */
export function dropPreview(ed: EditorController, format: SocialFormat | null, x: number, y: number): DropPreview | null {
  const r = ed.canvas?.getBoundingClientRect();
  if (!format || !r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const zoom = ed.engine.getCamera().zoom;
  const width = format.width * zoom;
  const height = format.height * zoom;
  return { left: x - width / 2, top: y - height / 2, width, height, label: `${t(format.name)} · ${format.width} × ${format.height}` };
}

/** Inserts a template as a post (at a canvas point when dropped), selects it and zooms to it. */
export async function placeTemplate(ed: EditorController, entry: TemplateEntry, opts: { brand: Brand | null; formatId: string | null; at?: { x: number; y: number } }): Promise<Guid | null> {
  if (!canWritePosts(ed)) return null;
  // The product picked in the Post section: the selected post's, when it is the brand's.
  const picked = selectedPosts(ed).map((id) => readPost(ed, id)?.productIds[0]).find((p) => !!p) ?? null;
  const productId = picked && opts.brand?.products.some((p) => p.id === picked) ? picked : null;
  try {
    const id = await insertTemplate(ed, editorWriter(ed), { key: entry.key, formatId: opts.formatId, brandId: opts.brand?.id ?? null, productId, at: opts.at });
    applySelection(ed, [id], true);
    ed.focusCanvas();
    return id;
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
    return null;
  }
}

export function TemplatesGallery() {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const libs = useLibraries();
  const all = useTemplates();
  useUI((s) => s.socialBrandId);
  const brand = boardBrand(ed, brands);
  const [platform, setPlatform] = useState<string>(ALL);
  const [format, setFormat] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const shown = filterTemplates(all, { platform: platform === ALL ? null : (platform as Platform), formatId: format === ALL ? null : format, animated: kind === ALL ? null : kind === "animated", brandLibraries: brandLibraries(brand, libs.enabled) });
  const [drag, setDrag] = useState<{ name: string; x: number; y: number; drop: DropPreview | null } | null>(null);
  const formatId = format === ALL ? null : format;

  const onPointerDown = (e: React.PointerEvent, entry: TemplateEntry) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    // The format the post is made in: the filter's, else the template's first.
    const f = formatById(formatId ?? Object.values(entry.data.formats)[0] ?? "");
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      setDrag({ name: entry.name, x: ev.clientX, y: ev.clientY, drop: dropPreview(ed, f, ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!dragging) return void placeTemplate(ed, entry, { brand, formatId });
      const r = ed.canvas?.getBoundingClientRect();
      if (!r || ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      // The post centred where it is let go.
      const p = toPage(ed, ev.clientX - r.left, ev.clientY - r.top);
      void placeTemplate(ed, entry, { brand, formatId, at: { x: Math.round(p.x - (f?.width ?? 0) / 2), y: Math.round(p.y - (f?.height ?? 0) / 2) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!all.length)
    return (
      <EmptyState
        icon="24.component"
        title={t("No templates yet")}
        body={t("Save a post as a template, enable a library with templates, or ask the agent for starter templates.")}
        action={{ label: t("Make starter templates…"), onClick: () => void makeStarterTemplates(ed) }}
      />
    );
  return (
    <div className={styles.gallery} data-templates-gallery="">
      <div className={styles.filters}>
        <Select
          label={t("Platform")}
          value={platform}
          options={[{ value: ALL, label: t("All platforms") }, "-", ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAMES[p] }))]}
          onChange={(v) => {
            setPlatform(v);
            setFormat(ALL);
          }}
          data-templates-filter="platform"
        />
        <Select
          label={t("Format")}
          value={format}
          disabled={platform === ALL}
          options={[{ value: ALL, label: t("All formats") }, "-", ...(platform === ALL ? [] : formatsFor(platform as Platform)).map((f) => ({ value: f.id, label: t(f.name), hint: `${f.width} × ${f.height}` }))]}
          onChange={setFormat}
          data-templates-filter="format"
        />
        <Select
          label={t("Kind")}
          value={kind}
          options={[{ value: ALL, label: t("Static and animated") }, { value: "static", label: t("Static") }, { value: "animated", label: t("Animated") }]}
          onChange={setKind}
          data-templates-filter="kind"
        />
      </div>
      {shown.length ? (
        <div className={styles.grid} role="list" aria-label={t("Templates")}>
          {shown.map((entry) => (
            <button key={`${entry.library ?? ""}/${entry.key}`} type="button" role="listitem" className={styles.card} disabled={!canWritePosts(ed)} onPointerDown={(e) => onPointerDown(e, entry)} onKeyDown={(e) => e.key === "Enter" && void placeTemplate(ed, entry, { brand, formatId })} data-template={entry.key}>
              {entry.node ? <NodeThumb node={entry.node} kind="COMPONENT_SET" size={96} className={styles.thumb} /> : entry.asset ? <RemoteThumb asset={entry.asset} size={96} className={styles.thumb} /> : null}
              <span className={styles.name}>
                {entry.data.animated && <Icon name="16.play" className={styles.animated} />}
                {entry.name}
              </span>
              <span className={styles.source}>{entry.library ? (entry.libraryName ?? t("Library")) : t("This file")}</span>
              <span className={styles.source}>{tp(Object.keys(entry.data.formats).length, "{n} format", "{n} formats")}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.note}>{t("No template matches these filters.")}</p>
      )}
      {drag?.drop ? (
        <div className={styles.drop} style={{ left: drag.drop.left, top: drag.drop.top, width: drag.drop.width, height: drag.drop.height }} aria-hidden data-template-drop="">
          <span className={styles.dropLabel}>{drag.drop.label}</span>
        </div>
      ) : drag ? (
        <div className={styles.ghost} style={{ left: drag.x, top: drag.y }} aria-hidden>
          <Icon name="16.component.set" />
          <span>{drag.name}</span>
        </div>
      ) : null}
      {brand && !brand.libraryFileKey && <p className={styles.note}>{t("{brand} has no brands library yet: Brands › Create brands library.", { brand: brand.name })}</p>}
    </div>
  );
}

/** The Post section's Template choices: the templates with a variant for the post's format (any, when it has none). */
export function templateOptionsFor(list: readonly TemplateEntry[], formatId: string | null): { value: string; label: string }[] {
  return list.filter((e) => !formatId || Object.values(e.data.formats).includes(formatId)).map((e) => ({ value: e.key, label: e.name }));
}
