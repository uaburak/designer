/**
 * Asset thumbnails in the library UI: a local node rendered by the engine (`renderNodeThumbnailPixels`), a remote
 * component's published thumbnail (the manifest's PNG blob), a style's swatch / "Ag" / glyph, a variable's type glyph
 * — each falling back to the asset kind's glyph.
 */
import { useRef } from "react";
import { Icon, Swatch, cx, type IconName } from "@/ds";
import type { Guid, Paint } from "@/engine/codec";
import type { LibraryAsset } from "../../../../../shared/store/types";
import { useEditor } from "../../controller";
import { useAssetThumbnail } from "../../assetThumbs";
import { colorToHex, toPercent } from "../../model/color";
import styles from "./Libraries.module.css";

export function kindGlyph(kind: LibraryAsset["kind"], extra?: { styleType?: string; resolvedType?: string }): IconName {
  switch (kind) {
    case "COMPONENT":
      return "16.component";
    case "COMPONENT_SET":
      return "16.component.set";
    case "VARIABLE_COLLECTION":
      return "16.variable";
    case "VARIABLE":
      return extra?.resolvedType === "COLOR" ? "16.variable.color" : extra?.resolvedType === "BOOLEAN" ? "16.variable.boolean" : extra?.resolvedType === "STRING" ? "16.text" : "16.number";
    case "STYLE":
      return extra?.styleType === "TEXT" ? "16.text" : extra?.styleType === "EFFECT" ? "16.design" : extra?.styleType === "GRID" ? "16.frame" : "16.variable.color";
  }
}

const isComponentKind = (kind: LibraryAsset["kind"]) => kind === "COMPONENT" || kind === "COMPONENT_SET";

/** A local node's thumbnail (the engine draws it); its glyph until then. */
export function NodeThumb({ node, kind, size = 40, className }: { node: Guid; kind: LibraryAsset["kind"]; size?: number; className?: string }) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = isComponentKind(kind) && !!ed.thumbnails?.available;
  // From the thumbnail cache, once on screen (assetThumbs.ts): a long publish list or library list doesn't render them all at once.
  useAssetThumbnail(ed, ref, drawn ? node : null, size * Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const n = isComponentKind(kind) ? null : (ed.engine.readNode(node) as { styleType?: string; fillPaints?: Paint[]; variableResolvedType?: string } | null);
  return (
    <span className={cx(styles.thumb, className)} style={{ width: size, height: size }}>
      {drawn && <canvas ref={ref} className={styles.thumbCanvas} />}
      {n?.styleType === "FILL" && n.fillPaints?.[0]?.color ? (
        <Swatch color={colorToHex(n.fillPaints[0].color)} opacity={toPercent(n.fillPaints[0].opacity ?? 1)} shape="round" size={16} />
      ) : n?.styleType === "TEXT" ? (
        <span className={styles.ag}>Ag</span>
      ) : (
        <Icon name={kindGlyph(kind, { styleType: n?.styleType, resolvedType: n?.variableResolvedType })} className={cx(styles.thumbGlyph, isComponentKind(kind) && styles.componentGlyph)} />
      )}
    </span>
  );
}

/** A published asset's thumbnail (its PNG in the store's blobs), or its glyph. */
export function RemoteThumb({ asset, size = 40, className }: { asset: Pick<LibraryAsset, "kind" | "thumbnail" | "styleType" | "resolvedType">; size?: number; className?: string }) {
  const ed = useEditor();
  const url = asset.thumbnail ? (ed.source.libraries?.blobUrl(asset.thumbnail.sha1) ?? "") : "";
  return (
    <span className={cx(styles.thumb, className)} style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" className={styles.thumbImage} draggable={false} loading="lazy" decoding="async" /> : <Icon name={kindGlyph(asset.kind, asset)} className={cx(styles.thumbGlyph, isComponentKind(asset.kind) && styles.componentGlyph)} />}
    </span>
  );
}
